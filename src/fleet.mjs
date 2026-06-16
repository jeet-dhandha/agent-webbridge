// fleet.mjs — supervise one agent-webbridge daemon per Chrome profile.
//
// Each profile gets its own daemon on its hashed port, with its own HOME state
// dir so the daemons don't share a pid file / identity. The agent-webbridge CLI's
// stop/status are hardwired to :10086, so off-port daemons are managed here by
// POSTing /shutdown to their own port (with a PID-kill fallback).
//
// CRITICAL ordering constraint (proven): `agent-webbridge start` refuses to launch
// if ANYTHING answers http://127.0.0.1:10086/status — its singleton probe is
// hardcoded to :10086 regardless of --addr. So daemons MUST be started while
// :10086 is free; the router takes :10086 only AFTER the daemons are up.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTER_PORT, listProfiles, resolveProfile } from "./profiles.mjs";

// Default to OUR clean-room Node daemon (bin/agent-webbridge.mjs in this package),
// resolved relative to this file so it works in-checkout AND when installed via npm.
// AWB_DAEMON_BIN still overrides (e.g. to fall back to the legacy closed-source daemon binary).
const _PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/ -> package root
export const DAEMON_BIN =
  process.env.AWB_DAEMON_BIN || path.join(_PKG_ROOT, "bin", "agent-webbridge.mjs");
const STATE_ROOT = path.join(os.homedir(), ".agent-webbridge", "multi", "state");

function stateHome(dir) {
  return path.join(STATE_ROOT, dir.replace(/[^A-Za-z0-9_-]+/g, "_"));
}

async function httpGet(port, route, ms = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { signal: ctl.signal });
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Daemon /status on a given port, or null if not up.
export async function daemonStatus(port) {
  return httpGet(port, "/status", 2500);
}

export async function isPortUp(port) {
  return (await daemonStatus(port)) != null;
}

// Is :10086 currently occupied (by the legacy daemon OR our router)?
export async function routerPortBusy() {
  return isPortUp(ROUTER_PORT);
}

function pidFromState(dir) {
  try {
    const p = path.join(stateHome(dir), ".agent-webbridge", "daemon.pid");
    return parseInt(fs.readFileSync(p, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

// Start a daemon for one profile on its hashed port. Caller must ensure :10086
// is free first. Returns {profile, port, started, status}.
export async function startDaemon(profileQuery) {
  const profile = typeof profileQuery === "object" && profileQuery.port ? profileQuery : resolveProfile(profileQuery);
  if (await isPortUp(profile.port)) {
    return { profile, port: profile.port, started: false, status: await daemonStatus(profile.port), note: "already up" };
  }
  const home = stateHome(profile.dir);
  fs.mkdirSync(home, { recursive: true });
  // `start` self-backgrounds; HOME isolates its pid file / identity.
  execFileSync(DAEMON_BIN, ["start", "--addr", `127.0.0.1:${profile.port}`], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  // poll until /status answers
  let status = null;
  for (let i = 0; i < 20; i++) {
    status = await daemonStatus(profile.port);
    if (status) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { profile, port: profile.port, started: !!status, status };
}

// Stop a daemon by port (its own /shutdown), falling back to killing the PID.
export async function stopDaemon(profileQuery) {
  const profile = typeof profileQuery === "object" && profileQuery.port ? profileQuery : resolveProfile(profileQuery);
  let stopped = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    await fetch(`http://127.0.0.1:${profile.port}/shutdown`, { method: "POST", signal: ctl.signal });
    clearTimeout(t);
    stopped = true;
  } catch {}
  if (await isPortUp(profile.port)) {
    const pid = pidFromState(profile.dir);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        stopped = true;
      } catch {}
    }
  }
  return { profile: { dir: profile.dir, name: profile.name, port: profile.port }, stopped };
}

// Status of every profile's daemon (up?, extension connected?).
export async function fleetStatus() {
  const profiles = listProfiles();
  const out = [];
  for (const p of profiles) {
    const s = await daemonStatus(p.port);
    out.push({
      dir: p.dir,
      name: p.name,
      port: p.port,
      hasExtension: p.hasExtension,
      daemonUp: !!s,
      extensionConnected: s?.extension_connected ?? false,
      extensionId: s?.extension_id || null,
    });
  }
  return out;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "start" && arg) console.log(JSON.stringify(await startDaemon(arg), null, 2));
  else if (cmd === "stop" && arg) console.log(JSON.stringify(await stopDaemon(arg), null, 2));
  else if (cmd === "status") console.table(await fleetStatus());
  else {
    console.error("usage: node fleet.mjs <start <profile>|stop <profile>|status>");
    process.exit(1);
  }
}
