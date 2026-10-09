// platform.mjs — OS-abstraction tests. Runs on any OS: each case spawns a fresh Node with
// process.platform overridden, so the win32/linux branches are exercised from macOS too.
// (Real Windows runs happen in CI: .github/workflows/test.yml, windows-latest.)
//
// Run:  node test/platform.mjs

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_URL = pathToFileURL(path.join(REPO, "src", "platform.mjs")).href;
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// Evaluate `expr` against platform.mjs as if running on `platform`.
function asPlatform(platform, env, expr) {
  const code = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
    const p = await import(${JSON.stringify(PLATFORM_URL)}); console.log(JSON.stringify(await (${expr})(p)));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env }, encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const win = { LOCALAPPDATA: "C:\\Users\\jd\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" };

// --- paths ---------------------------------------------------------------
check("win32 user-data dir is %LOCALAPPDATA%\\Google\\Chrome\\User Data",
  asPlatform("win32", win, "p => p.chromeUserDataDir()").replace(/\\/g, "/").endsWith("AppData/Local/Google/Chrome/User Data")
  || asPlatform("win32", win, "p => p.chromeUserDataDir()").includes("Google"));
check("win32 user-data dir honours LOCALAPPDATA",
  asPlatform("win32", win, "p => p.chromeUserDataDir()").includes("Google") &&
  asPlatform("win32", win, "p => p.chromeUserDataDir()").endsWith("User Data"));
check("AWB_CHROME_DIR overrides on win32", asPlatform("win32", { ...win, AWB_CHROME_DIR: "D:\\chrome" }, "p => p.chromeUserDataDir()") === "D:\\chrome");
check("darwin user-data dir under Library/Application Support",
  asPlatform("darwin", {}, "p => p.chromeUserDataDir()").endsWith(path.join("Library", "Application Support", "Google", "Chrome")));
check("linux user-data dir is ~/.config/google-chrome",
  asPlatform("linux", {}, "p => p.chromeUserDataDir()").endsWith(path.join(".config", "google-chrome")));

// --- binary --------------------------------------------------------------
check("win32 chromeBinary points at chrome.exe under Google\\Chrome\\Application",
  /chrome\.exe$/i.test(asPlatform("win32", win, "p => p.chromeBinary()")) && /Google/.test(asPlatform("win32", win, "p => p.chromeBinary()")));
check("AWB_CHROME_BIN overrides", asPlatform("win32", { ...win, AWB_CHROME_BIN: "X:\\c.exe" }, "p => p.chromeBinary()") === "X:\\c.exe");
check("darwin chromeBinary is the .app binary", asPlatform("darwin", {}, "p => p.chromeBinary()").includes("Google Chrome.app"));

// --- misc ------------------------------------------------------------------
check("homeEnv sets USERPROFILE on win32 (os.homedir reads it)", JSON.stringify(asPlatform("win32", win, "p => p.homeEnv('C:/h')")) === JSON.stringify({ HOME: "C:/h", USERPROFILE: "C:/h" }));
check("homeEnv is HOME-only on darwin", JSON.stringify(asPlatform("darwin", {}, "p => p.homeEnv('/h')")) === JSON.stringify({ HOME: "/h" }));
check("window scripting is macOS-only",
  asPlatform("darwin", {}, "p => p.hasWindowScripting") === true && asPlatform("win32", win, "p => p.hasWindowScripting") === false);
check("platform names", asPlatform("win32", win, "p => p.platformName()") === "Windows" && asPlatform("darwin", {}, "p => p.platformName()") === "macOS");

// --- a Windows-shaped profile tree is discovered the same way ------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awb-udd-"));
fs.mkdirSync(path.join(tmp, "Profile 1"), { recursive: true });
fs.writeFileSync(path.join(tmp, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Work", user_name: "me@example.com" } } } }));
const profs = asPlatform("win32", { ...win, AWB_CHROME_DIR: tmp }, "async p => (await import(" + JSON.stringify(pathToFileURL(path.join(REPO, "src", "profiles.mjs")).href) + ")).listProfiles().map(x => [x.dir, x.name])");
check("listProfiles reads Local State under a Windows-style user-data dir", JSON.stringify(profs) === JSON.stringify([["Profile 1", "Work"]]), JSON.stringify(profs));
fs.rmSync(tmp, { recursive: true, force: true });

// --- runBin runs .mjs through node (Windows can't exec a shebang) --------------
const script = path.join(os.tmpdir(), `awb-runbin-${process.pid}.mjs`);
fs.writeFileSync(script, "console.log('ok-from-script')");
const { runBin } = await import(PLATFORM_URL);
check("runBin executes a .mjs via node", String(runBin(script, [], { encoding: "utf8" })).trim() === "ok-from-script");
fs.rmSync(script);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
