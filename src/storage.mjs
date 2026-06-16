// storage.mjs — read/write the agent-webbridge extension's chrome.storage.local
// `local_url` on disk, so we can point a profile's extension at its daemon WITHOUT
// the popup click and WITHOUT CDP (which branded Chrome blocks on the default
// user-data-dir). The store is a LevelDB at:
//   <ChromeUserDataDir>/<ProfileDir>/Local Extension Settings/<extId>/
// key "local_url", value the JSON string e.g. "ws://127.0.0.1:10086/ws".
// storage.local is NOT integrity-protected (unlike Secure Preferences), so editing
// it on disk is safe. Chrome replays the write-ahead log on next launch and the
// extension's reconnectIfNeeded() connects to the new URL.
//
// ⚠️ Chrome must be CLOSED when WRITING (LevelDB is single-writer; that profile's
// store must not be open). Reading is lock-free. macOS + Google Chrome only.
//
// Pure Node, no deps. LevelDB refs: log_format.h, log_writer.cc, write_batch.cc,
// version_edit.cc. Proven end-to-end (see docs / the agent-webbridge README).

import fs from "node:fs";
import path from "node:path";
import { chromeUserDataDir, AWB_EXT_IDS, awbExtId } from "./profiles.mjs";

const BLOCK = 32768;
const HEADER = 7;
const FULL = 1, FIRST = 2, MIDDLE = 3, LAST = 4;
const TYPE_VALUE = 1, TYPE_DELETE = 0;
// VersionEdit tags
const TAG_COMPARATOR = 1, TAG_LOG_NUMBER = 2, TAG_NEXT_FILE = 7, TAG_LAST_SEQ = 4;
const COMPARATOR = "leveldb.BytewiseComparator";

// ---- CRC32C (Castagnoli), reflected, LevelDB-masked ----
const CRC_TABLE = (() => {
  const poly = 0x82f63b78;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
const MASK_DELTA = 0xa282ead8;
const mask = (c) => ((((c >>> 15) | (c << 17)) >>> 0) + MASK_DELTA) >>> 0;

// ---- varints ----
function readVarint32(buf, off) {
  let result = 0, shift = 0, p = off;
  for (; shift < 35; shift += 7) {
    const b = buf[p++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  return { value: result >>> 0, next: p };
}
function writeVarint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return Buffer.from(out);
}
const lenPrefixed = (str) => {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarint(b.length), b]);
};

// ---- log records ----
function readLogRecords(filePath) {
  const data = fs.readFileSync(filePath);
  const records = [];
  let frag = null;
  for (let blockStart = 0; blockStart < data.length; blockStart += BLOCK) {
    const blockEnd = Math.min(blockStart + BLOCK, data.length);
    let off = blockStart;
    while (off + HEADER <= blockEnd) {
      const len = data.readUInt16LE(off + 4);
      const type = data[off + 6];
      if (type === 0 && len === 0) break;
      const dataStart = off + HEADER;
      if (dataStart + len > blockEnd) break;
      const checksum = data.readUInt32LE(off);
      const payload = data.subarray(dataStart, dataStart + len);
      const crcOk = mask(crc32c(Buffer.concat([Buffer.from([type]), payload]))) === checksum;
      if (type === FULL) records.push({ buf: Buffer.from(payload), crcOk });
      else if (type === FIRST) frag = { parts: [Buffer.from(payload)], crcOk };
      else if (type === MIDDLE && frag) frag.parts.push(Buffer.from(payload));
      else if (type === LAST && frag) { frag.parts.push(Buffer.from(payload)); records.push({ buf: Buffer.concat(frag.parts), crcOk: frag.crcOk && crcOk }); frag = null; }
      off = dataStart + len;
    }
  }
  return records;
}

function parseBatch(buf) {
  const seq = Number(buf.readBigUInt64LE(0));
  const count = buf.readUInt32LE(8);
  let p = 12;
  const ops = [];
  for (let i = 0; i < count && p < buf.length; i++) {
    const t = buf[p++];
    const k = readVarint32(buf, p); p = k.next;
    const key = buf.subarray(p, p + k.value).toString("utf8"); p += k.value;
    let value = null;
    if (t === TYPE_VALUE) { const v = readVarint32(buf, p); p = v.next; value = buf.subarray(p, p + v.value).toString("utf8"); p += v.value; }
    ops.push({ type: t === TYPE_VALUE ? "put" : "del", key, value });
  }
  return { seq, count, ops };
}

function inspectLog(logPath) {
  const recs = readLogRecords(logPath);
  let hiSeq = 0;
  const snapshot = new Map();
  for (const r of recs) {
    const pb = parseBatch(r.buf);
    hiSeq = Math.max(hiSeq, pb.seq, pb.seq + pb.count - 1);
    for (const op of pb.ops) { if (op.type === "put") snapshot.set(op.key, op.value); else snapshot.delete(op.key); }
  }
  return { records: recs, nextSeq: hiSeq + 1, snapshot, allCrcOk: recs.every((r) => r.crcOk) };
}

function encodeBatch(seq, ops) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(ops.length, 8);
  const parts = [head];
  for (const op of ops) {
    parts.push(Buffer.from([op.type === "put" ? TYPE_VALUE : TYPE_DELETE]));
    parts.push(lenPrefixed(op.key));
    if (op.type === "put") parts.push(lenPrefixed(op.value));
  }
  return Buffer.concat(parts);
}

// frame a logical record into physical log bytes, respecting 32KB blocks.
function frameRecord(payload, fileLen) {
  const out = [];
  let offsetInBlock = fileLen % BLOCK;
  let p = 0, isFirst = true;
  while (true) {
    let leftover = BLOCK - offsetInBlock;
    if (leftover < HEADER) { out.push(Buffer.alloc(leftover, 0)); offsetInBlock = 0; leftover = BLOCK; }
    const avail = leftover - HEADER;
    const remaining = payload.length - p;
    const fragLen = Math.min(avail, remaining);
    const isLast = fragLen === remaining;
    const type = isFirst && isLast ? FULL : isFirst ? FIRST : isLast ? LAST : MIDDLE;
    const frag = payload.subarray(p, p + fragLen);
    const header = Buffer.alloc(HEADER);
    header.writeUInt16LE(fragLen, 4);
    header[6] = type;
    header.writeUInt32LE(mask(crc32c(Buffer.concat([Buffer.from([type]), frag]))), 0);
    out.push(header, Buffer.from(frag));
    p += fragLen;
    offsetInBlock += HEADER + fragLen;
    isFirst = false;
    if (p >= payload.length) break;
  }
  return Buffer.concat(out);
}

// ---- locating the store ----

// The extension's storage.local store dir for a profile, or null if none exists.
export function extStoreDir(profileDir) {
  const base = path.join(chromeUserDataDir(), profileDir, "Local Extension Settings");
  // The real (possibly dev-assigned) id first, then the known ids as a fallback.
  const resolved = awbExtId(profileDir);
  const candidates = [resolved, ...AWB_EXT_IDS].filter((id, i, a) => id && a.indexOf(id) === i);
  for (const id of candidates) {
    const d = path.join(base, id);
    if (fs.existsSync(path.join(d, "CURRENT"))) return d;
  }
  return null;
}

function activeLogPath(storeDir) {
  const logs = fs.readdirSync(storeDir).filter((f) => /^\d+\.log$/.test(f));
  if (!logs.length) return null;
  // highest-numbered .log is the current one
  logs.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return path.join(storeDir, logs[logs.length - 1]);
}

// ---- public read/write ----

// Current local_url for a profile (decoded string), or null if unset/no store.
export function readLocalUrl(profileDir) {
  const storeDir = extStoreDir(profileDir);
  if (!storeDir) return null;
  const logPath = activeLogPath(storeDir);
  if (!logPath) return null;
  const raw = inspectLog(logPath).snapshot.get("local_url");
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Append a local_url put to an existing store's active log. Chrome must be CLOSED.
function appendLocalUrl(storeDir, wsUrl) {
  const logPath = activeLogPath(storeDir);
  if (!logPath) throw new Error(`no active .log in ${storeDir}`);
  const { nextSeq } = inspectLog(logPath);
  const payload = encodeBatch(nextSeq, [{ type: "put", key: "local_url", value: JSON.stringify(wsUrl) }]);
  const framed = frameRecord(payload, fs.statSync(logPath).size);
  fs.appendFileSync(logPath, framed);
  return { mode: "append", logPath, seq: nextSeq };
}

// Create a fresh LevelDB store holding just local_url, ready for Chrome to recover.
// Used when the profile's extension has never written storage.local (no store dir).
function createFreshStore(storeDir, wsUrl) {
  fs.mkdirSync(storeDir, { recursive: true });
  // MANIFEST-000001: one VersionEdit describing a DB with log 000003 pending recovery.
  const edit = Buffer.concat([
    writeVarint(TAG_COMPARATOR), lenPrefixed(COMPARATOR),
    writeVarint(TAG_LOG_NUMBER), writeVarint(3),
    writeVarint(TAG_NEXT_FILE), writeVarint(4),
    writeVarint(TAG_LAST_SEQ), writeVarint(1),
  ]);
  fs.writeFileSync(path.join(storeDir, "MANIFEST-000001"), frameRecord(edit, 0));
  fs.writeFileSync(path.join(storeDir, "CURRENT"), "MANIFEST-000001\n");
  // 000003.log: the local_url put at seq 1, recovered on open.
  const batch = encodeBatch(1, [{ type: "put", key: "local_url", value: JSON.stringify(wsUrl) }]);
  fs.writeFileSync(path.join(storeDir, "000003.log"), frameRecord(batch, 0));
  return { mode: "create", storeDir };
}

// Point a profile's extension at wsUrl by editing storage.local on disk.
// Chrome MUST be closed. Appends to an existing store, or creates a fresh one if
// the extension has never written storage.local. Throws if the extension is not
// installed in the profile.
export function setLocalUrl(profileDir, wsUrl) {
  let ok = false;
  const base = path.join(chromeUserDataDir(), profileDir, "Local Extension Settings");
  for (const id of AWB_EXT_IDS) {
    const storeDir = path.join(base, id);
    try {
      if (fs.existsSync(path.join(storeDir, "CURRENT"))) {
        appendLocalUrl(storeDir, wsUrl);
      } else {
        createFreshStore(storeDir, wsUrl);
      }
      ok = true;
    } catch (e) {
      // ignore individual failures, try next
    }
  }
  if (!ok) {
    const storeDir = path.join(base, AWB_EXT_IDS[0]);
    return createFreshStore(storeDir, wsUrl);
  }
  return { mode: "multi", profileDir };
}

// CLI (debug): node storage.mjs read <ProfileDir> | inspect <storeDir/log>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "read") console.log(readLocalUrl(arg));
  else if (cmd === "store") console.log(extStoreDir(arg));
  else {
    console.error("usage: node storage.mjs <read <ProfileDir>|store <ProfileDir>>");
    process.exit(1);
  }
}
