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
import { KIMI_EXT_ID, listProfiles } from "./profiles.mjs";

const CWS_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromeBinary() {
  if (process.env.KWB_CHROME_BIN) return process.env.KWB_CHROME_BIN;
  return CHROME_BIN;
}

export function unpackedExtPath() {
  const p = process.env.KWB_EXT_PATH || path.join(os.homedir(), "Downloads", "kimi-webbridge-extension");
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
