// profiles.mjs — Chrome profile discovery + deterministic hashed ports for the
// kimi-webbridge multi-profile layer. Pure Node built-ins (runs under node OR bun).
//
// One Chrome profile == one kimi-webbridge daemon == one fixed port.
// The port is derived by hashing the profile's *directory* name (the stable id
// Chrome never changes), so a given profile always lands on the same port.
//
// Reserved: 10086 is the router/default-daemon port — never assigned to a profile.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Our kimi-webbridge extension id (web-store build, present in profiles that have it).
export const KIMI_EXT_ID = "fldmhceldgbpfpkbgopacenieobmligc";
// A second id observed in the wild (alternate/unpacked build) — treat either as "installed".
export const KIMI_EXT_ID_ALT = "hinhmbbmelmmgiehkfmmkmfndadahmkk";

export const ROUTER_PORT = 10086; // reserved
const PORT_BASE = 10100;
const PORT_SPAN = 4900; // assignable range 10100..14999

// macOS Chrome user-data dir. (Override with KWB_CHROME_DIR for Chrome Beta/other.)
export function chromeUserDataDir() {
  if (process.env.KWB_CHROME_DIR) return process.env.KWB_CHROME_DIR;
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

// FNV-1a 32-bit — small, dependency-free, well-distributed for short strings.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Pure hash → base port for one profile directory (independent of other profiles).
export function basePortForDir(dir) {
  return PORT_BASE + (fnv1a32(dir) % PORT_SPAN);
}

// Read Chrome's Local State and return the raw profile list.
export function readLocalState() {
  const lsPath = path.join(chromeUserDataDir(), "Local State");
  const j = JSON.parse(fs.readFileSync(lsPath, "utf8"));
  const cache = j.profile?.info_cache ?? {};
  const lastUsed = j.profile?.last_used ?? null;
  const rows = Object.entries(cache).map(([dir, v]) => ({
    dir,
    name: v.name ?? dir,
    gaiaId: v.gaia_id || null,
    email: v.user_name || null,
    isDefaultName: !!v.is_using_default_name,
  }));
  return { rows, lastUsed };
}

// Whether the kimi-webbridge extension is installed in a profile (on disk).
export function hasKimiExtension(dir) {
  const extDir = path.join(chromeUserDataDir(), dir, "Extensions");
  for (const id of [KIMI_EXT_ID, KIMI_EXT_ID_ALT]) {
    try {
      if (fs.existsSync(path.join(extDir, id))) return true;
    } catch {}
  }
  return false;
}

// Full profile list with deterministic, collision-free ports.
// Collisions (two dirs hashing to the same base port) are resolved by a stable
// linear probe in sorted-dir order, so the mapping is reproducible for a fixed
// set of profiles.
export function listProfiles() {
  const { rows, lastUsed } = readLocalState();
  const sorted = [...rows].sort((a, b) => a.dir.localeCompare(b.dir));
  const taken = new Set([ROUTER_PORT]);
  const portByDir = new Map();
  for (const p of sorted) {
    let port = basePortForDir(p.dir);
    while (taken.has(port)) port = PORT_BASE + ((port - PORT_BASE + 1) % PORT_SPAN);
    taken.add(port);
    portByDir.set(p.dir, port);
  }
  return rows.map((p) => ({
    ...p,
    port: portByDir.get(p.dir),
    wsUrl: `ws://127.0.0.1:${portByDir.get(p.dir)}/ws`,
    hasExtension: hasKimiExtension(p.dir),
    isLastUsed: p.dir === lastUsed,
  }));
}

// Resolve a free-text query to a single profile. Matches (in priority order):
// exact dir, exact email, exact gaia, exact name (case-insensitive), then a
// unique substring match against name/email/dir. Returns the profile or throws
// a descriptive error listing candidates on ambiguity / no match.
export function resolveProfile(query) {
  if (!query) throw new Error("resolveProfile: query is required");
  const profiles = listProfiles();
  const q = String(query).trim();
  const ql = q.toLowerCase();

  const exact =
    profiles.find((p) => p.dir === q) ||
    profiles.find((p) => p.email && p.email.toLowerCase() === ql) ||
    profiles.find((p) => p.gaiaId === q) ||
    profiles.find((p) => p.name.toLowerCase() === ql);
  if (exact) return exact;

  const subs = profiles.filter(
    (p) =>
      p.name.toLowerCase().includes(ql) ||
      (p.email && p.email.toLowerCase().includes(ql)) ||
      p.dir.toLowerCase().includes(ql),
  );
  if (subs.length === 1) return subs[0];
  if (subs.length > 1) {
    const opts = subs.map((p) => `${p.dir} = "${p.name}" <${p.email ?? "?"}>`).join("; ");
    throw new Error(`resolveProfile: "${q}" is ambiguous. Candidates: ${opts}`);
  }
  const all = profiles.map((p) => `${p.dir}="${p.name}"`).join(", ");
  throw new Error(`resolveProfile: no profile matches "${q}". Known: ${all}`);
}

// CLI: `node profiles.mjs [query]` — list all, or resolve one.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg) {
    console.log(JSON.stringify(resolveProfile(arg), null, 2));
  } else {
    const list = listProfiles();
    console.log(JSON.stringify(list, null, 2));
  }
}
