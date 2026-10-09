// platform.mjs — the only place that knows which OS we are on.
//
// macOS, Windows and Linux differ in four ways that matter here: where Chrome keeps its
// profiles, where the binary lives, how to ask "is Chrome running / quit it", and whether
// we can script Chrome's windows (AppleScript, macOS only). Everything else in the repo
// calls these helpers instead of branching on process.platform.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const isMac = process.platform === "darwin";
export const isWin = process.platform === "win32";
export const isLinux = process.platform === "linux";
export const SUPPORTED = isMac || isWin || isLinux;

export const platformName = () => (isMac ? "macOS" : isWin ? "Windows" : isLinux ? "Linux" : process.platform);

// Chrome's user-data dir (the folder holding "Local State" and one folder per profile).
// Override with AWB_CHROME_DIR for Chrome Beta / Chromium / a custom --user-data-dir.
export function chromeUserDataDir() {
  if (process.env.AWB_CHROME_DIR) return process.env.AWB_CHROME_DIR;
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  if (isLinux) return path.join(os.homedir(), ".config", "google-chrome");
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

// Absolute path to the Chrome executable. AWB_CHROME_BIN wins; on Windows we probe the
// three standard install locations and return the first that exists.
export function chromeBinary() {
  if (process.env.AWB_CHROME_BIN) return process.env.AWB_CHROME_BIN;
  if (isWin) {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const candidates = roots.map((r) => path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
    return candidates.find((c) => fs.existsSync(c)) || candidates[0] || "chrome.exe";
  }
  if (isLinux) {
    for (const c of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]) {
      if (fs.existsSync(c)) return c;
    }
    return "google-chrome";
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

// Run an executable OR a Node script. Windows cannot exec a `.mjs` through its shebang, so
// scripts are always run as `node <script> ...`; real binaries (AWB_DAEMON_BIN override) run as-is.
export function runBin(bin, args = [], opts = {}) {
  if (/\.(mjs|cjs|js)$/i.test(bin)) return execFileSync(process.execPath, [bin, ...args], { windowsHide: true, ...opts });
  return execFileSync(bin, args, { windowsHide: true, ...opts });
}

// Blocking sleep that works everywhere (there is no `sleep` binary on Windows).
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Env that makes a child process treat `home` as its home directory (per-profile daemon
// state). Node's os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
export function homeEnv(home) {
  return isWin ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

export function isChromeRunning() {
  try {
    if (isWin) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
      return /chrome\.exe/i.test(out);
    }
    execFileSync("pgrep", ["-x", isMac ? "Google Chrome" : "chrome"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Ask Chrome to quit gracefully (so it saves the session), then force it if it lingers.
// Chrome must be fully closed before we write a profile's LevelDB store.
export function quitChrome({ timeoutMs = 8000 } = {}) {
  if (!isChromeRunning()) return { stopped: true, forced: false };
  try {
    if (isMac) execFileSync("osascript", ["-e", 'tell application "Google Chrome" to quit'], { stdio: "ignore" });
    else if (isWin) execFileSync("taskkill", ["/IM", "chrome.exe"], { stdio: "ignore", windowsHide: true });
    else execFileSync("pkill", ["-TERM", "-x", "chrome"], { stdio: "ignore" });
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChromeRunning()) return { stopped: true, forced: false };
    sleepSync(300);
  }
  try {
    if (isWin) execFileSync("taskkill", ["/F", "/T", "/IM", "chrome.exe"], { stdio: "ignore", windowsHide: true });
    else execFileSync("pkill", ["-x", isMac ? "Google Chrome" : "chrome"], { stdio: "ignore" });
  } catch {}
  sleepSync(1500);
  return { stopped: !isChromeRunning(), forced: true };
}

// True only where we can script Chrome windows/tabs (AppleScript). Elsewhere callers fall
// back to launching Chrome with the URL, which opens a tab in the profile's window.
export const hasWindowScripting = isMac;
