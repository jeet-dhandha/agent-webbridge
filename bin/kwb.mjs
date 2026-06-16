#!/usr/bin/env node
// kwb.mjs — one entry point for the agent-webbridge multi-profile layer.
// (Installed as `awb`, with `kwb` kept as a back-compat alias.)
//
//   awb doctor                   read-only environment self-check (Chrome, daemon
//                                binary, profiles, extension, :10086) — run FIRST
//   awb check <profile...>       machine-readable readiness (folder? dev-mode?
//                                loaded? connected?) — what an agent polls; --json
//   awb profiles                 list profiles, hashed ports, ext presence, daemon up?
//   awb resolve <query>          resolve a name/email/dir to one profile
//   awb tabs <profile>           list a profile's NORMAL open tabs (from disk, no bridge)
//   awb status                   fleet status (all profiles' daemons)
//   awb state                    last recorded start (time, per-profile connected) + stop
//   awb connect <profile...>     point each profile's extension at its daemon by
//                                editing storage.local on disk (no popup, no click);
//                                closes Chrome to write, then you `awb up`
//   awb connect <p...> --restore point them back at the stock :10086 bridge
//   awb up <profile...>          stop legacy :10086, start the named profiles' daemons,
//                                start the router on :10086, auto-connect (if Chrome is
//                                closed), open each window AND WAKE its extension, then
//                                poll until each reports connected
//   awb up --all-ext             bring up every profile that has the extension
//   awb up --no-open             start daemons + router only; don't open windows
//   awb up --no-connect          don't touch storage.local; just open windows
//   awb down [--no-restore]      stop router + all fleet daemons; restore legacy :10086
//                                (stops daemon processes only — never closes browser tabs)
//
// Idle auto-close: the router stops the fleet itself after KWB_IDLE_TIMEOUT_MIN minutes
// (default 120) with no /command — daemon processes only, browser tabs left open. The
// last start/stop is recorded in run/fleet-state.json (see `awb state`).
//   awb setup <profile...>       canonical install: open chrome://extensions, print the
//                                exact agent-webbridge-extension/ folder to "Load unpacked",
//                                POLL until it lands, then connect + bring the fleet up.
//                                No Chrome Web Store — agent-webbridge ships only as an
//                                unpacked build. --reinstall / --no-open / --no-up / --timeout.
//   awb install --missing        list profiles lacking the extension
//   awb install-dev <profile...> DEV iterate loop: chrome://extensions handoff, then a
//                                Reload-the-dev-card step for iterating on background.js.
//                                A CORRUPT extension (disabled / stale unpacked path /
//                                missing payload / orphaned files) is auto-removed on
//                                disk first, then reinstalled clean; --reinstall forces
//                                that removal even for a healthy build.
//                                --no-open / --no-reload / --reinstall tweak the flow.
//
// Zero-click connect has TWO halves, both pure Node / no deps / no CDP:
//   1. WRITE the URL: the extension's daemon URL is a plain `local_url` key in its
//      storage.local LevelDB (NOT integrity-protected). `awb connect` writes it directly
//      while Chrome is closed, replacing the manual popup click. The value persists.
//   2. WAKE the worker: the MV3 service worker only re-reads local_url when it
//      STARTS, but it registers no onStartup listener, so Chrome never auto-starts it on
//      launch — the write alone does nothing on an already-set-up profile. `awb up` wakes
//      it by opening the extension's own popup page as a tab (see extension.mjs
//      wakeExtension), which is the headful equivalent of clicking the toolbar icon.
// (CDP can't do either on real profiles: branded Chrome 136+ blocks remote-debugging on
// the default user-data-dir where real profiles live.)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProfiles, resolveProfile, kimiExtId, developerModeOn, ROUTER_PORT } from "../src/profiles.mjs";
import { listOpenTabs } from "../src/snss.mjs";
import { startDaemon, stopDaemon, fleetStatus, daemonStatus, KIMI_BIN } from "../src/fleet.mjs";
import {
  profilesMissingExtension,
  launchWithExtension,
  openChromeProfile,
  wakeExtension,
  isChromeRunning,
  quitChrome,
  launchChrome,
  cleanupAnnoyingTabs,
  closeBlankWindows,
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

const EXTENSION_INSTALL_POLL_MS = 5000;       // check every 5 seconds
const EXTENSION_INSTALL_TIMEOUT_MS = 300000;  // for up to 5 minutes

// This tool is macOS + Google Chrome only. The `open`, `pgrep`, `defaults`
// commands and the ~/Library/Application Support/Google/Chrome paths are
// macOS-specific; Linux/Windows support would need the path + launcher helpers
// changed. Warn loudly rather than misbehave silently.
if (process.platform !== "darwin") {
  console.error(
    `⚠️  agent-webbridge currently supports macOS + Google Chrome only ` +
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
    console.error("awb up: name at least one profile, or use --all-ext");
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
  // skip it here and tell the user to run `awb connect` (which closes Chrome).
  if (!args.includes("--no-connect")) {
    const mismatched = targets.filter((p) => readLocalUrl(p.dir) !== p.wsUrl);
    if (mismatched.length && isChromeRunning()) {
      console.log(`\nℹ ${mismatched.length} profile(s) not yet pointed at their daemon. Chrome is`);
      console.log("  running, so their on-disk storage can't be edited. Set them up with:");
      console.log(`    awb connect ${mismatched.map((p) => `'${p.dir}'`).join(" ")}`);
      console.log("  (closes Chrome, writes the URLs) then re-run this `awb up`.\n");
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
    // Force a FRESH reconnect rather than trusting a possibly-stale "already connected"
    // state. A daemon can keep a zombie extension socket — it reports connected:true, but
    // the worker behind it is dead or serving old code (e.g. after an MV3 suspend/wake or
    // an extension reload), so commands like list_tabs hang or return stale data, and a
    // plain `awb up` used to no-op ("already connected") and never displace it. Now we:
    //   1. ask the daemon to drop its current socket (POST /reconnect), and
    //   2. wake the service worker (opens the extension popup as a background tab),
    // so the LIVE worker re-handshakes into the slot (adoptSocket = newest-wins evicts the
    // stale one). A dormant worker won't notice a dropped socket on its own — hence the
    // wake; the popup tab is cleaned up by cleanupAnnoyingTabs once connected.
    if (!noConnect && p.extId) {
      const r = await daemonReconnect(p.port);
      wakeExtension(p.dir, p.extId);
      const note =
        r.reason === "unreachable"
          ? " (daemon unreachable — woke anyway)"
          : r.reason === "unsupported"
            ? " (daemon predates /reconnect — restart it to enable single-step recovery)"
            : r.dropped
              ? " (dropped a bound socket)"
              : "";
      console.log(`• forced reconnect + woke ${p.name} (${p.extType} ext)${note}`);
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
    // Close the wake popup tab whether or not the poll saw "connected" — the wake always
    // opens it, and waiting on `connected` could otherwise orphan it on a slow handshake.
    // cleanupAnnoyingTabs is a best-effort AppleScript no-op when there's no popup tab.
    if (p.extId) cleanupAnnoyingTabs(p.extId);
  }

  // Record the last start so we can later confirm everything came up (awb state).
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
  console.log(`• recorded start @ ${startedAt} — ${okCount}/${connections.length} connected (awb state)`);
}

// Ask a daemon to drop its currently bound extension socket (POST /reconnect) so a
// stale/zombie connection is displaced and the live worker can re-handshake. Best-effort:
// returns the parsed { ok, dropped } body, or null if the daemon is unreachable or too old
// to have the endpoint (a pre-/reconnect daemon 404s — restart it to pick up the route).
async function daemonReconnect(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/reconnect`, { method: "POST", signal: ctl.signal });
    // A daemon that predates this endpoint 404s (route falls through to "not found").
    if (!r.ok) return { ok: false, reason: "unsupported" };
    return { ok: true, ...(await r.json()) }; // { ok, dropped }
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(t);
  }
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

// `awb connect <profiles...> [--restore]` — point each profile's extension at its
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
      console.error("awb connect: name at least one profile, or use --all-ext");
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
  else console.log(`\nNext:  awb up ${targets.map((p) => `'${p.dir}'`).join(" ")}`);
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

// `awb setup <profile...>` — the canonical, Load-unpacked install for the agent-webbridge
// extension. There is NO Chrome Web Store listing; the only honest way onto a real Chrome
// profile is a manual "Load unpacked" in chrome://extensions with Developer mode on. This
// command makes that one-click-for-a-human / one-poll-for-an-agent:
//   1. RESOLVE the in-repo extension folder + its stable id (fail fast on a bad checkout).
//   2. REPAIR — remove a corrupt install (or, with --reinstall, a healthy one) from disk,
//      Chrome closed, so the fresh load lands clean.
//   3. INSTALL — for each profile still missing it, open chrome://extensions and print the
//      exact folder to "Load unpacked", then POLL the registry every 5s (up to --timeout,
//      default 5min) until the extension appears. No blocking Enter — the poll is exactly
//      what an orchestrating agent watches (see `awb check --json`).
//   4. WIRE each profile to its daemon and bring the fleet up (skip with --no-up).
//
//   --reinstall   remove the current extension from disk first, then reload clean
//   --no-open     don't open chrome://extensions (you / your agent drive the browser); just poll
//   --no-up       stop once the extension is loaded; don't connect + start the fleet
//   --timeout N   seconds to wait for each Load-unpacked (default 300)
async function cmdSetupInteractive(args) {
  const reinstall = args.includes("--reinstall");
  const noOpen = args.includes("--no-open");
  const noUp = args.includes("--no-up");
  const tIdx = args.indexOf("--timeout");
  const timeoutMs =
    tIdx >= 0 && args[tIdx + 1] ? Math.max(5, parseInt(args[tIdx + 1], 10) || 300) * 1000 : EXTENSION_INSTALL_TIMEOUT_MS;
  const targets = args
    .filter((a, i) => !a.startsWith("--") && !(tIdx >= 0 && i === tIdx + 1))
    .map((q) => resolveProfile(q));
  if (!targets.length) {
    console.error("usage: awb setup <profile...> [--reinstall] [--no-open] [--no-up] [--timeout <seconds>]");
    console.error("  Installs the agent-webbridge extension via Chrome 'Load unpacked' (there is no Chrome");
    console.error("  Web Store listing), then wires each profile to its daemon and brings the fleet up.");
    process.exit(1);
  }

  // 1. Resolve the in-repo extension folder + its stable id up front so a bad checkout fails
  //    fast, before we touch Chrome. The id is derived from the manifest `key`, so the
  //    Load-unpacked build's id == the published stable id.
  let extPath, extId;
  try {
    extPath = unpackedExtPath();
    extId = devBuildExtId();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  console.log(`• extension folder to Load unpacked: ${extPath}`);
  console.log(`• extension id (stable, from manifest.key): ${extId}\n`);

  // 2. Repair pass — remove a corrupt install (or, with --reinstall, any install) from disk
  //    with Chrome closed, so the fresh Load unpacked lands clean.
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
      console.log(`• "${p.name}": not installed yet.`);
    }
  }
  if (removals.length) {
    if (isChromeRunning()) {
      console.log("• closing Chrome to remove extension artifacts on disk (session saved for restore)…");
      const q = quitChrome();
      if (!q.stopped) {
        console.error("✗ could not quit Chrome — close it manually and re-run `awb setup`.");
        process.exit(1);
      }
      console.log(`• Chrome closed${q.forced ? " (forced)" : ""}`);
    }
    for (const { p, extId: rid } of removals) {
      const r = removeExtensionOnDisk(p.dir, rid);
      console.log(
        r.ok
          ? `  ✓ ${p.name}: removed ${r.removed.length} on-disk item(s)${r.removed.length ? ` — ${r.removed.join(", ")}` : ""}`
          : `  ✗ ${p.name}: ${r.error || (r.errors || []).join("; ")}`,
      );
    }
  }

  // 3. Install pass — for each profile still missing the extension, open chrome://extensions
  //    and poll the registry until "Load unpacked" lands it. Detection is registry-based
  //    (kimiExtId): unpacked builds run from their source dir and never land in Extensions/,
  //    so the registry is the ONLY source that sees them.
  for (const p of targets) {
    if (kimiExtId(p.dir)) {
      console.log(`• "${p.name}": extension already present — skipping install.`);
      continue;
    }
    const dm = developerModeOn(p.dir);
    const dmNote = dm === true ? " — already on ✓" : dm === false ? " — currently OFF" : "";
    console.log(`\n👉 "${p.name}" (${p.dir}) — install the extension:`);
    console.log(`     1. Toggle "Developer mode" ON (top-right of chrome://extensions)${dmNote}.`);
    console.log(`     2. Click "Load unpacked".`);
    console.log(`     3. Select this folder:  ${extPath}`);
    console.log(`   (No Enter needed — this command auto-detects the load and continues.)`);
    if (!noOpen) {
      const r = openUrlInProfile({ profileDir: p.dir, windowId: null, url: "chrome://extensions" });
      console.log(`   ↪ opened chrome://extensions in "${p.name}" (mode=${r.mode}${r.error ? `, error=${r.error}` : ""})`);
    }

    const deadline = Date.now() + timeoutMs;
    let installed = false;
    let tick = 0;
    while (Date.now() < deadline) {
      await sleep(EXTENSION_INSTALL_POLL_MS);
      if (kimiExtId(p.dir)) { installed = true; break; }
      if (tick++ % 4 === 0) {
        const remain = Math.round((deadline - Date.now()) / 1000);
        const dmNow = developerModeOn(p.dir);
        const hint = dmNow === false ? " (Developer mode still OFF — toggle it to reveal 'Load unpacked')" : "";
        console.log(`   …waiting for Load unpacked (${remain}s left, every ${EXTENSION_INSTALL_POLL_MS / 1000}s)${hint}`);
      }
    }
    if (!installed) {
      console.error(`✗ "${p.name}": extension not loaded within ${timeoutMs / 1000}s. Re-run \`awb setup "${p.name}"\` after Load unpacked.`);
      process.exit(1);
    }
    console.log(`  ✓ "${p.name}": extension detected (id ${kimiExtId(p.dir)}).`);
  }

  if (noUp) {
    console.log("\n• --no-up set; extension installed. Run `awb connect <profile...>` then `awb up <profile...>` when ready.");
    return;
  }

  // 4. Wire each profile to its daemon (cmdConnect quits Chrome once, writes local_url) and
  //    bring the fleet up.
  console.log("\n• connecting + starting the fleet…");
  const connectRes = await cmdConnect(targets.map((p) => p.dir), { exitOnDone: false });
  if (!connectRes.ok) {
    console.error("✗ storage.local write failed for one or more profiles — not starting the fleet.");
    process.exit(1);
  }
  await cmdUp(targets.map((p) => p.dir));
}

// `awb install-dev <profile...>` — guided dev-build install + iterate loop.
//
// This is the DEVELOPER tool (iterate on background.js / popup.html with a Reload
// loop). For a plain install, `awb setup` is the canonical, poll-based path.
//
// 1. There is no Chrome Web Store step. For each target, go straight to the
//    chrome://extensions handoff.
// 2. The user can abort with Ctrl-C or by typing "q" + Enter; either path runs
//    `awb down --no-restore` so any daemon / router we may have started in a
//    previous step is reaped and :10086 stays free.
// 3. Open chrome://extensions for the profile and prompt the user to (a) flip on
//    Developer mode and (b) click "Load unpacked" → pick `agent-webbridge-extension/`.
//    The unpacked build's id equals the published stable id (it's derived from the
//    manifest `key`), so `awb profiles` reports the same id either way.
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
//    can roll back an in-flight Secure Preferences write (a prior bug: the
//    install was detected during the poll, but our quitChrome force-killed
//    Chrome before the write flushed, so the entry vanished on next start).
//    Chrome stays open from the user's first click all the way through the
//    Reload handoff; cmdConnect is the single authoritative quit.
//
// `--no-reload` skips phase 3.5 entirely. Use on the very first run, before
// Load unpacked has ever been done — there's nothing to Reload yet.
//
// `--no-open` stops after phase 4's connect step; the user runs `awb up`
// themselves.
async function cmdInstallDev(args) {
  const noOpen = args.includes("--no-open");
  const noReload = args.includes("--no-reload");
  const reinstall = args.includes("--reinstall");
  const targets = args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  if (!targets.length) {
    console.error("usage: awb install-dev <profile...> [--no-open] [--no-reload] [--reinstall]");
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
        console.error("✗ could not quit Chrome — close it manually and re-run `awb install-dev`.");
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
    console.log("\n⚠ Ctrl-C received — aborting and running `awb down --no-restore`…");
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
    console.log("• running `awb down --no-restore` to release :10086 + any daemons");
    try { await cmdDown(["--no-restore"]); } catch (e) { console.error(`  awb down failed: ${e.message}`); }
    process.exit(2);
  };

  // 2. For each target: go straight to the chrome://extensions Load-unpacked handoff. There
  //    is no Chrome Web Store step — agent-webbridge ships only as an unpacked build, so
  //    "not installed yet" is the normal first-run state, not an error.
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    console.log(`\n👉 [${i + 1}/${targets.length}] profile "${p.name}" (${p.dir}) → :${p.port}`);

    // Fresh read of the registry — kimiExtId re-parses the same Chrome file each call.
    const installed = !!kimiExtId(p.dir);
    // windowId anchors the chrome://extensions + Reload tabs into one window per profile.
    let windowId = null;
    console.log(
      installed
        ? `• extension already present in "${p.name}" — opening chrome://extensions to Reload the dev build.`
        : `• extension not loaded in "${p.name}" — opening chrome://extensions to Load unpacked.`,
    );

    // 3. chrome://extensions handoff — user flips Developer mode on, clicks
    //    "Load unpacked", and picks the dev build folder. We open the
    //    chrome://extensions tab in a fresh window for the profile (windowId
    //    is null on first run), so the user sees one window for the whole wizard.
    console.log(`\n  → Opening chrome://extensions for "${p.name}". Please:`);
    console.log(`      1. Toggle the "Developer mode" switch ON (top-right).`);
    console.log(`      2. Click "Load unpacked".`);
    console.log(`      3. Select this folder: ${extPath}`);
    console.log(`      4. After "Agent WebBridge" appears in the list, press Enter here to continue.`);
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
      console.log(`     → If the "Agent WebBridge" card is missing: you haven't Load unpacked yet —`);
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
    console.log("\n• --no-open set; not starting the fleet. Run `awb up <profile...>` when you're ready.");
    return;
  }

  // 4. Chrome is still open from the handoffs (good — we want the user's Load unpacked
  //    + Reload clicks to have flushed to Secure Preferences before we touch anything
  //    destructive). Now: do the daemon-URL write in a single atomic step by calling
  //    cmdConnect with exitOnDone:false. cmdConnect quits Chrome → writes local_url →
  //    returns. Then bring the fleet up. This is the same flow the rest of the fleet
  //    uses (awb up's mismatch path), composed not duplicated, so a future change to
  //    the connect flow (e.g. a different quit strategy) lands in one place.
  console.log("\n• writing daemon URL into storage.local (via cmdConnect, which quits Chrome)…");
  const connectRes = await cmdConnect(targets.map((p) => p.dir), { exitOnDone: false });
  if (!connectRes.ok) {
    console.error("✗ storage.local write failed for one or more profiles — not starting the fleet.");
    console.error("  re-run `awb install-dev` (or `awb connect` then `awb up`) once the issue is resolved.");
    process.exit(1);
  }
  console.log("\n• starting the fleet…");
  await cmdUp(targets.map((p) => p.dir));
}

// `awb check [profile...] [--json]` — machine-readable install readiness, the thing an
// orchestrating agent polls while it walks the user through "Load unpacked". For each
// profile it answers the four questions the agent needs: is the in-repo extension FOLDER
// present (so there's something to load)? is Developer MODE on? is the extension LOADED +
// enabled? is the daemon UP and the extension CONNECTED to it? Each profile gets a single
// `ready` boolean and a `nextStep` hint so the agent always knows the one thing to do next.
// Read-only: never opens Chrome, never starts a daemon.
async function cmdCheck(args) {
  const json = args.includes("--json");
  const queries = args.filter((a) => !a.startsWith("--"));

  // The in-repo extension folder is a precondition for everything else (nothing to load
  // without it). Resolve it once; a bad checkout makes every profile un-installable.
  let extPath = null;
  let extId = null;
  let folderPresent = false;
  try {
    extPath = unpackedExtPath();
    extId = devBuildExtId();
    folderPresent = true;
  } catch (e) {
    extPath = e.message;
  }

  const all = listProfiles();
  const selected = queries.length ? queries.map((q) => resolveProfile(q)) : all;

  const rows = [];
  for (const p of selected) {
    const dm = developerModeOn(p.dir); // true | false | null(unknown)
    const loaded = !!p.hasExtension;
    const enabled = !!p.extEnabled;
    const s = await daemonStatus(p.port);
    const daemonUp = !!s;
    const connected = s?.extension_connected ?? false;
    const ready = folderPresent && loaded && enabled && daemonUp && connected;

    // The single next action for this profile, in dependency order.
    let nextStep;
    if (!folderPresent) nextStep = "extension folder missing — reinstall the npm package (agent-webbridge-extension/ is absent)";
    else if (!loaded) nextStep = dm === false
      ? "enable Developer mode in chrome://extensions, then Load unpacked the extension folder"
      : `Load unpacked the extension folder: ${extPath}  (run \`awb setup "${p.name}"\` to be walked through it)`;
    else if (!enabled) nextStep = `enable the agent-webbridge extension in chrome://extensions for "${p.name}"`;
    else if (!daemonUp) nextStep = `start the fleet: \`awb up "${p.name}"\``;
    else if (!connected) nextStep = `extension loaded but not connected — \`awb connect "${p.name}"\` then \`awb up "${p.name}"\``;
    else nextStep = null; // ready

    rows.push({
      name: p.name,
      dir: p.dir,
      port: p.port,
      developerMode: dm,
      loaded,
      enabled,
      extType: p.extType,
      daemonUp,
      connected,
      ready,
      nextStep,
    });
  }

  // Exit 0 only when there's at least one profile AND every one is ready — so an agent
  // polling `--json` can't read an empty/zero-profile result as "ready" (an empty array
  // makes rows.every(...) vacuously true). Same gate as the text path below.
  const allReady = rows.length > 0 && rows.every((r) => r.ready);

  if (json) {
    console.log(JSON.stringify({ extensionFolder: { present: folderPresent, path: extPath, id: extId }, profiles: rows }, null, 2));
    return allReady ? 0 : 1;
  }

  console.log("agent-webbridge — readiness check\n");
  console.log(`  extension folder : ${folderPresent ? "✓ present" : "✗ MISSING"}  ${extPath}${extId ? `  (id ${extId})` : ""}\n`);
  const fmt = (v) => (v === true ? "yes" : v === false ? "no" : "—");
  for (const r of rows) {
    const dmStr = r.developerMode === true ? "on" : r.developerMode === false ? "off" : "?";
    console.log(
      `  ${r.ready ? "✓" : "✗"} "${r.name}" (${r.dir} :${r.port}) — dev-mode:${dmStr} loaded:${fmt(r.loaded)} enabled:${fmt(r.enabled)} daemon:${r.daemonUp ? "up" : "down"} connected:${fmt(r.connected)}`,
    );
    if (r.nextStep) console.log(`      ↳ next: ${r.nextStep}`);
  }
  const ready = rows.filter((r) => r.ready).length;
  console.log(`\n${ready}/${rows.length} profile(s) ready.`);
  return allReady ? 0 : 1;
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
    case "groups": {
      // List live tabs grouped by their session tab-group, so you can spot stray
      // "agent:*" groups (e.g. left by a crashed run) and prune them. Talks to the
      // daemon (group titles only exist there), unlike `tabs` which reads SNSS.
      const profileQuery = args.find((a) => !a.startsWith("--"));
      const body = { action: "list_tabs", args: {} };
      if (profileQuery) body.profile = profileQuery;
      const r = await fetch(`http://127.0.0.1:${ROUTER_PORT}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((x) => x.json())
        .catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) {
        console.error("groups: " + (r.error || "failed — is the fleet up? (`awb up`)"));
        process.exit(1);
      }
      const groups = {};
      for (const t of r.tabs || []) {
        const g = t.groupTitle || "(no group)";
        (groups[g] = groups[g] || []).push(t);
      }
      const names = Object.keys(groups);
      if (!names.length) {
        console.log("no open tabs");
        break;
      }
      for (const g of names) {
        const sess = g.startsWith("agent:") ? g.slice(6) : null;
        console.log(`\n${g}  — ${groups[g].length} tab(s)` + (sess ? `   → close with: awb close ${sess}` : ""));
        for (const t of groups[g]) console.log(`   [${t.tabId}] ${(t.url || "").slice(0, 90)}`);
      }
      break;
    }
    case "close": {
      // Close a session's whole tab-group (housekeeping for stray/temporary sessions).
      const session = args.find((a) => !a.startsWith("--"));
      if (!session) {
        console.error("usage: awb close <session> [profile]   (session = the part after 'agent:' shown by `awb groups`)");
        process.exit(1);
      }
      const profileQuery = args.filter((a) => a !== session && !a.startsWith("--"))[0];
      const body = { action: "close_session", args: {}, session };
      if (profileQuery) body.profile = profileQuery;
      const r = await fetch(`http://127.0.0.1:${ROUTER_PORT}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((x) => x.json())
        .catch((e) => ({ ok: false, error: e.message }));
      console.log(r.ok ? `closed session "${session}" (${r.closed} tab(s))` : "close failed: " + (r.error || "?"));
      break;
    }
    case "status":
      console.table(await fleetStatus());
      break;
    case "state": {
      const st = readState();
      if (!st) {
        console.log("no fleet state recorded yet — run `awb up`");
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
    case "check":
      process.exit(await cmdCheck(args));
      break;
    case "setup":
    case "setup-interactive":
      await cmdSetupInteractive(args);
      break;
    case "install-dev":
      await cmdInstallDev(args);
      break;
    case "install":
      // NOTE: the old `--forcelist` (CWS ExtensionInstallForcelist policy) was removed with
      // the pivot — there is no Chrome Web Store listing, so the policy could only pin
      // profiles into a broken "managed"/failed-install state. Use `awb setup` (Load unpacked).
      if (args.includes("--missing")) {
        const miss = profilesMissingExtension();
        console.log(`${miss.length} missing:`);
        for (const p of miss) console.log(`  ${p.dir.padEnd(10)} ${p.name}`);
      } else if (args[0] && !args[0].startsWith("--")) {
        const p = resolveProfile(args[0]);
        console.log(JSON.stringify(launchWithExtension(p.dir), null, 2));
      } else {
        console.error("usage: awb install <profile> | --missing   (to install the extension, use `awb setup <profile>`)");
        process.exit(1);
      }
      break;
    default:
      console.error(
        "usage: awb <doctor|check [profile...] [--json]|profiles|resolve <q>|tabs <profile>|groups [profile]|close <session> [profile]|status|state|up <profile...>|connect <profile...>|down|install ...|setup <profile...>|install-dev <profile...>>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("awb error:", e.message);
  process.exit(1);
});
