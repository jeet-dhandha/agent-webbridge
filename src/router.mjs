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
import { ROUTER_PORT, listProfiles, resolveProfile } from "./profiles.mjs";
import { daemonStatus, fleetStatus } from "./fleet.mjs";

const PORT = Number(process.env.KWB_ROUTER_PORT || ROUTER_PORT);

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

async function proxyCommand(bodyObj) {
  let port;
  let routedTo;
  if (bodyObj.profile) {
    const profile = resolveProfile(bodyObj.profile);
    port = profile.port;
    routedTo = `${profile.dir} (${profile.name})`;
  } else {
    port = await pickDefaultPort();
    routedTo = "default";
  }
  if (!port) {
    return { statusCode: 503, json: { ok: false, error: "no daemon available to route to" } };
  }
  const { profile, ...forward } = bodyObj; // strip our routing key
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
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
  console.log(`[kwb-router] listening on http://127.0.0.1:${PORT} (proxying /command by profile)`);
});
