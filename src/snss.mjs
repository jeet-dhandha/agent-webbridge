// snss.mjs — read a Chrome profile's *normal* open tabs straight from disk.
//
// The kimi-webbridge bridge only exposes session-scoped tabs (its `list_tabs`
// returns just the tabs the daemon opened). To answer "what tabs does the user
// have open in profile X" we parse Chrome's own session journal (SNSS format)
// under <profile>/Sessions/Session_*. No bridge, no running Chrome required.
//
// SNSS on-disk layout:
//   header: "SNSS" (4 bytes) + int32 version (LE)
//   commands: repeated [uint16 size LE][uint8 id][size-1 bytes content]
//   content for a command is a Pickle: [uint32 payloadSize][payload...]
//
// We decode kCommandUpdateTabNavigation (6) for {tabId, navIndex, url, title},
// keep the highest navIndex per tab, and drop tabs killed by kCommandTabClosed
// (16). Pickle reads are 4-byte aligned.

import fs from "node:fs";
import path from "node:path";
import { chromeUserDataDir, resolveProfile } from "./profiles.mjs";

const CMD_UPDATE_TAB_NAVIGATION = 6;
const CMD_TAB_CLOSED = 16;
const CMD_SET_SELECTED_TAB_IN_INDEX = 8;

// Minimal aligned Pickle reader over a Buffer.
class PickleReader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }
  _align() {
    this.off = (this.off + 3) & ~3;
  }
  remaining() {
    return this.buf.length - this.off;
  }
  readInt32() {
    if (this.off + 4 > this.buf.length) throw new Error("pickle: int32 OOB");
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  readUInt32() {
    if (this.off + 4 > this.buf.length) throw new Error("pickle: uint32 OOB");
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  readString() {
    const len = this.readInt32();
    if (len < 0 || this.off + len > this.buf.length) throw new Error("pickle: string OOB");
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    this._align();
    return s;
  }
  readString16() {
    const lenChars = this.readInt32();
    const bytes = lenChars * 2;
    if (lenChars < 0 || this.off + bytes > this.buf.length) throw new Error("pickle: str16 OOB");
    const s = this.buf.toString("utf16le", this.off, this.off + bytes);
    this.off += bytes;
    this._align();
    return s;
  }
}

// Pick the most recent Session_* file for a profile directory.
export function latestSessionFile(profileDir) {
  const dir = path.join(chromeUserDataDir(), profileDir, "Sessions");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const sessions = entries
    .filter((f) => f.startsWith("Session_"))
    .map((f) => ({ f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return sessions[0]?.full ?? null;
}

// Iterate SNSS commands → [{id, content:Buffer}].
function* iterCommands(buf) {
  if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "SNSS") {
    throw new Error("not an SNSS file (bad magic)");
  }
  let off = 8; // skip magic + version
  while (off + 2 <= buf.length) {
    const size = buf.readUInt16LE(off);
    off += 2;
    if (size === 0) break;
    if (off + size > buf.length) break; // truncated trailing command
    const id = buf.readUInt8(off);
    const content = buf.subarray(off + 1, off + size);
    off += size;
    yield { id, content };
  }
}

// Parse one UpdateTabNavigation command content → {tabId, navIndex, url, title}.
function parseUpdateTabNavigation(content) {
  // content = pickle: [uint32 payloadSize][payload]
  if (content.length < 4) return null;
  const payloadSize = content.readUInt32LE(0);
  const payload = content.subarray(4, 4 + payloadSize);
  const r = new PickleReader(payload);
  const tabId = r.readInt32();
  const navIndex = r.readInt32();
  const url = r.readString();
  let title = "";
  try {
    title = r.readString16();
  } catch {
    /* title is best-effort */
  }
  return { tabId, navIndex, url, title };
}

// List a profile's open tabs from its on-disk session.
// `query` is anything resolveProfile accepts (name/email/dir), or pass {dir}.
export function listOpenTabs(query, options = {}) {
  const profile = typeof query === "object" && query.dir ? query : resolveProfile(query);
  const file = latestSessionFile(profile.dir);
  if (!file) return { profile, file: null, tabs: [] };

  const buf = fs.readFileSync(file);
  const byTab = new Map(); // tabId -> {navIndex, url, title}
  const closed = new Set();
  let selectedTab = null;

  for (const { id, content } of iterCommands(buf)) {
    try {
      if (id === CMD_UPDATE_TAB_NAVIGATION) {
        const nav = parseUpdateTabNavigation(content);
        if (!nav) continue;
        const prev = byTab.get(nav.tabId);
        if (!prev || nav.navIndex >= prev.navIndex) byTab.set(nav.tabId, nav);
      } else if (id === CMD_TAB_CLOSED) {
        const p = content.length >= 8 ? content.readInt32LE(4) : null; // [pickleSize][tabId]
        if (p != null) closed.add(p);
      } else if (id === CMD_SET_SELECTED_TAB_IN_INDEX) {
        // best-effort: not mapped to tabId reliably; left for future refinement
      }
    } catch {
      // tolerate individual malformed commands; keep scanning
    }
  }

  const tabs = [];
  for (const [tabId, nav] of byTab) {
    if (closed.has(tabId)) continue;
    if (!options.includeBlanks) {
      if (!nav.url || nav.url === "about:blank" || nav.url.startsWith("chrome://newtab")) continue;
    }
    tabs.push({ tabId, url: nav.url, title: nav.title || "" });
  }
  tabs.sort((a, b) => a.tabId - b.tabId);
  return { profile: { dir: profile.dir, name: profile.name, port: profile.port }, file, tabs, selectedTab };
}

// CLI: `node snss.mjs <profile-query>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv[2];
  if (!q) {
    console.error("usage: node snss.mjs <profile name | email | dir>");
    process.exit(1);
  }
  const res = listOpenTabs(q);
  console.log(`profile: ${res.profile.name} (${res.profile.dir}) port ${res.profile.port}`);
  console.log(`session: ${res.file}`);
  console.log(`open tabs: ${res.tabs.length}`);
  for (const t of res.tabs.slice(0, 40)) {
    console.log(`  [${t.tabId}] ${t.title.slice(0, 60)} — ${t.url.slice(0, 90)}`);
  }
}
