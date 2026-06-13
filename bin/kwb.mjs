#!/usr/bin/env node
// kwb.mjs — one entry point for the kimi-webbridge multi-profile layer.
//
//   kwb doctor                   read-only environment self-check (Chrome, kimi
//                                binary, profiles, extension, :10086) — run FIRST
//   kwb profiles                 list profiles, hashed ports, ext presence, daemon up?
//   kwb resolve <query>          resolve a name/email/dir to one profile
//   kwb tabs <profile>           list a profile's NORMAL open tabs (from disk, no bridge)
//   kwb status                   fleet status (all profiles' daemons)
//   kwb state                    last recorded start (time, per-profile connected) + stop
//   kwb connect <profile...>     point each profile's extension at its daemon by
//                                editing storage.local on disk (no popup, no click);
//                                closes Chrome to write, then you `kwb up`
//   kwb connect <p...> --restore point them back at the stock :10086 bridge
//   kwb up <profile...>          stop legacy :10086, start the named profiles' daemons,
//                                start the router on :10086, auto-connect (if Chrome is
//                                closed), open each window AND WAKE its extension, then
//                                poll until each reports connected
//   kwb up --all-ext             bring up every profile that has the extension
//   kwb up --no-open             start daemons + router only; don't open windows
//   kwb up --no-connect          don't touch storage.local; just open windows
//   kwb down [--no-restore]      stop router + all fleet daemons; restore legacy :10086
//                                (stops daemon processes only — never closes browser tabs)
//
// Idle auto-close: the router stops the fleet itself after KWB_IDLE_TIMEOUT_MIN minutes
// (default 120) with no /command — daemon processes only, browser tabs left open. The
// last start/stop is recorded in run/fleet-state.json (see `kwb state`).
//   kwb install --forcelist      enable CWS force-install across ALL profiles (needs Chrome restart)
//   kwb install --missing        list profiles lacking the extension
//   kwb install-dev <profile...> guided dev-build install: open CWS if the ext
//                                is missing, poll every 5s for up to 600s for
//                                install, run `kwb down` on timeout / Ctrl-C,
//                                then open chrome://extensions and prompt the
//                                user to enable Developer mode + Load unpacked
//                                the repo's kimi-webbridge-extension/ folder
//                                (replacing the CWS build with our local dev
//                                build, which is what the multi-tab work in
//                                1d4961c / 76f2d9b needs to be tested against).
//                                After Load unpacked, opens
//                                chrome://extensions/?id=<devId> focused on the
//                                dev card and prompts the user to click Reload
//                                — this is the iterate-on-background.js loop.
//                                A CORRUPT extension (disabled / stale unpacked path /
//                                missing payload / orphaned files) is auto-removed on
//                                disk first, then reinstalled clean; --reinstall forces
//                                that removal even for a healthy build.
//                                --skip-cws / --no-open / --no-reload / --reinstall
//                                tweak the flow.
//
// Zero-click connect has TWO halves, both pure Node / no deps / no CDP:
//   1. WRITE the URL: the extension's daemon URL is a plain `local_url` key in its
//      storage.local LevelDB (NOT integrity-protected). `kwb connect` writes it directly
//      while Chrome is closed, replacing the manual popup click. The value persists.
//   2. WAKE the worker: the kimi MV3 service worker only re-reads local_url when it
//      STARTS, but it registers no onStartup listener, so Chrome never auto-starts it on
//      launch — the write alone does nothing on an already-set-up profile. `kwb up` wakes
//      it by opening the extension's own popup page as a tab (see extension.mjs
//      wakeExtension), which is the headful equivalent of clicking the toolbar icon.
// (CDP can't do either on real profiles: branded Chrome 136+ blocks remote-debugging on
// the default user-data-dir where real profiles live.)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProfiles, resolveProfile, kimiExtId, hasKimiExtension, ROUTER_PORT } from "../src/profiles.mjs";
import { listOpenTabs } from "../src/snss.mjs";
import { startDaemon, stopDaemon, fleetStatus, daemonStatus, KIMI_BIN } from "../src/fleet.mjs";
import {
  profilesMissingExtension,
  enableForceInstall,
  launchWithExtension,
  openChromeProfile,
  wakeExtension,
  isChromeRunning,
  quitChrome,
  launchChrome,
  cleanupAnnoyingTabs,
  closeBlankWindows,
  isProfileWindowOpen,
  unpackedExtPath,
  openUrlInProfile,
  devBuildExtId,
  devBuildLastModifiedMs,
  extensionHealth,
  removeExtensionOnDisk,
} from "../src/extension.mjs";
import { setLocalUrl, readLocalUrl } from "../src/storage.mjs";
import { RUN, ROUTER_PID, ROUTER_LOG, ensureRun, readState, writeState, patchState } from "../src/runstate.mjs";
import { runDoctor, printDoctor } from "../src/doctor.mjs";

const CWS_KIMI_WEBBRIDGE_URL = "https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc";
const EXTENSION_INSTALL_POLL_MS = 5000;       // check every 5 seconds
const EXTENSION_INSTALL_TIMEOUT_MS = 300000;  // for up to 5 minutes

// This tool is macOS + Google Chrome only. The `open`, `pgrep`, `defaults`
// commands and the ~/Library/Application Support/Google/Chrome paths are
// macOS-specific; Linux/Windows support would need the path + launcher helpers
// changed. Warn loudly rather than misbehave silently.
if (process.platform !== "darwin") {
  console.error(
    `⚠️  kimi-webbridge-fleet currently supports macOS + Google Chrome only ` +
      `(this machine is "${process.platform}"). Commands like \`open\`/\`defaults\` ` +
      `and the Chrome paths will not work. See README → Platform & scope.`,
  );
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
ensureRun(); // RUN / ROUTER_PID / ROUTER_LOG come from runstate.mjs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cleanupAnnoyingTabs is now imported from extension.mjs and uses AppleScript.

async function legacyOrRouterUp() {
  const s = await daemonStatus(ROUTER_PORT);
  return s; // either the legacy daemon or our router answers /status
}

function stopLegacy() {
  try {
    execFileSync(KIMI_BIN, ["stop"], { stdio: "ignore" });
  } catch {}
}

function startLegacy() {
  try {
    execFileSync(KIMI_BIN, ["start"], { stdio: "ignore" });
  } catch {}
}

function routerRunning() {
  try {
    const pid = parseInt(fs.readFileSync(ROUTER_PID, "utf8").trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// Minutes of /command inactivity before the router tears the fleet down itself (0 = off).
const IDLE_MIN = Number(process.env.KWB_IDLE_TIMEOUT_MIN ?? 120);

function startRouter() {
  // Log to a file (not /dev/null) so the detached router's idle-shutdown is observable.
  const out = fs.openSync(ROUTER_LOG, "a");
  const child = spawn("node", [path.join(HERE, "..", "src", "router.mjs")], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(ROUTER_PID, String(child.pid));
  return child.pid;
}

function killRouter() {
  const pid = routerRunning();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    fs.rmSync(ROUTER_PID, { force: true });
    return true;
  }
  return false;
}

async function cmdUp(args) {
  let targets;
  if (args.includes("--all-ext")) {
    targets = listProfiles().filter((p) => p.hasExtension);
  } else {
    targets = args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  }
  if (!targets.length) {
    console.error("kwb up: name at least one profile, or use --all-ext");
    process.exit(1);
  }
  // Free :10086 (legacy daemon or stale router) so daemon `start` won't refuse.
  if (killRouter()) await sleep(500);
  if (await legacyOrRouterUp()) {
    console.log("• freeing :10086 (stopping legacy daemon)…");
    stopLegacy();
    await sleep(1000);
  }
  for (const p of targets) {
    const r = await startDaemon(p);
    console.log(`• ${r.started ? "started" : "already up"}: ${p.dir} "${p.name}" → :${p.port}`);
  }
  const pid = startRouter();
  await sleep(1200);
  console.log(`• router on :${ROUTER_PORT} (pid ${pid})`);
  console.log(
    IDLE_MIN > 0
      ? `• idle auto-shutdown: fleet stops itself after ${IDLE_MIN}m with no /command (set KWB_IDLE_TIMEOUT_MIN, 0=off)`
      : `• idle auto-shutdown: disabled (KWB_IDLE_TIMEOUT_MIN=0)`,
  );

  if (args.includes("--no-open")) return;

  // Point each profile's extension at its daemon by editing storage.local on disk
  // (no popup, no CDP). The write needs Chrome closed; if it's already running we
  // skip it here and tell the user to run `kwb connect` (which closes Chrome).
  if (!args.includes("--no-connect")) {
    const mismatched = targets.filter((p) => readLocalUrl(p.dir) !== p.wsUrl);
    if (mismatched.length && isChromeRunning()) {
      console.log(`\nℹ ${mismatched.length} profile(s) not yet pointed at their daemon. Chrome is`);
      console.log("  running, so their on-disk storage can't be edited. Set them up with:");
      console.log(`    kwb connect ${mismatched.map((p) => `'${p.dir}'`).join(" ")}`);
      console.log("  (closes Chrome, writes the URLs) then re-run this `kwb up`.\n");
    } else {
      for (const p of mismatched) {
        const r = setLocalUrl(p.dir, p.wsUrl);
        console.log(`• connected ${p.name} → :${p.port} (${r.mode} storage.local)`);
      }
    }
  }

  const noConnect = args.includes("--no-connect");
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    // Open the window AND wake the dormant service worker (opens the extension's popup
    // as a background tab) so it reads local_url and connects. Without the wake, an MV3
    // worker on an already-set-up profile never starts on launch, so the URL we wrote is
    // never applied. Profiles without the extension (or --no-connect) just get a window.
    if (!noConnect && p.extId) {
      const status = await daemonStatus(p.port);
      const windowOpen = isProfileWindowOpen(p.extId);
      if (status?.extension_connected === true && windowOpen) {
        console.log(`• already connected: ${p.name} (${p.extType} ext)`);
      } else {
        wakeExtension(p.dir, p.extId);
        console.log(`• opened + woke ${p.name} (${p.extType} ext)`);
      }
    } else {
      openChromeProfile(p.dir);
      console.log(`• opened Chrome window: ${p.name}`);
    }
    // The first launch may cold-start Chrome; let its singleton come up before the next
    // launch forwards to it, so we don't race two processes onto the default user-data-dir.
    if (i === 0 && targets.length > 1) await sleep(2000);
    else if (i < targets.length - 1) await sleep(600);
  }

  // Poll each daemon until its extension connects (worker cold-start + WS handshake
  // takes a few seconds), rather than a single fixed-delay check.
  await sleep(1500);
  const connections = [];
  for (const p of targets) {
    const connected = await waitConnected(p.port, 12000);
    connections.push({ dir: p.dir, name: p.name, port: p.port, extId: p.extId, extType: p.extType, connected });
    console.log(`  ${connected ? "✓ connected   " : "… not connected"} ${p.name.padEnd(18)} → :${p.port}`);
    if (connected) {
      cleanupAnnoyingTabs(p.extId);
    }
  }

  // Record the last start so we can later confirm everything came up (kwb state).
  const startedAt = new Date().toISOString();
  const okCount = connections.filter((c) => c.connected).length;
  writeState({
    startedAt,
    stoppedAt: null,
    stoppedReason: null,
    routerPort: ROUTER_PORT,
    routerPid: pid,
    idleTimeoutMin: IDLE_MIN,
    allConnected: okCount === connections.length,
    profiles: connections,
  });
  console.log(`• recorded start @ ${startedAt} — ${okCount}/${connections.length} connected (kwb state)`);
}

// Poll a daemon's /status until extension_connected is true or the deadline passes.
async function waitConnected(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const s = await daemonStatus(port);
    if (s?.extension_connected) return true;
    await sleep(700);
  } while (Date.now() < deadline);
  return false;
}

// `kwb connect <profiles...> [--restore]` — point each profile's extension at its
// daemon URL (or back at the stock :10086 with --restore) by editing storage.local
// on disk. Requires Chrome closed, so it quits Chrome first (graceful, then force).
//
// Returns { ok, results } so callers (CLI dispatch, cmdInstallDev) can decide whether
// to process.exit or compose further. The CLI dispatch case "connect" does the exit.
async function cmdConnect(args, { exitOnDone = true } = {}) {
  const restore = args.includes("--restore");
  const targets = args.includes("--all-ext")
    ? listProfiles().filter((p) => p.hasExtension)
    : args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  if (!targets.length) {
    if (exitOnDone) {
      console.error("kwb connect: name at least one profile, or use --all-ext");
      process.exit(1);
    }
    return { ok: false, results: [] };
  }
  if (isChromeRunning()) {
    console.log("• closing Chrome to edit extension storage (session is saved for restore)…");
    const q = quitChrome();
    if (!q.stopped) {
      if (exitOnDone) {
        console.error("could not quit Chrome — close it manually and retry");
        process.exit(1);
      }
      return { ok: false, results: [], error: "could not quit Chrome" };
    }
    console.log(`• Chrome closed${q.forced ? " (forced)" : ""}`);
  }
  const results = [];
  let ok = true;
  for (const p of targets) {
    const url = restore ? `ws://127.0.0.1:${ROUTER_PORT}/ws` : p.wsUrl;
    try {
      const r = setLocalUrl(p.dir, url);
      console.log(`✓ ${p.name.padEnd(18)} → ${url} (${r.mode})`);
      results.push({ profile: p, ok: true, mode: r.mode, url });
    } catch (e) {
      ok = false;
      console.log(`✗ ${p.name.padEnd(18)} ${e.message}`);
      results.push({ profile: p, ok: false, error: e.message });
    }
  }
  if (restore) console.log("\nRestored to the stock :10086 bridge. Reopen Chrome to reconnect.");
  else console.log(`\nNext:  kwb up ${targets.map((p) => `'${p.dir}'`).join(" ")}`);
  if (exitOnDone) process.exit(ok ? 0 : 1);
  return { ok, results };
}

async function cmdDown(args) {
  const restore = !args.includes("--no-restore");
  console.log(killRouter() ? "• router stopped" : "• router not running");
  // Stops daemon PROCESSES only — the extensions disconnect but Chrome tabs stay open.
  for (const p of listProfiles()) {
    if (await daemonStatus(p.port)) {
      await stopDaemon(p);
      console.log(`• stopped daemon: ${p.dir} "${p.name}" (:${p.port})`);
    }
  }
  await sleep(800);
  closeBlankWindows();
  console.log("• closed empty Chrome windows");
  if (restore) {
    startLegacy();
    await sleep(1500);
    const s = await daemonStatus(ROUTER_PORT);
    console.log(`• legacy :${ROUTER_PORT} daemon ${s ? "restored" : "FAILED to restore"}`);
  }
  try { patchState({ stoppedAt: new Date().toISOString(), stoppedReason: "manual" }); } catch {}
}

// `kwb setup <profile...>` — the canonical install/setup for the OFFICIAL extension.
//
// One flow that does detection, removal, install, and bring-up:
//   1. DETECT via the on-disk Extensions/<id>/ folder (the true source of record) plus the
//      registry. 2. REMOVE — integrated into setup — sweeps a corrupt install (and, with
//      --reinstall, a healthy one) from every on-disk location before reinstalling.
//   3. INSTALL via the Chrome Web Store, POLLING every 5s for up to 5min for the folder to
//      appear. 4. WIRE each profile to its daemon and bring the fleet up.
//
// `--reinstall` forces removal even if the current install looks healthy.
async function cmdSetupInteractive(args) {
  const reinstall = args.includes("--reinstall");
  const targets = args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  if (!targets.length) {
    console.error("usage: kwb setup <profile...> [--reinstall]");
    console.error("  --reinstall  remove the current extension from disk first, then reinstall clean");
    process.exit(1);
  }

  // Phase 1 — detect + remove. Check folders + registry. Remove a corrupt install (or, with
  // --reinstall, any install) from ALL on-disk locations so the CWS install lands clean.
  // Needs Chrome closed (the stores are locked while it runs).
  const removals = [];
  for (const p of targets) {
    const h = extensionHealth(p.dir);
    if (h.corrupt) {
      console.log(`• "${p.name}": extension CORRUPT — ${h.reason}; will remove + reinstall.`);
      removals.push({ p, extId: h.extId });
    } else if (reinstall && h.installed) {
      console.log(`• "${p.name}": --reinstall; removing the current ${h.location ?? "build"} first.`);
      removals.push({ p, extId: h.extId });
    } else if (h.installed) {
      console.log(`• "${p.name}": already installed (${h.location}).`);
    } else {
      console.log(`• "${p.name}": not installed.`);
    }
  }
  if (removals.length) {
    if (isChromeRunning()) {
      console.log("• closing Chrome to remove extension artifacts on disk (session saved for restore)…");
      const q = quitChrome();
      if (!q.stopped) {
        console.error("✗ could not quit Chrome — close it manually and re-run `kwb setup`.");
        process.exit(1);
      }
      console.log(`• Chrome closed${q.forced ? " (forced)" : ""}`);
    }
    for (const { p, extId } of removals) {
      const r = removeExtensionOnDisk(p.dir, extId);
      console.log(
        r.ok
          ? `  ✓ ${p.name}: removed ${r.removed.length} on-disk item(s)${r.removed.length ? ` — ${r.removed.join(", ")}` : ""}`
          : `  ✗ ${p.name}: ${r.error || (r.errors || []).join("; ")}`,
      );
    }
  }

  // Phase 2 — install via the Chrome Web Store, polling the on-disk folder every 5s for up
  // to 5min. hasKimiExtension() checks Extensions/<id>/ (the true source), so detection is
  // file-based, not a guess from the registry.
  for (const p of targets) {
    if (hasKimiExtension(p.dir)) {
      console.log(`• "${p.name}": extension present on disk — skipping CWS install.`);
      continue;
    }
    console.log(`\n👉 "${p.name}": opening the Chrome Web Store — click "Add to Chrome".`);
    console.log(`   ${CWS_KIMI_WEBBRIDGE_URL}`);
    openUrlInProfile({ profileDir: p.dir, windowId: null, url: CWS_KIMI_WEBBRIDGE_URL });

    const deadline = Date.now() + EXTENSION_INSTALL_TIMEOUT_MS;
    let installed = false;
    let tick = 0;
    while (Date.now() < deadline) {
      await sleep(EXTENSION_INSTALL_POLL_MS);
      if (hasKimiExtension(p.dir)) { installed = true; break; }
      if (tick++ % 4 === 0) {
        const remain = Math.round((deadline - Date.now()) / 1000);
        console.log(`   …waiting for install (${remain}s left, checking every ${EXTENSION_INSTALL_POLL_MS / 1000}s)`);
      }
    }
    if (!installed) {
      console.error(`✗ "${p.name}": extension not installed within ${EXTENSION_INSTALL_TIMEOUT_MS / 1000}s. Re-run \`kwb setup\`.`);
      process.exit(1);
    }
    console.log(`  ✓ "${p.name}": extension detected on disk (Extensions/${kimiExtId(p.dir)}).`);
  }

  // Phase 3 — wire each profile to its daemon (cmdConnect quits Chrome once, writes
  // local_url) and bring the fleet up.
  console.log("\n• connecting + starting the fleet…");
  const connectRes = await cmdConnect(targets.map((p) => p.dir), { exitOnDone: false });
  if (!connectRes.ok) {
    console.error("✗ storage.local write failed for one or more profiles — not starting the fleet.");
    process.exit(1);
  }
  await cmdUp(targets.map((p) => p.dir));
}

// `kwb install-dev <profile...>` — guided dev-build install.
//
// 1. For each target profile that lacks the extension, open the CWS page in a
//    Chrome window of that profile and start polling for install every 5s
//    (up to 600s). Reads the registry from disk each tick so the answer is
//    always fresh — Chrome re-reads extensions.settings on its own poll too.
// 2. While polling, the user can abort with Ctrl-C or by typing "q" + Enter;
//    either path runs `kwb down --no-restore` so any daemon / router we may
//    have started in a previous step is reaped and :10086 stays free.
// 3. Once the extension shows up, open chrome://extensions for the same
//    profile and prompt the user to (a) flip on Developer mode and (b) click
//    "Load unpacked" → pick `kimi-webbridge-extension/` (the repo root copy
//    the multi-tab work in 1d4961c / 76f2d9b lives in). After Load unpacked,
//    the unpacked build's id (dev, not stable) is what Chrome will report in
//    `kwb profiles` going forward — the CWS build gets shadowed by the new
//    unpacked entry with the same name.
// 3.5. Reload handoff — open chrome://extensions/?id=<devId> focused on the
//      dev card and prompt the user to click Reload. This is the
//      iterate-on-background.js loop. We can't click Reload programmatically
//      (CDP is blocked on real profiles, chrome://extensions is a privileged
//      internal page with no AppleScript hook for the per-card Reload button),
//      so the user does the one click per iteration and the wizard handles
//      everything else. We deliberately do NOT pre-check whether the unpacked
//      entry is registered by reading Secure Preferences: Chrome batches
//      disk writes of HMAC-protected prefs, so a right-after-Enter read can
//      miss the entry the user just registered. If Load unpacked wasn't done
//      yet, the chrome://extensions page renders with a missing-extension
//      error, which is itself a clear prompt — the user knows what to do.
// 4. Compose the rest by calling cmdConnect + cmdUp. cmdConnect quits Chrome
//    once (LevelDB is single-writer) and writes local_url atomically; cmdUp
//    starts the daemons + router + opens windows + wakes each extension.
//    Critically, we do NOT quit Chrome between phases 3 / 3.5 / 4 — doing so
//    can roll back an in-flight Secure Preferences write (the previous
//    install run's bug: the CWS install was detected during the poll, but
//    our quitChrome force-killed Chrome before the write flushed, so the
//    entry vanished on next start). Chrome stays open from the user's first
//    click all the way through the Reload handoff; cmdConnect is the single
//    authoritative quit.
//
// `--skip-cws` assumes the extension is already present (skips the CWS page +
// poll) and goes straight to the chrome://extensions handoff. Useful when the
// user just wants to swap the CWS build for our local dev build.
//
// `--no-reload` skips phase 3.5 entirely. Use on the very first run, before
// Load unpacked has ever been done — there's nothing to Reload yet.
//
// `--no-open` stops after phase 4's connect step; the user runs `kwb up`
// themselves.
async function cmdInstallDev(args) {
  const skipCws = args.includes("--skip-cws");
  const noOpen = args.includes("--no-open");
  const noReload = args.includes("--no-reload");
  const reinstall = args.includes("--reinstall");
  const targets = args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  if (!targets.length) {
    console.error("usage: kwb install-dev <profile...> [--skip-cws] [--no-open] [--no-reload] [--reinstall]");
    console.error("  --skip-cws   assume the CWS extension is already installed, jump to dev-mode handoff");
    console.error("  --no-open    after install, don't auto-start the fleet — leave Chrome for the user to drive");
    console.error("  --no-reload  skip the 'click Reload on the unpacked card' handoff (useful on first run");
    console.error("                when Load unpacked hasn't been done yet, or when you don't want the wizard");
    console.error("                to open chrome://extensions/?id=<devId> and pause for Enter)");
    console.error("  --reinstall  force-remove the current extension on disk first, then reinstall clean");
    console.error("                (a CORRUPT extension — disabled / stale unpacked path / missing payload —");
    console.error("                 is auto-removed even without this flag)");
    process.exit(1);
  }

  // 1. Resolve the unpacked ext path AND the dev build's extension id up front so we
  //    fail fast on a mis-set checkout. The id is derived from the manifest's `key`
  //    field (SHA-256 of the DER public key, first 16 bytes mapped to "a".."p"). It is
  //    STABLE for this exact checkout — if the `key` ever changes, the id changes and
  //    prior local_url writes go to the wrong store.
  let extPath;
  let devId;
  try {
    extPath = unpackedExtPath();
    devId = devBuildExtId();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(`• dev build folder (will be "Load unpacked"-ed): ${extPath}`);
  console.log(`• dev build's Chrome extension id (derived from manifest.key): ${devId}`);

  // 1.5. Health + repair pass — BEFORE any windows open, so Chrome can be closed to edit
  //      on-disk stores. For each target, check the installed extension. If it's CORRUPT
  //      (disabled / Chrome's corrupted flag, a stale unpacked source path, a missing store
  //      payload, or an orphaned payload with no registry entry) — or if --reinstall was
  //      passed — auto-remove its on-disk artifacts so the steps below reinstall it clean.
  //      Healthy extensions are left untouched unless --reinstall. We do the removals in one
  //      batch with Chrome closed once, then let the normal install flow (CWS / Load
  //      unpacked) re-register a clean entry; Chrome's startup GC drops the stale registry
  //      rows on its own (no risky Secure Preferences hand-editing).
  const repairs = [];
  for (const p of targets) {
    const h = extensionHealth(p.dir);
    if (h.corrupt) {
      console.log(`• "${p.name}": extension looks CORRUPT — ${h.reason}. Will uninstall + reinstall.`);
      repairs.push({ p, extId: h.extId });
    } else if (reinstall && (h.installed || h.extId)) {
      console.log(`• "${p.name}": --reinstall — removing the current ${h.location ?? "extension"} build first.`);
      repairs.push({ p, extId: h.extId });
    } else if (h.installed) {
      console.log(`• "${p.name}": extension healthy (${h.location}).`);
    }
  }
  if (repairs.length) {
    if (isChromeRunning()) {
      console.log("• closing Chrome to remove extension artifacts on disk (session is saved for restore)…");
      const q = quitChrome();
      if (!q.stopped) {
        console.error("✗ could not quit Chrome — close it manually and re-run `kwb install-dev`.");
        process.exit(1);
      }
      console.log(`• Chrome closed${q.forced ? " (forced)" : ""}`);
    }
    for (const { p, extId } of repairs) {
      const r = removeExtensionOnDisk(p.dir, extId);
      if (r.ok) {
        console.log(`  ✓ ${p.name}: removed ${r.removed.length} on-disk item(s)${r.removed.length ? ` — ${r.removed.join(", ")}` : ""}`);
      } else {
        console.error(`  ✗ ${p.name}: ${r.error || (r.errors || []).join("; ")}`);
      }
    }
    console.log("• repair done — Chrome's startup GC clears the stale registry; the steps below reinstall clean.\n");
  }

  // Track if the user asked to abort; checked at every sleep/poll boundary.
  let aborted = false;
  const onSigint = () => {
    aborted = true;
    console.log("\n⚠ Ctrl-C received — aborting and running `kwb down --no-restore`…");
  };
  process.on("SIGINT", onSigint);

  // Watch stdin for "q" + Enter as a non-Ctrl-C abort path (Chrome may swallow
  // the SIGINT on some terminals, and a typed "q" is friendlier in TTYs anyway).
  let stdinAbort = null;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (chunk && /^q\s*$/i.test(chunk.trim())) aborted = true;
    });
  }

  const abortAndDown = async (reason) => {
    console.log(`\n✗ aborting: ${reason}`);
    console.log("• running `kwb down --no-restore` to release :10086 + any daemons");
    try { await cmdDown(["--no-restore"]); } catch (e) { console.error(`  kwb down failed: ${e.message}`); }
    process.exit(2);
  };

  // 2. For each target: open CWS if missing, poll for install, then go to chrome://extensions.
  //    One Chrome process / one window per profile — see openUrlInProfile's note.
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    console.log(`\n👉 [${i + 1}/${targets.length}] profile "${p.name}" (${p.dir}) → :${p.port}`);

    // Fresh read of the registry — kimiExtId re-parses the same Chrome file each call.
    let installed = !!kimiExtId(p.dir);
    // windowId is remembered across the two URL ops so the chrome://extensions tab lands
    // in the SAME window the CWS tab opened in (not a fresh second window).
    let windowId = null;

    if (!installed && !skipCws) {
      console.log(`• extension not installed in "${p.name}" — opening Chrome Web Store…`);
      console.log(`  ${CWS_KIMI_WEBBRIDGE_URL}`);
      const r = openUrlInProfile({ profileDir: p.dir, windowId: null, url: CWS_KIMI_WEBBRIDGE_URL });
      windowId = r.windowId;
      console.log(`  ↪ opened (mode=${r.mode}, windowId=${windowId ?? "?"})`);

      const deadline = Date.now() + EXTENSION_INSTALL_TIMEOUT_MS;
      const start = Date.now();
      let tick = 0;
      while (Date.now() < deadline) {
        if (aborted) await abortAndDown("user aborted during install poll");
        if (tick++ % 6 === 0) {
          const elapsed = Math.round((Date.now() - start) / 1000);
          const remain = Math.round((deadline - Date.now()) / 1000);
          console.log(`  …polling (${elapsed}s elapsed, ${remain}s remaining, every ${EXTENSION_INSTALL_POLL_MS / 1000}s) — type "q" + Enter to abort, or Ctrl-C`);
        }
        await sleep(EXTENSION_INSTALL_POLL_MS);
        if (aborted) await abortAndDown("user aborted during install poll");
        installed = !!kimiExtId(p.dir);
        if (installed) {
          console.log(`  ✓ extension detected in "${p.name}" (registry read succeeded)`);
          break;
        }
      }
      if (!installed) {
        await abortAndDown(
          `extension not installed in "${p.name}" within ${EXTENSION_INSTALL_TIMEOUT_MS / 1000}s. Re-run after installing, or pass --skip-cws if it's already there.`,
        );
      }
    } else if (installed) {
      console.log(`• extension is already installed in "${p.name}" (skipping CWS handoff${skipCws ? " — --skip-cws" : ""}).`);
      // No window to anchor against — we'll cold-start one in the chrome://extensions step.
    } else if (skipCws) {
      await abortAndDown(`--skip-cws set, but no extension is installed in "${p.name}". Install it first or drop --skip-cws.`);
    }

    // 3. chrome://extensions handoff — user flips Developer mode on, clicks
    //    "Load unpacked", and picks the dev build folder. We append the
    //    chrome://extensions tab to the SAME window the CWS tab opened in
    //    (windowId is reused), so the user sees one window for the whole wizard.
    console.log(`\n  → Adding chrome://extensions tab to "${p.name}"'s window (id=${windowId ?? "?"}). Please:`);
    console.log(`      1. Toggle the "Developer mode" switch ON (top-right).`);
    console.log(`      2. Click "Load unpacked".`);
    console.log(`      3. Select this folder: ${extPath}`);
    console.log(`         (the in-repo build carrying the multi-tab queue lock from 1d4961c + the`);
    console.log(`          router-level serialization from 76f2d9b; replaces the CWS build)`);
    console.log(`      4. After "Kimi WebBridge" appears in the list, press Enter here to continue.`);
    if (windowId) {
      const r = openUrlInProfile({ profileDir: p.dir, windowId, url: "chrome://extensions" });
      console.log(`  ↪ opened (mode=${r.mode}${r.error ? `, error=${r.error}` : ""})`);
    } else {
      // Last-ditch fallback: we never anchored (no CWS step ran, ext was already installed,
      // Chrome wasn't running, the newtab anchor didn't catch). Cold-start a fresh window.
      const r = openUrlInProfile({ profileDir: p.dir, windowId: null, url: "chrome://extensions" });
      console.log(`  ↪ opened fresh (mode=${r.mode}, windowId=${r.windowId ?? "?"})`);
    }

    // Block on Enter. process.stdin is shared across the loop, so we use the
    // standard `once("data", ...)` pattern; Ctrl-C is handled by the SIGINT
    // listener above.
    await new Promise((resolve) => {
      const onData = () => { cleanup(); resolve(); };
      const onSig = () => { cleanup(); aborted = true; resolve(); };
      const cleanup = () => {
        process.stdin.removeListener("data", onData);
        process.removeListener("SIGINT", onSig);
      };
      process.stdin.once("data", onData);
      process.once("SIGINT", onSig);
    });
    if (aborted) await abortAndDown("user aborted at chrome://extensions handoff");

    // 3.5. Reload handoff — for the iterate-on-background.js loop.
    //   Honest constraint: Chrome's chrome://extensions page is a privileged internal
    //   page; the "Reload" button on a specific extension card has no public AppleScript
    //   hook, and CDP is blocked on real profiles. So we open `chrome://extensions/?id=<devId>`
    //   (Chrome honors this URL fragment and scrolls to the matching card), tell the
    //   user to click Reload, and block on Enter. One click per iterate cycle, but the
    //   wizard handles everything else: storage.local, daemon connect, polling, fleet
    //   bring-up. Skipped if --no-reload is set.
    //
    //   We do NOT pre-check whether the unpacked entry is registered by reading
    //   Secure Preferences. Two reasons: (a) Chrome batches disk writes of HMAC-
    //   protected prefs, so a right-after-Enter read can miss the entry the user just
    //   registered; (b) if Load unpacked wasn't done, the page renders with a missing-
    //   extension error, which is itself a clear prompt for the user. Always opening
    //   the page is simpler and more honest.
    if (noReload) {
      console.log(`\n  ↳ --no-reload set; not opening the Reload handoff.`);
    } else {
      const lastMod = devBuildLastModifiedMs();
      const mtimeStr = new Date(lastMod).toISOString().replace("T", " ").slice(0, 19);
      console.log(`\n  ↳ Opening chrome://extensions/?id=${devId} focused on the dev card.`);
      console.log(`     Dev build's most recent change: ${mtimeStr} UTC.`);
      console.log(`     → If the "Kimi WebBridge" card is missing: you haven't Load unpacked yet —`);
      console.log(`       toggle Developer mode ON (top-right), click "Load unpacked", and pick:`);
      console.log(`         ${extPath}`);
      console.log(`       Then come back to this tab and click the "↻ Reload" button on the card.`);
      console.log(`     → If the card is already there: just click "↻ Reload" to pick up the latest`);
      console.log(`       background.js / popup.html / manifest.json changes from ${extPath}.`);
      console.log(`     Then press Enter here.`);
      // Reuse the same window the CWS/chrome://extensions tab already opened in so
      // we keep the one-window-per-profile guarantee. Re-anchor if we somehow lost it.
      let reloadWindowId = windowId;
      if (!reloadWindowId || !isChromeRunning()) {
        const r = openUrlInProfile({
          profileDir: p.dir,
          windowId: null,
          url: `chrome://extensions/?id=${devId}`,
        });
        reloadWindowId = r.windowId;
        console.log(`  ↪ opened fresh (mode=${r.mode}, windowId=${reloadWindowId ?? "?"})`);
      } else {
        const r = openUrlInProfile({
          profileDir: p.dir,
          windowId: reloadWindowId,
          url: `chrome://extensions/?id=${devId}`,
        });
        console.log(`  ↪ appended to existing window (mode=${r.mode}${r.error ? `, error=${r.error}` : ""})`);
      }

      await new Promise((resolve) => {
        const onData = () => { cleanup(); resolve(); };
        const onSig = () => { cleanup(); aborted = true; resolve(); };
        const cleanup = () => {
          process.stdin.removeListener("data", onData);
          process.removeListener("SIGINT", onSig);
        };
        process.stdin.once("data", onData);
        process.once("SIGINT", onSig);
      });
      if (aborted) await abortAndDown("user aborted at Reload handoff");
      console.log(`  ✓ Reload handoff complete for "${p.name}".`);
    }
  }

  process.off("SIGINT", onSigint);
  if (stdinAbort) stdinAbort();

  if (noOpen) {
    console.log("\n• --no-open set; not starting the fleet. Run `kwb up <profile...>` when you're ready.");
    return;
  }

  // 4. Chrome is still open from the handoffs (good — we want the user's Load unpacked
  //    + Reload clicks to have flushed to Secure Preferences before we touch anything
  //    destructive). Now: do the daemon-URL write in a single atomic step by calling
  //    cmdConnect with exitOnDone:false. cmdConnect quits Chrome → writes local_url →
  //    returns. Then bring the fleet up. This is the same flow the rest of the fleet
  //    uses (kwb up's mismatch path), composed not duplicated, so a future change to
  //    the connect flow (e.g. a different quit strategy) lands in one place.
  console.log("\n• writing daemon URL into storage.local (via cmdConnect, which quits Chrome)…");
  const connectRes = await cmdConnect(targets.map((p) => p.dir), { exitOnDone: false });
  if (!connectRes.ok) {
    console.error("✗ storage.local write failed for one or more profiles — not starting the fleet.");
    console.error("  re-run `kwb install-dev` (or `kwb connect` then `kwb up`) once the issue is resolved.");
    process.exit(1);
  }
  console.log("\n• starting the fleet…");
  await cmdUp(targets.map((p) => p.dir));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "doctor":
      process.exit(printDoctor(await runDoctor()));
      break;
    case "profiles":
      console.table(
        (await Promise.all(
          listProfiles().map(async (p) => ({
            dir: p.dir,
            name: p.name,
            email: p.email,
            port: p.port,
            ext: p.hasExtension ? (p.extEnabled ? p.extType : `${p.extType} (off)`) : "—",
            daemonUp: !!(await daemonStatus(p.port)),
          })),
        )),
      );
      break;
    case "resolve":
      console.log(JSON.stringify(resolveProfile(args[0]), null, 2));
      break;
    case "tabs": {
      const includeBlanks = args.includes("--all");
      const profileQuery = args.filter((a) => a !== "--all")[0];
      const res = listOpenTabs(profileQuery, { includeBlanks });
      console.log(`${res.profile.name} (${res.profile.dir}) :${res.profile.port} — ${res.tabs.length} open tab(s)`);
      for (const t of res.tabs) console.log(`  [${t.tabId}] ${t.title.slice(0, 70)} — ${t.url.slice(0, 100)}`);
      break;
    }
    case "status":
      console.table(await fleetStatus());
      break;
    case "state": {
      const st = readState();
      if (!st) {
        console.log("no fleet state recorded yet — run `kwb up`");
      } else {
        console.log(JSON.stringify(st, null, 2));
        if (st.startedAt) {
          const started = new Date(st.startedAt);
          const ageMin = Math.round((Date.now() - started.getTime()) / 60000);
          console.log(
            `\nlast start: ${st.startedAt} (${ageMin}m ago) — ${st.allConnected ? "✓ all connected" : "⚠ not all connected"}` +
              (st.stoppedAt ? `\nlast stop:  ${st.stoppedAt} (${st.stoppedReason})` : "\n(currently running)"),
          );
        }
      }
      break;
    }
    case "up":
      await cmdUp(args);
      break;
    case "connect":
      await cmdConnect(args);
      break;
    case "down":
      await cmdDown(args);
      break;
    case "setup":
    case "setup-interactive":
      await cmdSetupInteractive(args);
      break;
    case "install-dev":
      await cmdInstallDev(args);
      break;
    case "install":
      if (args.includes("--missing")) {
        const miss = profilesMissingExtension();
        console.log(`${miss.length} missing:`);
        for (const p of miss) console.log(`  ${p.dir.padEnd(10)} ${p.name}`);
      } else if (args.includes("--forcelist")) {
        console.log(JSON.stringify(enableForceInstall(), null, 2));
      } else if (args[0]) {
        const p = resolveProfile(args[0]);
        console.log(JSON.stringify(launchWithExtension(p.dir), null, 2));
      } else {
        console.error("usage: kwb install <profile> | --missing | --forcelist");
        process.exit(1);
      }
      break;
    default:
      console.error(
        "usage: kwb <doctor|profiles|resolve <q>|tabs <profile>|status|state|up <profile...>|connect <profile...>|down|install ...|setup <profile...>|install-dev <profile...>>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("kwb error:", e.message);
  process.exit(1);
});
