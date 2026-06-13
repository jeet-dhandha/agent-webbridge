#!/usr/bin/env node
// pack-extension.mjs — build the Chrome Web Store upload zip for the agent-webbridge
// MV3 extension.
//
// WHAT IT DOES
//   Zips agent-webbridge-extension/ into dist/agent-webbridge-extension-<version>.zip,
//   where <version> comes from package.json. Dev-only / junk files are excluded so the
//   uploaded bundle is exactly what ships to users (CWS rejects bundles that carry
//   build cruft, .orig backups, .DS_Store, etc.). Prints the absolute output path on
//   success — nothing else on stdout, so a caller can capture it.
//
// PORTABILITY
//   Uses Node builtins only and shells out to the system `zip` CLI (Info-ZIP), which is
//   present on macOS and most Linux distros. This repo is macOS-first (see README), so
//   `zip` is always available. If you are on a box without it, install Info-ZIP
//   (`brew install zip` / `apt-get install zip`) — we deliberately avoid adding an npm
//   archiver dependency to keep the package's only runtime dep `ws`.
//
// USAGE
//   node scripts/pack-extension.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(ROOT, "agent-webbridge-extension");
const DIST_DIR = path.join(ROOT, "dist");

// Dev-only / junk files that must never reach the Chrome Web Store bundle. Patterns are
// matched against `zip -x` (glob, relative to the extension dir). Keep this list in sync
// with anything a build/patch step might leave behind.
const EXCLUDE = [
  "*.orig",            // one-time backups written by patch scripts
  "*.bak",
  "*.log",
  ".DS_Store",
  "*/.DS_Store",
  "__MACOSX/*",
  ".git/*",
  "*.zip",
];

function die(msg) {
  console.error(`pack-extension: ${msg}`);
  process.exit(1);
}

// --- preflight ---------------------------------------------------------------
if (!fs.existsSync(EXT_DIR) || !fs.statSync(EXT_DIR).isDirectory()) {
  die(`extension dir not found: ${EXT_DIR}`);
}

const manifestPath = path.join(EXT_DIR, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  die(`no manifest.json in ${EXT_DIR}`);
}

const zipProbe = spawnSync("zip", ["-v"], { stdio: "ignore" });
if (zipProbe.error) {
  die(
    "the `zip` CLI is required but was not found on PATH. " +
      "Install Info-ZIP (macOS: preinstalled; Linux: `apt-get install zip`)."
  );
}

// --- version -----------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
if (!version) die("package.json has no version field");

// Sanity check: warn (don't fail) if the manifest version drifts from the package
// version, so the maintainer notices before uploading the wrong number to the CWS.
try {
  const manifestVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
  if (manifestVersion && manifestVersion !== version) {
    console.error(
      `pack-extension: note — manifest version (${manifestVersion}) differs from ` +
        `package version (${version}). The zip name uses the package version; the ` +
        `Chrome Web Store reads the manifest version. Make sure that's intended.`
    );
  }
} catch {
  /* manifest already validated to exist; ignore parse noise here */
}

// --- build -------------------------------------------------------------------
fs.mkdirSync(DIST_DIR, { recursive: true });

const outPath = path.join(DIST_DIR, `agent-webbridge-extension-${version}.zip`);
fs.rmSync(outPath, { force: true }); // zip appends to an existing archive; start clean

// `zip -r -X out.zip . -x <patterns>` run with cwd = EXT_DIR so the archive has the
// extension's files at its root (manifest.json at top level), which is what the CWS
// expects. `-X` strips extra macOS file attributes for a clean, reproducible bundle.
const args = ["-r", "-X", outPath, "."];
for (const p of EXCLUDE) args.push("-x", p);

const res = spawnSync("zip", args, { cwd: EXT_DIR, stdio: ["ignore", "ignore", "inherit"] });
if (res.status !== 0) {
  die(`zip exited with code ${res.status}`);
}

if (!fs.existsSync(outPath)) {
  die("zip reported success but the output file is missing");
}

// Final line on stdout is the absolute path — and nothing else — so it's easy to capture.
console.log(outPath);
