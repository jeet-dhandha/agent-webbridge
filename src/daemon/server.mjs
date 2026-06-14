// server.mjs — the per-profile daemon's HTTP front door + WS hub wiring.
//
// One tiny http server per daemon:
//   GET  /status   -> liveness + extension-connection snapshot (probe + fleet read this)
//   POST /shutdown -> graceful stop (router/`stop` use this)
//   POST /command  -> the real work: forward {action,args,session} to the connected
//                     extension over WS, then shape the reply into the HTTP envelope.
//
// All transport/quirk knowledge lives in the imported modules — this file just glues
// the WS hub, the response envelope, and the disk writer together.

import http from "node:http";
import { createWsHub } from "./wshub.mjs";
import { shapeResponse } from "./envelope.mjs";
import { writeCapture } from "./diskwriter.mjs";
import { registry, statusFields } from "./registry.mjs";
import { getVersion, uptimeSeconds } from "./lifecycle.mjs";

// Collect a request body to a string (we only ever expect small JSON here).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function startServer({ host = "127.0.0.1", port } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status") {
        sendJson(res, 200, {
          running: true,
          port,
          version: getVersion(),
          ...statusFields(),
          uptime_seconds: uptimeSeconds(),
        });
        return;
      }

      if (req.method === "POST" && req.url === "/shutdown") {
        sendJson(res, 200, { ok: true });
        try { hub.close(); } catch {}
        try { server.close(); } catch {}
        setTimeout(() => process.exit(0), 50);
        return;
      }

      if (req.method === "POST" && req.url === "/reconnect") {
        // Force-drop the bound extension socket so a stale/zombie connection is
        // displaced; the live worker then re-handshakes (`awb up` waking it). This is
        // what lets `awb up` alone recover a daemon stuck talking to a dead worker,
        // without a full `awb down && awb up`.
        const dropped = hub.forceReconnect();
        sendJson(res, 200, { ok: true, dropped });
        return;
      }

      if (req.method === "POST" && req.url === "/command") {
        try {
          const raw = await readBody(req);
          const { action, args, session } = raw ? JSON.parse(raw) : {};
          const payload = await hub.callTool(action, args || {}, { session });
          // Capture tools come back with base64 data; the daemon (not the extension)
          // owns the disk write, then the envelope reports the on-disk file.
          if (
            !payload.error &&
            (action === "screenshot" || action === "save_as_pdf") &&
            payload.data
          ) {
            payload.data = await writeCapture(action, payload.data, args || {});
          }
          sendJson(res, 200, shapeResponse(action, payload));
        } catch (e) {
          sendJson(res, 200, { ok: false, error: e.message });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message });
    }
  });

  // Wire the WS hub onto the http server BEFORE listening so the 'upgrade' handler
  // is registered for the very first extension connection.
  const hub = createWsHub(server);

  server.listen(port, host);

  return { server, hub };
}

// Mark the registry import as used (kept for explicit dependency wiring/clarity).
void registry;
