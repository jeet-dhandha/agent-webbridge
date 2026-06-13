// lifecycle.mjs — daemon process lifecycle helpers.
// Tracks daemon uptime, manages the PID file (under a per-profile HOME so each
// fleet profile gets its own daemon record), and resolves the package version.
// Pure Node, ESM, no external deps.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const START_TS = Date.now();

// Seconds the daemon has been running (floored).
export function uptimeSeconds() {
  return Math.floor((Date.now() - START_TS) / 1000);
}

// Path to the daemon PID file. The fleet sets a per-profile HOME, so prefer
// process.env.HOME and fall back to os.homedir() when it is unset.
export function pidFilePath() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, ".agent-webbridge", "daemon.pid");
}

// Create the parent dir (if needed) and write this process's pid.
export function writePidFile() {
  const file = pidFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return file;
}

// Remove the PID file, ignoring any error (e.g. already gone).
export function removePidFile() {
  try {
    fs.unlinkSync(pidFilePath());
  } catch {
    // ignore
  }
}

// Read the package version from ../../package.json relative to this module.
// Fall back to "0.1.0" if it can't be read/parsed.
export function getVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}
