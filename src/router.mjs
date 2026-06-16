// router.mjs — single front door on :10086 that fans /command out to the right
// per-profile daemon, so existing agent-webbridge callers keep working by just
// adding a top-level "profile" field.
//
//   POST /command  {action, args, session, profile?}
//     - profile present  -> resolve to its hashed port, strip "profile", proxy
//     - profile absent    -> route to the default profile (AWB_DEFAULT_PROFILE,
//                            else the last-used profile whose daemon is up)
//   GET  /status          -> aggregate fleet status (all profiles)
//   GET  /profiles        -> profile list with ports
//
// Extensions connect to their daemon's /ws DIRECTLY (ws://127.0.0.1:<port>/ws),
// NOT through this router — so the router only proxies HTTP.

import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { ROUTER_PORT, listProfiles, resolveProfile } from "./profiles.mjs";
import { daemonStatus, fleetStatus, stopDaemon, DAEMON_BIN } from "./fleet.mjs";
import { ROUTER_PID, patchState } from "./runstate.mjs";
import { focusProfileWindow } from "./extension.mjs";

const PORT = Number(process.env.AWB_ROUTER_PORT || ROUTER_PORT);

// Idle auto-shutdown: if no /command (a real "action") is routed for this many minutes,
// close the fleet by itself. 0 disables it. Default 120 (~2h). This stops only the local
// daemon PROCESSES — it never closes the user's browser tabs/windows (the extension simply
// disconnects). Set AWB_IDLE_NO_RESTORE to leave :10086 empty instead of restoring the
// stock single daemon (matches `awb down`).
const IDLE_MIN = Number(process.env.AWB_IDLE_TIMEOUT_MIN ?? 120);
const IDLE_MS = IDLE_MIN * 60_000;
const IDLE_RESTORE = !process.env.AWB_IDLE_NO_RESTORE;

let lastActivity = Date.now();
let shuttingDown = false;
const bump = () => (lastActivity = Date.now());

// Stop every fleet daemon (process only — leaves Chrome tabs untouched), optionally
// restore the stock :10086 daemon, record why we stopped, then exit. Same teardown as
// `awb down`, but initiated from inside the (idle) router itself.
async function idleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const idleMin = Math.round((Date.now() - lastActivity) / 60_000);
  console.log(`[awb-router] idle ${idleMin}m (limit ${IDLE_MIN}m) — closing the fleet daemons (browser tabs left open)`);
  try {
    for (const p of listProfiles()) {
      if (await daemonStatus(p.port)) {
        await stopDaemon(p); // daemon process only; does NOT close tabs
        console.log(`[awb-router] stopped daemon ${p.dir} (:${p.port}) — tabs left open`);
      }
    }
    if (IDLE_RESTORE) {
      try {
        execFileSync(DAEMON_BIN, ["start"], { stdio: "ignore" });
        console.log("[awb-router] restored stock :10086 daemon");
      } catch {}
    }
    try { patchState({ stoppedAt: new Date().toISOString(), stoppedReason: "idle", idleMinutes: idleMin }); } catch {}
  } catch (e) {
    console.log(`[awb-router] idle shutdown error: ${e.message}`);
  }
  // Remove the pid file only if it's OURS (guard against a stray router clobbering it).
  try {
    if (fs.readFileSync(ROUTER_PID, "utf8").trim() === String(process.pid)) fs.rmSync(ROUTER_PID, { force: true });
  } catch {}
  try { server.close(); } catch {}
  console.log("[awb-router] router exiting (idle)");
  process.exit(0);
}

if (IDLE_MIN > 0) {
  // Check at most once a minute (cheap), but more often for small timeouts so a short
  // AWB_IDLE_TIMEOUT_MIN (incl. fractional, e.g. 0.1 for tests) actually fires promptly.
  const everyMs = Math.min(60_000, Math.max(2_000, IDLE_MS));
  const timer = setInterval(() => {
    if (Date.now() - lastActivity >= IDLE_MS) idleShutdown();
  }, everyMs);
  timer.unref(); // don't keep the process alive solely for this check
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function pickDefaultPort() {
  const profiles = listProfiles();
  if (process.env.AWB_DEFAULT_PROFILE) {
    try {
      return resolveProfile(process.env.AWB_DEFAULT_PROFILE).port;
    } catch {}
  }
  // last-used first, then any up daemon with a connected extension, then any up
  const ordered = [...profiles].sort((a, b) => (b.isLastUsed ? 1 : 0) - (a.isLastUsed ? 1 : 0));
  let firstUp = null;
  for (const p of ordered) {
    const s = await daemonStatus(p.port);
    if (s) {
      firstUp ??= p.port;
      if (s.extension_connected) return p.port;
    }
  }
  return firstUp;
}

// Per-profile (per-port) concurrency limiter.
//
// The stock CWS extension executes one command at a time (its background.js funnels every
// tool call through one global commandQueue), so the router historically forced strict
// serialization per port too — that's why 10 tabs in one profile never ran in parallel.
//
// Our patched dev build (scripts/patch-extension-parallel.mjs) replaces that global queue
// with per-tab queues, so DIFFERENT tabs execute concurrently. We now allow up to
// AWB_PER_PROFILE_CONCURRENCY in-flight commands per profile and let the extension keep
// same-tab order.
//
// Safe for BOTH builds: a profile still on the UNPATCHED extension just serializes the
// concurrent commands inside its own global queue (no speed-up, but no corruption — the
// shared CDP cursor is never raced). Only the patched build actually parallelizes. Set
// AWB_PER_PROFILE_CONCURRENCY=1 to force the old strict-serial proxy behavior.
const PER_PROFILE_CONCURRENCY = Math.max(1, Number(process.env.AWB_PER_PROFILE_CONCURRENCY || 10));
const portSem = new Map(); // port -> { active, waiters: [] }

function acquirePort(port) {
  let s = portSem.get(port);
  if (!s) { s = { active: 0, waiters: [] }; portSem.set(port, s); }
  if (s.active < PER_PROFILE_CONCURRENCY) { s.active++; return Promise.resolve(); }
  return new Promise((resolve) => s.waiters.push(resolve));
}
function releasePort(port) {
  const s = portSem.get(port);
  if (!s) return;
  const next = s.waiters.shift();
  if (next) next();        // hand the held slot directly to the next waiter (active unchanged)
  else if (s.active > 0) s.active--;
}

async function proxyCommand(bodyObj) {
  let port;
  let routedTo;
  let extId = null;
  if (bodyObj.profile) {
    const profile = resolveProfile(bodyObj.profile);
    port = profile.port;
    routedTo = `${profile.dir} (${profile.name})`;
    extId = profile.extId;
  } else {
    port = await pickDefaultPort();
    routedTo = "default";
    if (port) {
      const p = listProfiles().find(x => x.port === port);
      if (p) extId = p.extId;
    }
  }
  if (!port) {
    return { statusCode: 503, json: { ok: false, error: "no daemon available to route to" } };
  }
  const { profile, ...forward } = bodyObj; // strip our routing key

  // Gate on the per-port limiter instead of a strict serial queue: up to
  // PER_PROFILE_CONCURRENCY commands to this profile run at once.
  await acquirePort(port);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 300000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forward),
      signal: ctl.signal,
    });
    const text = await r.text();
    return { statusCode: r.status, raw: text, routedTo, port };
  } catch (e) {
    return { statusCode: 502, json: { ok: false, error: `proxy to :${port} failed: ${e.message}`, routedTo } };
  } finally {
    clearTimeout(t);
    releasePort(port);
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj, raw) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(raw ?? JSON.stringify(obj));
  };
  try {
    if (req.method === "GET" && req.url.startsWith("/status")) {
      return send(200, { router: true, port: PORT, fleet: await fleetStatus() });
    }
    if (req.method === "GET" && req.url.startsWith("/profiles")) {
      return send(200, { profiles: listProfiles() });
    }
    if (req.method === "POST" && req.url.startsWith("/command")) {
      bump(); // a real action — reset the idle clock
      const body = await readBody(req);
      let obj;
      try {
        obj = JSON.parse(body || "{}");
      } catch {
        return send(400, { ok: false, error: "invalid JSON body" });
      }
      const result = await proxyCommand(obj);
      if (result.raw != null) return send(result.statusCode, null, result.raw);
      return send(result.statusCode, result.json);
    }
    return send(404, { ok: false, error: "not found", routes: ["POST /command", "GET /status", "GET /profiles"] });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const idle = IDLE_MIN > 0 ? `idle auto-shutdown after ${IDLE_MIN}m of no /command` : "idle auto-shutdown disabled";
  console.log(`[awb-router] listening on http://127.0.0.1:${PORT} (proxying /command by profile; up to ${PER_PROFILE_CONCURRENCY} concurrent/profile; ${idle})`);
});
