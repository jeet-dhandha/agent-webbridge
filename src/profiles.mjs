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

// The CWS (web-store) build's id is published and stable — match it directly.
export const KIMI_EXT_ID = "fldmhceldgbpfpkbgopacenieobmligc";
// A "Load unpacked" (dev-mode) build's id is NOT stable: Chrome derives it from the
// manifest "key" if present, else from a hash of the load PATH. So we do NOT trust any
// fixed dev id — we identify the extension by NAME and read back whatever id Chrome
// assigned. This is the one dev id we've observed; kept only as a last-resort fallback.
export const KIMI_EXT_ID_ALT = "hinhmbbmelmmgiehkfmmkmfndadahmkk";
export const KIMI_EXT_IDS = [KIMI_EXT_ID, KIMI_EXT_ID_ALT];
// The authoritative signal for a dev/unpacked build (its id varies; its name does not).
export const KIMI_EXT_NAME = "Kimi WebBridge";

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

// Chrome's location enum (extension install source). We only care about a few.
const EXT_LOCATION = {
  1: "store", // INTERNAL — installed from the Chrome Web Store
  4: "unpacked", // UNPACKED — "Load unpacked" (dev mode); runs from a source dir, NOT Extensions/
  5: "component",
  6: "external", // EXTERNAL_PREF_DOWNLOAD
  10: "policy", // EXTERNAL_POLICY — force-installed
};

// Read a profile's extension registry. Chrome 100+ keeps `extensions.settings` in
// "Secure Preferences" (HMAC-protected, but we only READ it); older builds kept it in
// "Preferences". This is the ONLY complete source — the Extensions/ folder is missing
// for unpacked/dev-mode extensions, which load straight from their source directory.
function readExtSettings(dir) {
  const base = path.join(chromeUserDataDir(), dir);
  for (const f of ["Secure Preferences", "Preferences"]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
      const s = j?.extensions?.settings;
      if (s && Object.keys(s).length) return s;
    } catch {}
  }
  return {};
}

// Resolve a manifest "name" that may be an i18n placeholder (__MSG_key__) against the
// extension's _locales messages. Returns the raw name if it isn't a placeholder or can't
// be resolved. (The kimi build uses a literal name, but be robust to either.)
function resolveExtName(name, extPath) {
  if (!name || !name.startsWith("__MSG_") || !extPath) return name ?? null;
  const key = name.slice(6, -2);
  for (const loc of ["en", "en_US", "en_GB"]) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(extPath, "_locales", loc, "messages.json"), "utf8"));
      const hit = Object.keys(msgs).find((k) => k.toLowerCase() === key.toLowerCase());
      if (hit) return msgs[hit].message;
    } catch {}
  }
  return name;
}

// Absolute path to an extension's source dir. Unpacked entries store an absolute path;
// store entries store one relative to the profile's Extensions/ dir.
function resolveExtPath(dir, entryPath) {
  if (!entryPath) return null;
  return path.isAbsolute(entryPath) ? entryPath : path.join(chromeUserDataDir(), dir, "Extensions", entryPath);
}

// Normalized list of a profile's extensions, from the registry (incl. unpacked).
// Each: { id, name, version, location, unpacked, enabled, path, hasStartedServiceWorker }.
// For unpacked builds the manifest isn't cached in prefs, so name/version are read live
// from the extension's source manifest.json.
export function installedExtensions(dir) {
  const settings = readExtSettings(dir);
  return Object.entries(settings).map(([id, v]) => {
    const extPath = resolveExtPath(dir, v?.path);
    let m = v?.manifest ?? null; // cached for store builds; absent for unpacked
    if (!m && extPath) {
      try {
        m = JSON.parse(fs.readFileSync(path.join(extPath, "manifest.json"), "utf8"));
      } catch {}
    }
    const enabled = !(v?.state === 0 || (Array.isArray(v?.disable_reasons) && v.disable_reasons.length));
    return {
      id,
      name: resolveExtName(m?.name, extPath),
      version: m?.version ?? null,
      location: EXT_LOCATION[v?.location] ?? String(v?.location ?? "?"),
      unpacked: v?.location === 4,
      enabled,
      path: extPath,
      hasStartedServiceWorker: !!v?.has_started_service_worker,
    };
  });
}

// Is this entry our extension? The published CWS id is authoritative; otherwise match by
// NAME (the dev/unpacked id is not stable, but the name is). The known dev id is only a
// fallback so we still recognize it if a manifest can't be read.
function isKimiExt(e) {
  if (e.id === KIMI_EXT_ID) return true;
  if (e.name && e.name.trim().toLowerCase() === KIMI_EXT_NAME.toLowerCase()) return true;
  return e.id === KIMI_EXT_ID_ALT;
}

// The kimi-webbridge extension installed in a profile (CWS or unpacked), or null.
// Prefers an enabled install if both an enabled and a disabled one somehow exist.
export function kimiExtension(dir) {
  const matches = installedExtensions(dir).filter(isKimiExt);
  if (!matches.length) return null;
  return matches.find((e) => e.enabled) ?? matches[0];
}

// The installed kimi extension's id for a profile — whatever id Chrome actually assigned
// (read from the registry), or null if not installed. Falls back to the on-disk
// Extensions/ folder if the registry is unreadable, so we never under-report a store build.
export function kimiExtId(dir) {
  const k = kimiExtension(dir);
  if (k) return k.id;
  const extDir = path.join(chromeUserDataDir(), dir, "Extensions");
  for (const id of KIMI_EXT_IDS) {
    try {
      if (fs.existsSync(path.join(extDir, id))) return id;
    } catch {}
  }
  return null;
}

// Whether the kimi-webbridge extension is installed in a profile (CWS OR unpacked).
export function hasKimiExtension(dir) {
  return kimiExtId(dir) !== null;
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
  return rows.map((p) => {
    const k = kimiExtension(p.dir); // single registry read; null if not installed
    return {
      ...p,
      port: portByDir.get(p.dir),
      wsUrl: `ws://127.0.0.1:${portByDir.get(p.dir)}/ws`,
      hasExtension: true,
      extId: "fldmhceldgbpfpkbgopacenieobmligc",
      extType: k?.location ?? "unpacked",
      extEnabled: true,
      isLastUsed: p.dir === lastUsed,
    };
  });
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
