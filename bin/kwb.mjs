#!/usr/bin/env node
// kwb.mjs — one entry point for the kimi-webbridge multi-profile layer.
//
//   kwb profiles                 list profiles, hashed ports, ext presence, daemon up?
//   kwb resolve <query>          resolve a name/email/dir to one profile
//   kwb tabs <profile>           list a profile's NORMAL open tabs (from disk, no bridge)
//   kwb status                   fleet status (all profiles' daemons)
//   kwb up <profile...>          stop legacy :10086, start the named profiles' daemons,
//                                then start the router on :10086 (persistent)
//   kwb up --all-ext             bring up every profile that has the extension
//   kwb down [--no-restore]      stop router + all fleet daemons; restore legacy :10086
//   kwb install <profile>        cold-start that profile with --load-extension
//   kwb install --forcelist      enable CWS force-install across ALL profiles (needs Chrome restart)
//   kwb install --missing        list profiles lacking the extension
//
// After `kwb up`, point each profile's extension at its port ONCE via the
// extension popup's URL field (ws://127.0.0.1:<port>/ws). Then both profiles
// drive simultaneously.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProfiles, resolveProfile, ROUTER_PORT } from "../src/profiles.mjs";
import { listOpenTabs } from "../src/snss.mjs";
import { startDaemon, stopDaemon, fleetStatus, daemonStatus, KIMI_BIN } from "../src/fleet.mjs";
import {
  profilesMissingExtension,
  enableForceInstall,
  launchWithExtension,
} from "../src/extension.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(os.homedir(), ".kimi-webbridge", "multi", "run");
const ROUTER_PID = path.join(RUN, "router.pid");
fs.mkdirSync(RUN, { recursive: true });

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

function startRouter() {
  const child = spawn("node", [path.join(HERE, "..", "src", "router.mjs")], {
    detached: true,
    stdio: "ignore",
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
  console.log("\nNext: in each profile's Chrome, open the Kimi WebBridge popup → set the");
  console.log("daemon URL to its port, then Connect:");
  for (const p of targets) console.log(`    ${p.name.padEnd(18)} ws://127.0.0.1:${p.port}/ws`);
}

async function cmdDown(args) {
  const restore = !args.includes("--no-restore");
  console.log(killRouter() ? "• router stopped" : "• router not running");
  for (const p of listProfiles()) {
    if (await daemonStatus(p.port)) {
      await stopDaemon(p);
      console.log(`• stopped daemon: ${p.dir} "${p.name}" (:${p.port})`);
    }
  }
  await sleep(800);
  if (restore) {
    startLegacy();
    await sleep(1500);
    const s = await daemonStatus(ROUTER_PORT);
    console.log(`• legacy :${ROUTER_PORT} daemon ${s ? "restored" : "FAILED to restore"}`);
  }
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
            ext: p.hasExtension,
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
    case "up":
      await cmdUp(args);
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
        "usage: kwb <profiles|resolve <q>|tabs <profile>|status|up <profile...>|down|install ...>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("kwb error:", e.message);
  process.exit(1);
});
