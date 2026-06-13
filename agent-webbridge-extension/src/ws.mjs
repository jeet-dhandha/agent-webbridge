// ws.mjs — extension-side WebSocket client for the daemon ↔ extension link.
//
// Runs inside the MV3 module service worker and uses the browser-global
// WebSocket. It speaks the JSON-text-frame protocol from BUILD_SPEC §1:
//   - on open  -> sends {type:"hello", payload:{extensionVersion, extensionId}}
//   - daemon   -> {type:"hello_ack"} (noop), {type:"ping"} (reply with pong),
//                 {type:"tool_call", requestId, payload:{name,args}}
//   - we reply -> {type:"tool_result", responseToRequestId, payload:{data}|{error}}
//
// The connection URL is discovered from storage.local "local_url", which the
// fleet writes as JSON.stringify(wsUrl) — so we JSON.parse it before use.
// All transport errors are tolerated: on close/error we schedule a reconnect.

const RECONNECT_DELAY_MS = 5000;

export class WSClient {
  // onToolCall: async (payload{name,args}) => ({data}|{error})
  constructor({ onToolCall } = {}) {
    this.onToolCall = onToolCall;
    this.socket = null;
    this.url = null;
    this._reconnectTimer = null;
  }

  async connect(url) {
    this.url = url;
    // Replace any existing socket.
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      const manifest = chrome.runtime.getManifest();
      this.send({
        type: "hello",
        payload: {
          extensionVersion: manifest.version,
          extensionId: chrome.runtime.id,
        },
      });
    };

    socket.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this._scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.socket === socket) this.socket = null;
      this._scheduleReconnect();
    };
  }

  async _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "hello_ack":
        // nothing to do
        break;
      case "tool_call": {
        let payload;
        try {
          payload = await this.onToolCall(msg.payload);
        } catch (e) {
          payload = { error: e && e.message ? e.message : String(e) };
        }
        this.send({
          type: "tool_result",
          responseToRequestId: msg.requestId,
          payload,
        });
        break;
      }
      default:
        // unknown frame type — ignore
        break;
    }
  }

  send(obj) {
    if (this.isConnected()) {
      try {
        this.socket.send(JSON.stringify(obj));
      } catch {
        // ignore send failures; reconnect logic will recover
      }
    }
  }

  isConnected() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  async reconnectIfNeeded() {
    if (this.isConnected()) return;
    const url = await this._readLocalUrl();
    if (url) await this.connect(url);
  }

  async _readLocalUrl() {
    try {
      const result = await chrome.storage.local.get("local_url");
      const raw = result && result.local_url;
      if (!raw) return null;
      // Stored as JSON.stringify(wsUrl) by the fleet — parse it.
      try {
        return JSON.parse(raw);
      } catch {
        // tolerate a bare string that wasn't JSON-encoded
        return typeof raw === "string" ? raw : null;
      }
    } catch {
      return null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.reconnectIfNeeded();
    }, RECONNECT_DELAY_MS);
  }
}
