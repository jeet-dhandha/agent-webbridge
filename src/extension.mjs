// extension.mjs — detect which Chrome profiles lack the agent-webbridge extension
// and help install it into them.
//
// Chrome design constraint: you CANNOT inject an unpacked extension into an
// already-running Chrome's existing profile from the outside. The honest install
// path on a real profile is therefore a manual "Load unpacked" in
// chrome://extensions (Developer mode on) pointed at agent-webbridge-extension/.
// `awb setup` walks the user/agent through that and polls until it lands.
//
// (--load-extension cold start works only for automated tests on Chrome for
// Testing: it launches one profile with the unpacked extension loaded, and only
// if Chrome is NOT already running. Branded Chrome 137+ ignores the flag.)

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AWB_EXT_ID, AWB_EXT_ID_STORE, AWB_EXT_IDS, listProfiles, awbExtId, awbExtension, chromeUserDataDir } from "./profiles.mjs";

const CWS_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromeBinary() {
  if (process.env.AWB_CHROME_BIN) return process.env.AWB_CHROME_BIN;
  return CHROME_BIN;
}

export function unpackedExtPath() {
  const defaultPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agent-webbridge-extension");
  const p = process.env.AWB_EXT_PATH || defaultPath;
  if (!fs.existsSync(path.join(p, "manifest.json"))) {
    throw new Error(`unpacked extension not found at ${p} (set AWB_EXT_PATH to override)`);
  }
  return p;
}

// The Chrome extension id derived from an MV3 manifest's `key` field (PEM public key).
// Chrome's algorithm: SHA-256 the DER-encoded SubjectPublicKeyInfo, then map the first
// 16 bytes to the alphabet "a".."p" (each byte becomes two chars: high nibble, low nibble).
// The `key` field is optional in a manifest; without it, Chrome falls back to hashing the
// load path, which is non-portable. Our agent-webbridge-extension manifest DOES ship a
// `key`, so the id is stable for THIS exact checkout. If the key ever changes, the id
// changes and prior `local_url` writes go to the wrong store.
export function computeExtIdFromManifestKey(publicKeyPem) {
  if (!publicKeyPem || typeof publicKeyPem !== "string") {
    throw new Error("computeExtIdFromManifestKey: publicKeyPem is required");
  }
  // Build a PEM string if the caller passed a bare base64 blob (manifest.json stores
  // it as a single line, no header).
  const pem = publicKeyPem.includes("-----")
    ? publicKeyPem
    : `-----BEGIN PUBLIC KEY-----\n${publicKeyPem.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;
  const der = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
  const hash = crypto.createHash("sha256").update(der).digest();
  const ALPHA = "abcdefghijklmnop";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += ALPHA[(hash[i] >> 4) & 0xf];
    id += ALPHA[hash[i] & 0xf];
  }
  return id;
}

// Read the dev build's manifest.json, return the id Chrome assigns to it when it's
// "Load unpacked"-ed. Throws if the manifest is missing the `key` field (the dev build
// is supposed to ship one — without it, the id is path-derived and not portable).
export function devBuildExtId() {
  const dir = unpackedExtPath();
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (!m.key) {
    throw new Error(
      `dev build at ${dir} has no "key" in manifest.json — Chrome would derive the id from the load path, which is not portable. Add a "key" field (the public key half of an RSA keypair) to manifest.json and re-run.`,
    );
  }
  return computeExtIdFromManifestKey(m.key);
}

// mtime (ms since epoch) of the dev build's most recently changed source file —
// background.js, manifest.json, popup.html, chunks, assets, locales, icons. Used by
// `awb install-dev` to tell the user "something changed since the last run, click
// Reload in chrome://extensions".
export function devBuildLastModifiedMs() {
  const dir = unpackedExtPath();
  const SKIP = new Set(["node_modules", ".git", ".DS_Store"]);
  let latest = 0;
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > latest) latest = m;
        } catch {}
      }
    }
  }
  walk(dir);
  return latest;
}

export function profilesMissingExtension() {
  return listProfiles().filter((p) => !p.hasExtension);
}

// ---- Path 1: force-install policy (all profiles) ----

export function forceInstallValue() {
  // Must be the Chrome Web Store id — it's the only one Chrome can fetch a CRX for.
  return `${AWB_EXT_ID_STORE};${CWS_UPDATE_URL}`;
}

export function readForcelist() {
  try {
    const out = execFileSync("defaults", ["read", "com.google.Chrome", "ExtensionInstallForcelist"], {
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return null;
  }
}

// Add our extension id to the force-install list (idempotent-ish: writes a
// single-element array; extend here if you need to preserve existing entries).
export function enableForceInstall() {
  const existing = readForcelist();
  if (existing && existing.includes(AWB_EXT_ID_STORE)) {
    return { changed: false, value: existing, note: "already present" };
  }
  execFileSync("defaults", [
    "write",
    "com.google.Chrome",
    "ExtensionInstallForcelist",
    "-array",
    forceInstallValue(),
  ]);
  return {
    changed: true,
    value: readForcelist(),
    note: "Restart Chrome for it to install in all profiles.",
  };
}

export function disableForceInstall() {
  try {
    execFileSync("defaults", ["delete", "com.google.Chrome", "ExtensionInstallForcelist"]);
    return { changed: true };
  } catch {
    return { changed: false, note: "no policy set" };
  }
}

// ---- Extension health + on-disk uninstall (for install-dev's repair path) ----

// Inspect the agent-webbridge extension in a profile and decide whether it's healthy, corrupt, or
// absent. "Corrupt" = Chrome still has a registry entry, but it can't actually work:
//   - it's disabled (state 0 / disable_reasons set), often Chrome's own "corrupted" flag;
//   - it's an UNPACKED build whose source folder no longer exists (stale Load-unpacked);
//   - it's a STORE build whose Extensions/<id> payload folder is missing (half-removed).
// Returns { installed, healthy, corrupt, reason, extId, location, unpacked }.
export function extensionHealth(profileDir) {
  const ext = awbExtension(profileDir); // null, or {id,name,version,location,unpacked,enabled,path}
  if (!ext) {
    // No registry entry. Flag a leftover payload folder as a (mild) corrupt-orphan so the
    // repair path scrubs it before a fresh install.
    let orphan = null;
    for (const id of AWB_EXT_IDS) {
      const p = path.join(chromeUserDataDir(), profileDir, "Extensions", id);
      try { if (fs.existsSync(p)) { orphan = id; break; } } catch {}
    }
    return orphan
      ? { installed: false, healthy: false, corrupt: true, reason: `orphaned payload Extensions/${orphan} with no registry entry`, extId: orphan, location: null, unpacked: false }
      : { installed: false, healthy: false, corrupt: false, reason: "not installed", extId: null, location: null, unpacked: false };
  }

  const base = path.join(chromeUserDataDir(), profileDir);
  const reasons = [];
  if (!ext.enabled) reasons.push("registry entry is disabled (possibly Chrome's corrupted flag)");
  if (ext.unpacked) {
    if (ext.path && !fs.existsSync(ext.path)) reasons.push(`unpacked source path missing: ${ext.path}`);
  } else {
    const payload = path.join(base, "Extensions", ext.id);
    try { if (!fs.existsSync(payload)) reasons.push(`store payload folder missing: Extensions/${ext.id}`); } catch {}
  }

  const corrupt = reasons.length > 0;
  return {
    installed: true,
    healthy: !corrupt,
    corrupt,
    reason: corrupt ? reasons.join("; ") : null,
    extId: ext.id,
    location: ext.location,
    unpacked: ext.unpacked,
  };
}

// Auto-remove the agent-webbridge extension's ON-DISK artifacts for a profile so a fresh install can
// repair it. Chrome MUST be closed (these stores are held open while it runs).
//
// We delete the per-extension folders only — payload, storage.local, rules, scripts,
// per-extension IndexedDB. We deliberately do NOT hand-edit the HMAC-protected Secure
// Preferences registry entry: that's what corrupted the pref store in the past. Chrome's
// startup garbage-collector drops the now-orphaned settings entry on its own, and the
// subsequent "Add to Chrome" / "Load unpacked" re-registers a clean entry. Shared stores
// (Local Storage, the global Extension State leveldb) are never touched.
export function removeExtensionOnDisk(profileDir, extId) {
  if (isChromeRunning()) {
    return { ok: false, error: "Chrome is running — close it first (extension stores are locked while open)", removed: [] };
  }
  const id = extId || awbExtId(profileDir);
  if (!id) return { ok: false, error: "no agent-webbridge extension id to remove", removed: [] };

  const base = path.join(chromeUserDataDir(), profileDir);
  const targets = [
    path.join(base, "Extensions", id),
    path.join(base, "Local Extension Settings", id),
    path.join(base, "Sync Extension Settings", id),
    path.join(base, "Managed Extension Settings", id),
    path.join(base, "Extension Rules", id),
    path.join(base, "Extension Scripts", id),
    path.join(base, "IndexedDB", `chrome-extension_${id}_0.indexeddb.leveldb`),
    path.join(base, "IndexedDB", `chrome-extension_${id}_0.indexeddb.blob`),
  ];

  const removed = [];
  const errors = [];
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) {
        fs.rmSync(t, { recursive: true, force: true });
        removed.push(t.slice(base.length + 1));
      }
    } catch (e) {
      errors.push(`${t.slice(base.length + 1)}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, removed, errors, extId: id };
}

// ---- Path 2: --load-extension cold start (single profile) ----

export function loadExtensionArgs(profileDir) {
  return [
    "-na",
    "Google Chrome",
    "--args",
    `--profile-directory=${profileDir}`,
    `--load-extension=${unpackedExtPath()}`,
  ];
}

export function loadExtensionCommand(profileDir) {
  return `open ${loadExtensionArgs(profileDir).map((a) => (a.includes(" ") ? `'${a}'` : a)).join(" ")}`;
}

// Spawn the cold-start launch for one profile. Returns a warning if Chrome is
// already running (the flag will be ignored by the primary process).
export function launchWithExtension(profileDir) {
  let chromeRunning = false;
  try {
    execFileSync("pgrep", ["-x", "Google Chrome"]);
    chromeRunning = true;
  } catch {}
  const child = spawn("open", loadExtensionArgs(profileDir), { detached: true, stdio: "ignore" });
  child.unref();
  return {
    launched: true,
    chromeRunning,
    warning: chromeRunning
      ? "Chrome was already running — --load-extension is ignored unless Chrome is cold-started. Quit Chrome fully first, or use enableForceInstall()."
      : null,
  };
}

// ---- Opening Chrome profile windows ----
// macOS only. `open -na` opens a new window in the named profile; if Chrome is
// not running at all, it cold-starts. Waking the window is what makes a
// profile's extension connect to its daemon.

export function isChromeRunning() {
  try {
    execFileSync("pgrep", ["-x", "Google Chrome"]);
    return true;
  } catch {
    return false;
  }
}

// Fully quit Chrome so its profile LevelDB stores are unlocked for writing. Tries a
// graceful AppleScript quit first (lets Chrome save the session for restore), then
// force-kills if it doesn't exit in time. Returns { stopped, forced }.
export function quitChrome({ timeoutMs = 8000 } = {}) {
  if (!isChromeRunning()) return { stopped: true, forced: false };
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to quit'], { stdio: "ignore" });
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChromeRunning()) return { stopped: true, forced: false };
    execFileSync("sleep", ["0.3"]);
  }
  try {
    execFileSync("pkill", ["-x", "Google Chrome"], { stdio: "ignore" });
  } catch {}
  execFileSync("sleep", ["1.5"]);
  return { stopped: !isChromeRunning(), forced: true };
}

// Launch Google Chrome HEADFUL for one profile, opening the given URLs as tabs. We invoke
// the binary in /Applications directly (chromeBinary(), overridable via AWB_CHROME_BIN)
// rather than macOS `open -na`, because `open` does NOT reliably forward a
// chrome-extension:// URL as a tab — and the binary path is what we already resolve. When
// Chrome is already running on the default user-data-dir, its singleton forwards this to
// the running instance and opens a window in the named profile. (Proven headful: this is
// the launch that wakes the service worker; see the wakeExtension note below.)
export function launchChrome(profileDir, urls = []) {
  const args = [`--profile-directory=${profileDir}`];
  try {
    const extPath = unpackedExtPath();
    args.push(`--load-extension=${extPath}`);
  } catch (e) {
    // local unpacked extension not found, ignore
  }
  args.push(...urls);

  const child = spawn(chromeBinary(), args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

export function openChromeProfile(profileDir) {
  const wasRunning = isChromeRunning();
  launchChrome(profileDir);
  return { opened: true, profileDir, chromeWasRunning: wasRunning };
}

// ---- One-window-per-profile session: keep all wizard URLs in the same window ----
//
// Why these exist: `launchChrome` is fire-and-forget — each call either cold-starts a new
// Chrome (which opens a phantom default-profile window alongside the named one) or asks
// the singleton for a *new* window in the named profile. That makes the install wizard
// open 2-3 windows for the same profile in quick succession, and worse: a `chrome://` URL
// passed as a launch arg is silently rejected by Chrome, so the URL may never open at all.
//
// The fix: do exactly ONE `launchChrome` per profile (to bring up its window), then for
// every subsequent URL — especially `chrome://` ones — append a tab to that SAME window
// via AppleScript. AppleScript on Chrome supports `chrome://` URLs fine, and `make new
// tab` reuses whichever window we hand it. Result: one Chrome process, one window per
// profile, every URL lands in that window.

// AppleScript helper: return the id of the first window containing a tab whose URL
// matches `urlContains`, or "" if none. Used after a launch to "anchor" the wizard to
// the window the URL just opened in.
export function findWindowForUrl(urlContains) {
  if (!isChromeRunning()) return null;
  try {
    const esc = String(urlContains).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const applescript = `
      tell application "Google Chrome"
        set needle to "${esc}"
        repeat with w in windows
          set tabsList to every tab of w
          repeat with t in tabsList
            try
              if URL of t contains needle then
                return id of w
              end if
            end try
          end repeat
        end repeat
      end tell
      return ""
    `;
    const out = execFileSync("osascript", ["-e", applescript], { encoding: "utf8" });
    const v = out.trim();
    return v && v !== "" ? Number(v) : null;
  } catch {
    return null;
  }
}

// AppleScript helper: add a new tab with `url` to the window identified by `windowId`,
// activating the tab. Works for `chrome://` URLs (which `launchChrome` rejects). Returns
// { ok, windowId, tabIndex } on success, { ok: false, error } on failure.
export function openTabInWindow(windowId, url) {
  if (!isChromeRunning()) return { ok: false, error: "chrome not running" };
  if (!windowId) return { ok: false, error: "no windowId" };
  try {
    const esc = String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const applescript = `
      tell application "Google Chrome"
        set targetWindow to window id ${Number(windowId)}
        set newTab to make new tab at end of tabs of targetWindow
        set URL of newTab to "${esc}"
        set active tab index of targetWindow to (count of tabs of targetWindow)
        return id of targetWindow & "," & (count of tabs of targetWindow)
      end tell
    `;
    const out = execFileSync("osascript", ["-e", applescript], { encoding: "utf8" }).trim();
    const [wid, idx] = out.split(",");
    return { ok: true, windowId: Number(wid), tabIndex: Number(idx) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// High-level: open `url` in the named profile's window, reusing one Chrome process.
//
//   - First call for a profile: cold-start the named profile's window via launchChrome
//     (NO URL as launch arg if the URL is `chrome://` — Chrome silently rejects
//     `chrome://` URLs passed positionally). Then anchor by scanning for either the
//     URL itself (if it was a non-chrome:// URL we passed) or any tab in the named
//     profile's window. Then, if the URL still isn't in the window (e.g. it was a
//     `chrome://` URL we couldn't pass at launch), append it as a new tab via AppleScript.
//   - Subsequent calls: pass the cached `windowId`; the URL is appended as a new tab
//     in that same window via AppleScript. `chrome://` URLs work here (the launch path
//     rejects them, this path does not).
//
// `anchorUrl` is the URL we expect to see in the window after the cold start, when the
// cold start DID pass the URL (the non-chrome:// case). For CWS it's the CWS URL itself.
// We use it to disambiguate the right window when more than one was opened.
//
// Returns { windowId, url, mode: "launched" | "launched+appended" | "appended" }.
export function openUrlInProfile({ profileDir, windowId, url, anchorUrl }) {
  const isChromeUrl = typeof url === "string" && url.startsWith("chrome://");

  if (!windowId) {
    // Cold-start. For non-chrome:// URLs we can pass them as launch args; for chrome://
    // we must NOT (Chrome silently drops them) — bring the window up empty and append
    // the URL as a tab after anchoring.
    if (!isChromeUrl) {
      launchChrome(profileDir, [url]);
    } else {
      launchChrome(profileDir);
    }
    // Anchor: scan for the URL we just asked to open. For chrome://, nothing will match
    // (it was dropped) so we'll fall back to "first window with a non-default URL" via
    // the catch below.
    const anchor = anchorUrl || (isChromeUrl ? null : url);
    const deadline = Date.now() + 5000;
    let found = null;
    while (Date.now() < deadline && !found) {
      if (anchor) found = findWindowForUrl(anchor);
      if (!found) execFileSync("sleep", ["0.25"]);
    }
    if (!found) {
      // Last-resort anchor: any window that has a URL NOT in the default-page set
      // (about:blank, chrome://newtab). This is the named profile's window, which
      // Chrome populated with chrome://newtab on the launch.
      try {
        const applescript = `
          tell application "Google Chrome"
            repeat with w in windows
              set tabsList to every tab of w
              repeat with t in tabsList
                try
                  set u to URL of t
                  if u is not "chrome://newtab/" and u is not "about:blank" and u is not "" then
                    return id of w
                  end if
                end try
              end repeat
            end repeat
            -- fallback: first window
            if (count of windows) > 0 then return id of window 1
          end tell
          return ""
        `;
        const out = execFileSync("osascript", ["-e", applescript], { encoding: "utf8" }).trim();
        if (out && out !== "") found = Number(out);
      } catch {}
    }
    if (isChromeUrl && found) {
      // Now append the chrome:// URL to the anchored window as a new tab.
      const r = openTabInWindow(found, url);
      if (r.ok) return { windowId: r.windowId, url, mode: "launched+appended" };
      return { windowId: found, url, mode: "error", error: r.error };
    }
    return { windowId: found, url, mode: "launched" };
  }
  // Reuse path: append a tab to the same window. Works for chrome:// URLs.
  const r = openTabInWindow(windowId, url);
  if (!r.ok) return { windowId, url, mode: "error", error: r.error };
  return { windowId: r.windowId, url, mode: "appended" };
}



// Wake a profile's DORMANT agent-webbridge service worker so it reads the local_url we wrote and
// connects — the missing half of "zero-click connect".
//
// Why this is needed: the agent-webbridge MV3 service worker reconnects (reads storage.local
// local_url) only when its top-level main() runs, i.e. when the worker STARTS. But the
// extension registers no chrome.runtime.onStartup/onInstalled listener and ships no
// content script (confirmed: its serviceworkerevents are only alarms/debugger/tabs/
// tabGroups), so Chrome does NOT auto-start the worker on launch — it stays asleep and our
// on-disk write is never applied (the gap the live test exposed; a fresh-udd copy worked
// only because copying it counts as an install, which does start the worker).
//
// The fix (proven end-to-end, headful): open the extension's own popup page as a tab. The
// popup's script messages the worker on load (GET_STATUS); delivering that message starts
// the worker → main() → reconnectIfNeeded() → connects to local_url. This is the
// equivalent of the user clicking the toolbar icon, which is in fact the only manual
// reconnect path after a restart. about:blank is opened first (and stays the active,
// driveable tab) so the popup never sits in front of the agent's navigation.
export function wakeExtension(profileDir, extId) {
  const id = extId || awbExtId(profileDir);
  if (!id) throw new Error(`no agent-webbridge extension in profile "${profileDir}"`);
  const popupUrl = `chrome-extension://${id}/popup.html`;
  launchChrome(profileDir, [popupUrl]);
  return { woke: true, profileDir, extId: id, popupUrl };
}

export function cleanupAnnoyingTabs(extId) {
  try {
    const extIdArg = extId || "";
    const applescript = `
      tell application "Google Chrome"
        repeat with w in windows
          set tabsList to every tab of w
          set hasPopup to false
          set popupTab to null
          
          repeat with t in tabsList
            try
              set tUrl to URL of t
              if tUrl contains "popup.html" then
                set hasPopup to true
                set popupTab to t
              end if
            end try
          end repeat
          
          if hasPopup then
            set tabCount to count of tabsList
            if tabCount is 1 then
              set newUrl to "about:blank"
              if "${extIdArg}" is not "" then
                set newUrl to "about:blank#" & "${extIdArg}"
              end if
              tell w to make new tab with properties {URL:newUrl}
              delay 0.1
            end if
            try
              close popupTab
            end try
          end if
        end repeat
      end tell
    `;
    execFileSync("osascript", ["-e", applescript], { stdio: "ignore" });
  } catch (e) {
    // Ignore AppleScript errors silently
  }
}

export function focusProfileWindow(extId) {
  if (!extId) return;
  try {
    const applescript = `
      tell application "Google Chrome"
        repeat with w in windows
          set tabsList to every tab of w
          repeat with t in tabsList
            try
              if URL of t contains "${extId}" then
                set index of w to 1
                activate
                exit repeat
              end if
            end try
          end repeat
        end repeat
      end tell
    `;
    execFileSync("osascript", ["-e", applescript], { stdio: "ignore" });
  } catch (e) {
    // Ignore AppleScript errors silently
  }
}

export function closeBlankWindows() {
  if (!isChromeRunning()) return;
  try {
    const applescript = `
      tell application "Google Chrome"
        set windowsList to every window
        repeat with w in windowsList
          set tabsList to every tab of w
          set shouldClose to true
          repeat with t in tabsList
            try
              set tUrl to URL of t
              if tUrl does not contain "popup.html" and tUrl is not "about:blank" and tUrl is not "" then
                set shouldClose to false
                exit repeat
              end if
            on error
              set shouldClose to false
              exit repeat
            end try
          end repeat
          if shouldClose then
            try
              close w
            end try
          end if
        end repeat
      end tell
    `;
    execFileSync("osascript", ["-e", applescript], { stdio: "ignore" });
  } catch (e) {
    // Ignore AppleScript errors silently
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "missing") {
    const miss = profilesMissingExtension();
    console.log(`${miss.length} profile(s) missing the extension:`);
    for (const p of miss) console.log(`  ${p.dir.padEnd(10)} ${p.name}`);
  } else if (cmd === "enable-forcelist") {
    console.log(JSON.stringify(enableForceInstall(), null, 2));
  } else if (cmd === "disable-forcelist") {
    console.log(JSON.stringify(disableForceInstall(), null, 2));
  } else if (cmd === "status") {
    console.log("forcelist:", readForcelist() ?? "(none)");
    console.log("unpacked ext:", (() => { try { return unpackedExtPath(); } catch (e) { return e.message; } })());
  } else if (cmd === "load" && process.argv[3]) {
    console.log("command:", loadExtensionCommand(process.argv[3]));
  } else {
    console.error("usage: node extension.mjs <missing|status|enable-forcelist|disable-forcelist|load <ProfileDir>>");
    process.exit(1);
  }
}
