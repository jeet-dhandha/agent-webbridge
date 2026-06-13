// wshub.mjs — the daemon's WebSocket hub that owns the single extension slot.
//
// Attaches a WebSocketServer (noServer mode) to the daemon's http server and
// handles the 'upgrade' for the "/ws" path only. Exactly one extension may be
// connected at a time: the newest connection wins and the previous socket is
// terminated. Commands flow daemon -> extension as {type:"tool_call",...} and
// results come back keyed by responseToRequestId; we correlate them through a
// pending Map. A 20s ping keepalive drops sockets that miss two pongs.
//
// callTool ALWAYS resolves — transport failures (no extension, timeout) come
// back as { error: "fetch failed: ..." } rather than throwing, so the HTTP
// layer can shape them uniformly.

import { WebSocketServer } from "ws";
import { registry } from "./registry.mjs";

const PING_INTERVAL_MS = 20000;
const MAX_MISSED_PONGS = 2;

export function createWsHub(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // The single live extension socket (or null).
  let socket = null;
  // requestId -> { resolve, timer }
  const pending = new Map();
  // monotonically increasing request id
  let nextRequestId = 1;

  // Route only "/ws" upgrades to our WebSocketServer; ignore everything else.
  function onUpgrade(req, sock, head) {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url || "/";
    }
    if (pathname !== "/ws") {
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
  httpServer.on("upgrade", onUpgrade);

  function adoptSocket(ws) {
    // Newest connection replaces the older one.
    if (socket && socket !== ws) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }
    socket = ws;
    ws._missedPongs = 0;
    ws._alive = true;
  }

  function dropSocket(ws) {
    if (socket === ws) {
      socket = null;
      registry.setDisconnected ? registry.setDisconnected() : setDisconnectedFallback();
    }
  }

  // registry exposes setDisconnected/setConnected as named exports too; we import
  // the object and call through it defensively.
  function setDisconnectedFallback() {
    registry.connected = false;
    registry.extensionId = null;
    registry.extensionVersion = null;
  }

  wss.on("connection", (ws) => {
    adoptSocket(ws);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      switch (msg.type) {
        case "hello": {
          const payload = msg.payload || {};
          setConnected(payload);
          send(ws, { type: "hello_ack" });
          break;
        }
        case "pong": {
          ws._missedPongs = 0;
          ws._alive = true;
          break;
        }
        case "tool_result": {
          const id = msg.responseToRequestId;
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            clearTimeout(entry.timer);
            // payload is uniform {data} | {error}
            entry.resolve(msg.payload || { error: "fetch failed: empty result" });
          }
          break;
        }
        default:
          // unknown frame types are ignored
          break;
      }
    });

    ws.on("close", () => dropSocket(ws));
    ws.on("error", () => dropSocket(ws));
  });

  // Use the named export off the registry object; fall back to mutation.
  function setConnected(payload) {
    if (typeof registry.setConnected === "function") {
      registry.setConnected(payload);
    } else {
      registry.connected = true;
      registry.extensionId = payload.extensionId || null;
      registry.extensionVersion = payload.extensionVersion || null;
    }
  }

  function send(ws, obj) {
    try {
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    } catch {
      // ignore send failures; keepalive/close handling will clean up
    }
  }

  // 20s ping keepalive: drop a socket that misses two consecutive pongs.
  const pingTimer = setInterval(() => {
    const ws = socket;
    if (!ws) return;
    if (ws.readyState !== ws.OPEN) return;
    ws._missedPongs = (ws._missedPongs || 0) + 1;
    if (ws._missedPongs > MAX_MISSED_PONGS) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      dropSocket(ws);
      return;
    }
    send(ws, { type: "ping" });
  }, PING_INTERVAL_MS);
  if (typeof pingTimer.unref === "function") pingTimer.unref();

  function isConnected() {
    return Boolean(socket && socket.readyState === socket.OPEN && registry.connected);
  }

  async function callTool(action, args, opts = {}) {
    const { session, timeoutMs = 300000 } = opts;

    if (!isConnected()) {
      return { error: "fetch failed: extension not connected" };
    }

    const requestId = nextRequestId++;
    const ws = socket;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          resolve({ error: "fetch failed: tool timeout" });
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      pending.set(requestId, { resolve, timer });

      const frame = {
        type: "tool_call",
        requestId,
        payload: {
          name: action,
          args: { ...(args || {}), _session: session },
        },
      };

      try {
        ws.send(JSON.stringify(frame));
      } catch (e) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({ error: "fetch failed: " + (e && e.message ? e.message : String(e)) });
      }
    });
  }

  function close() {
    clearInterval(pingTimer);
    // Reject nothing — resolve all pending as transport failures so callers
    // never hang on shutdown.
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      try {
        entry.resolve({ error: "fetch failed: hub closed" });
      } catch {
        // ignore
      }
    }
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      socket = null;
    }
    try {
      httpServer.removeListener("upgrade", onUpgrade);
    } catch {
      // ignore
    }
    try {
      wss.close();
    } catch {
      // ignore
    }
  }

  return {
    isConnected,
    callTool,
    close,
  };
}
