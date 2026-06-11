// extension.mjs — detect which Chrome profiles lack the kimi-webbridge extension
// and install it into them.
//
// Chrome design constraint: you CANNOT inject an unpacked extension into an
// already-running Chrome's existing profile from the outside. So there are two
// honest install paths, each with a trigger requirement:
//
//   1. Force-install policy (RECOMMENDED, all profiles at once, persistent).
//      Writes the CWS extension id to Chrome's ExtensionInstallForcelist policy.
//      Chrome then silently installs it in EVERY profile — but only after a
//      Chrome restart. On MDM-managed Macs the managed plist may override this.
//
//   2. --load-extension cold start (single profile, ephemeral).
//      Launches one profile with the unpacked extension loaded. Only takes
//      effect if Chrome is NOT already running (flags apply to the primary
//      process only); otherwise it just opens a window without the extension.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIMI_EXT_ID, KIMI_EXT_ID_ALT, listProfiles, kimiExtId } from "./profiles.mjs";

const CWS_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromeBinary() {
  if (process.env.KWB_CHROME_BIN) return process.env.KWB_CHROME_BIN;
  return CHROME_BIN;
}

export function unpackedExtPath() {
  const defaultPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "kimi-webbridge-extension");
  const p = process.env.KWB_EXT_PATH || defaultPath;
  if (!fs.existsSync(path.join(p, "manifest.json"))) {
    throw new Error(`unpacked extension not found at ${p} (set KWB_EXT_PATH to override)`);
  }
  return p;
}

export function profilesMissingExtension() {
  return listProfiles().filter((p) => !p.hasExtension);
}

// ---- Path 1: force-install policy (all profiles) ----

export function forceInstallValue() {
  return `${KIMI_EXT_ID};${CWS_UPDATE_URL}`;
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
  if (existing && existing.includes(KIMI_EXT_ID)) {
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
// the binary in /Applications directly (chromeBinary(), overridable via KWB_CHROME_BIN)
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

// Wake a profile's DORMANT kimi service worker so it reads the local_url we wrote and
// connects — the missing half of "zero-click connect".
//
// Why this is needed: the kimi MV3 service worker reconnects (reads storage.local
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
  const id = extId || kimiExtId(profileDir);
  if (!id) throw new Error(`no kimi extension in profile "${profileDir}"`);
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

export function isProfileWindowOpen(extId) {
  if (!extId || !isChromeRunning()) return false;
  try {
    const applescript = `
      tell application "Google Chrome"
        repeat with w in windows
          set tabsList to every tab of w
          repeat with t in tabsList
            try
              if URL of t contains "${extId}" then
                return true
              end if
            end try
          end repeat
        end repeat
      end tell
      return false
    `;
    const out = execFileSync("osascript", ["-e", applescript], { encoding: "utf8" });
    return out.trim() === "true";
  } catch {
    return false;
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
