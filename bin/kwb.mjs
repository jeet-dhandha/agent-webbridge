#!/usr/bin/env node
// kwb.mjs — one entry point for the kimi-webbridge multi-profile layer.
//
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
import path from "node:path";
import { listProfiles, resolveProfile, ROUTER_PORT } from "../src/profiles.mjs";
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
} from "../src/extension.mjs";
import { setLocalUrl, readLocalUrl } from "../src/storage.mjs";
import { RUN, ROUTER_PID, ROUTER_LOG, ensureRun, readState, writeState, patchState } from "../src/runstate.mjs";

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
      wakeExtension(p.dir, p.extId);
      console.log(`• opened + woke ${p.name} (${p.extType} ext)`);
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
async function cmdConnect(args) {
  const restore = args.includes("--restore");
  const targets = args.includes("--all-ext")
    ? listProfiles().filter((p) => p.hasExtension)
    : args.filter((a) => !a.startsWith("--")).map((q) => resolveProfile(q));
  if (!targets.length) {
    console.error("kwb connect: name at least one profile, or use --all-ext");
    process.exit(1);
  }
  if (isChromeRunning()) {
    console.log("• closing Chrome to edit extension storage (session is saved for restore)…");
    const q = quitChrome();
    if (!q.stopped) {
      console.error("could not quit Chrome — close it manually and retry");
      process.exit(1);
    }
    console.log(`• Chrome closed${q.forced ? " (forced)" : ""}`);
  }
  let ok = true;
  for (const p of targets) {
    const url = restore ? `ws://127.0.0.1:${ROUTER_PORT}/ws` : p.wsUrl;
    try {
      const r = setLocalUrl(p.dir, url);
      console.log(`✓ ${p.name.padEnd(18)} → ${url} (${r.mode})`);
    } catch (e) {
      ok = false;
      console.log(`✗ ${p.name.padEnd(18)} ${e.message}`);
    }
  }
  if (restore) console.log("\nRestored to the stock :10086 bridge. Reopen Chrome to reconnect.");
  else console.log(`\nNext:  kwb up ${targets.map((p) => `'${p.dir}'`).join(" ")}`);
  process.exit(ok ? 0 : 1);
}

async function cmdDown(args) {
  const restore = !args.includes("--no-restore");
  console.log(killRouter() ? "• router stopped" : "• router not running");
  // Stops daemon PROCESSES only — the extensions disconnect but Chrome tabs stay open.
  for (const p of listProfiles()) {
    if (await daemonStatus(p.port)) {
      await stopDaemon(p);
      console.log(`• stopped daemon: ${p.dir} "${p.name}" (:${p.port}) — tabs left open`);
    }
  }
  await sleep(800);
  if (restore) {
    startLegacy();
    await sleep(1500);
    const s = await daemonStatus(ROUTER_PORT);
    console.log(`• legacy :${ROUTER_PORT} daemon ${s ? "restored" : "FAILED to restore"}`);
  }
  try { patchState({ stoppedAt: new Date().toISOString(), stoppedReason: "manual" }); } catch {}
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
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
      const res = listOpenTabs(args[0]);
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
        "usage: kwb <profiles|resolve <q>|tabs <profile>|status|state|up <profile...>|connect <profile...>|down|install ...>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("kwb error:", e.message);
  process.exit(1);
});
