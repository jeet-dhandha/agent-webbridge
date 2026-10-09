// guard.mjs — keep web pages out of the local bridge.
//
// The router (:10086) and every per-profile daemon listen on 127.0.0.1. Loopback is not a
// security boundary against the user's own browser: any website can POST to
// http://127.0.0.1:<port> (a text/plain body needs no CORS preflight), open a WebSocket to
// it, or rebind a hostname to 127.0.0.1. Without a check, a page you merely visit could drive
// your logged-in tabs while the fleet is up.
//
// Two header rules close that, and neither affects real clients (curl, Node, MCP, Python):
//   Origin  — browsers always send it on cross-site requests and WebSocket handshakes. Our own
//             callers send none, and the extension sends chrome-extension://<id>. Anything else
//             (https://evil.example, "null" from sandboxed frames) is refused.
//   Host    — must be loopback. A rebound hostname arrives with the attacker's Host and is refused.
//
// AWB_ALLOW_ORIGINS="https://my-dashboard.local,http://localhost:8787" opts specific web origins in.

const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

function allowedOrigins() {
  return (process.env.AWB_ALLOW_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Returns null when the request may proceed, or a short reason string when it must be refused.
export function checkRequest(req) {
  const origin = req.headers?.origin;
  if (origin !== undefined && !/^chrome-extension:\/\//i.test(origin) && !allowedOrigins().includes(origin)) {
    return `origin not allowed: ${String(origin).slice(0, 80)}`;
  }
  const host = req.headers?.host;
  if (host !== undefined && !HOST_RE.test(host)) {
    return `host not allowed: ${String(host).slice(0, 80)}`;
  }
  return null;
}
