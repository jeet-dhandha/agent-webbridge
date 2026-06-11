// router.mjs — single front door on :10086 that fans /command out to the right
// per-profile daemon, so existing kimi-webbridge callers keep working by just
// adding a top-level "profile" field.
//
//   POST /command  {action, args, session, profile?}
//     - profile present  -> resolve to its hashed port, strip "profile", proxy
//     - profile absent    -> route to the default profile (KWB_DEFAULT_PROFILE,
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
import { daemonStatus, fleetStatus, stopDaemon, KIMI_BIN } from "./fleet.mjs";
import { ROUTER_PID, patchState } from "./runstate.mjs";
import { focusProfileWindow } from "./extension.mjs";

const PORT = Number(process.env.KWB_ROUTER_PORT || ROUTER_PORT);

// Idle auto-shutdown: if no /command (a real "action") is routed for this many minutes,
// close the fleet by itself. 0 disables it. Default 120 (~2h). This stops only the local
// daemon PROCESSES — it never closes the user's browser tabs/windows (the extension simply
// disconnects). Set KWB_IDLE_NO_RESTORE to leave :10086 empty instead of restoring the
// stock single daemon (matches `kwb down`).
const IDLE_MIN = Number(process.env.KWB_IDLE_TIMEOUT_MIN ?? 120);
const IDLE_MS = IDLE_MIN * 60_000;
const IDLE_RESTORE = !process.env.KWB_IDLE_NO_RESTORE;

let lastActivity = Date.now();
let shuttingDown = false;
const bump = () => (lastActivity = Date.now());

// Stop every fleet daemon (process only — leaves Chrome tabs untouched), optionally
// restore the stock :10086 daemon, record why we stopped, then exit. Same teardown as
// `kwb down`, but initiated from inside the (idle) router itself.
async function idleShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const idleMin = Math.round((Date.now() - lastActivity) / 60_000);
  console.log(`[kwb-router] idle ${idleMin}m (limit ${IDLE_MIN}m) — closing the fleet daemons (browser tabs left open)`);
  try {
    for (const p of listProfiles()) {
      if (await daemonStatus(p.port)) {
        await stopDaemon(p); // daemon process only; does NOT close tabs
        console.log(`[kwb-router] stopped daemon ${p.dir} (:${p.port}) — tabs left open`);
      }
    }
    if (IDLE_RESTORE) {
      try {
        execFileSync(KIMI_BIN, ["start"], { stdio: "ignore" });
        console.log("[kwb-router] restored stock :10086 daemon");
      } catch {}
    }
    try { patchState({ stoppedAt: new Date().toISOString(), stoppedReason: "idle", idleMinutes: idleMin }); } catch {}
  } catch (e) {
    console.log(`[kwb-router] idle shutdown error: ${e.message}`);
  }
  // Remove the pid file only if it's OURS (guard against a stray router clobbering it).
  try {
    if (fs.readFileSync(ROUTER_PID, "utf8").trim() === String(process.pid)) fs.rmSync(ROUTER_PID, { force: true });
  } catch {}
  try { server.close(); } catch {}
  console.log("[kwb-router] router exiting (idle)");
  process.exit(0);
}

if (IDLE_MIN > 0) {
  // Check at most once a minute (cheap), but more often for small timeouts so a short
  // KWB_IDLE_TIMEOUT_MIN (incl. fractional, e.g. 0.1 for tests) actually fires promptly.
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
  if (process.env.KWB_DEFAULT_PROFILE) {
    try {
      return resolveProfile(process.env.KWB_DEFAULT_PROFILE).port;
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

const activeQueues = new Map(); // port -> Promise

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

  let queue = activeQueues.get(port) || Promise.resolve();
  let resolveLock;
  const lock = new Promise(r => resolveLock = r);
  activeQueues.set(port, lock);

  await queue;
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
    resolveLock();
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
  console.log(`[kwb-router] listening on http://127.0.0.1:${PORT} (proxying /command by profile; ${idle})`);
});
