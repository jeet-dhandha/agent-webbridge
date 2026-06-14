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
import fs from "node:fs";
const DBG = process.env.AWB_WSHUB_DEBUG;
function dbg(...a) { if (DBG) { try { fs.appendFileSync(DBG, `[${new Date().toISOString()}] ${a.join(" ")}\n`); } catch {} } }

const PING_INTERVAL_MS = 20000;
const MAX_MISSED_PONGS = 2;
// A connection that upgrades but never completes a valid hello is never adopted, so the
// ping keepalive (which only touches the adopted socket) never reaps it. Terminate such a
// never-identified socket after this long so a peer that opens /ws and goes silent can't
// leak an fd. Env-overridable so the contract test can use a short window.
const HELLO_TIMEOUT_MS = Number(process.env.AWB_HELLO_TIMEOUT_MS ?? 10000);

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
    // Promote ws to the live slot, terminating any previous (different) socket. Called
    // ONLY once a connection has completed a valid hello (see the hello case) — never on
    // the bare 'connection' event. That matters: if we adopted on connection (blind
    // newest-wins), a SECOND webbridge extension in the same profile — e.g. a leftover
    // legacy build that never identifies itself — would evict the real one on every
    // reconnect, and the two would flap over this single slot every few seconds, making
    // tool calls non-deterministic. Gating adoption on a valid handshake keeps the real
    // extension pinned and shuts the impostor out.
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

  // Force-drop the currently bound extension socket, regardless of whether the daemon
  // still believes it's healthy. The socket.terminate() sends a TCP close to the
  // extension side, whose ws.onclose then schedules a fresh reconnect — so a stale or
  // zombie socket (the daemon thinks it's connected, but the worker behind it is dead or
  // serving old code) is displaced and the live service worker re-handshakes into the
  // slot via adoptSocket (newest-connection-wins). Returns whether a socket was bound.
  function forceReconnect() {
    const had = !!socket;
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }
    // Don't wait for the async 'close' event: clear state synchronously so /status
    // reports disconnected immediately. The later close handler is a no-op (socket !== ws).
    socket = null;
    registry.setDisconnected ? registry.setDisconnected() : setDisconnectedFallback();
    return had;
  }

  // registry exposes setDisconnected/setConnected as named exports too; we import
  // the object and call through it defensively.
  function setDisconnectedFallback() {
    registry.connected = false;
    registry.extensionId = null;
    registry.extensionVersion = null;
  }

  wss.on("connection", (ws, req) => {
    const peer = req && req.socket ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : "?";
    ws._peer = peer;
    dbg("CONNECT", peer, "ua=", (req && req.headers && req.headers["user-agent"]) || "");
    // Deliberately NOT adopted here — a fresh connection only becomes the live socket once
    // it sends a valid hello (below). Until then it's a candidate that can't displace the
    // current healthy connection. But because it isn't adopted, the ping keepalive won't
    // reap it either, so arm a handshake timer: if it never gets adopted, terminate it.
    const helloTimer = setTimeout(() => {
      if (socket !== ws) {
        dbg("HELLO_TIMEOUT", ws._peer, "— terminating un-adopted socket");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }, HELLO_TIMEOUT_MS);
    if (typeof helloTimer.unref === "function") helloTimer.unref();
    const clearHelloTimer = () => clearTimeout(helloTimer);

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
          const extId = payload.extensionId;
          dbg("HELLO", ws._peer, "id=", extId, "ver=", payload.extensionVersion);
          // Only an extension that identifies itself may take the slot. A legacy/foreign
          // webbridge build that connects but sends no extensionId is shut out so it can't
          // displace the real extension and trigger the flap-over-the-single-slot bug.
          if (!extId) {
            dbg("REJECT unidentified hello", ws._peer, "— closing");
            clearHelloTimer();
            try {
              ws.close();
            } catch {
              // ignore
            }
            break;
          }
          clearHelloTimer();
          adoptSocket(ws);
          setConnected(payload);
          send(ws, { type: "hello_ack" });
          break;
        }
        case "pong": {
          // Only the adopted socket's pong keeps the slot alive; ignore pre-hello/stale ones.
          if (ws !== socket) break;
          ws._missedPongs = 0;
          ws._alive = true;
          break;
        }
        case "tool_result": {
          // Results are only honored from the live extension — a non-adopted socket must not
          // be able to resolve a pending call (it could inject a forged/empty result).
          if (ws !== socket) break;
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

    ws.on("close", () => { clearHelloTimer(); dbg("CLOSE", ws._peer, "wasCurrent=", socket === ws); dropSocket(ws); });
    ws.on("error", () => { clearHelloTimer(); dbg("ERROR", ws._peer); dropSocket(ws); });
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
    forceReconnect,
    close,
  };
}
