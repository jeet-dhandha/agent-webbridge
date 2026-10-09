// guard.mjs — web pages must not be able to drive the local bridge.
// Boots a real daemon server on a free port and sends it the requests a hostile web page
// (or a DNS-rebinding page) would send, plus the requests legitimate clients send.
//
// Run:  node test/guard.mjs

import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { startServer } from "../src/daemon/server.mjs";
import { checkRequest } from "../src/guard.mjs";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// ---- unit ----
const req = (headers) => ({ headers });
check("no Origin, loopback Host -> allowed", checkRequest(req({ host: "127.0.0.1:10086" })) === null);
check("localhost Host -> allowed", checkRequest(req({ host: "localhost:10086" })) === null);
check("no headers at all -> allowed (non-browser client)", checkRequest(req({})) === null);
check("chrome-extension Origin -> allowed", checkRequest(req({ origin: "chrome-extension://abcdef", host: "127.0.0.1:1" })) === null);
check("https web Origin -> refused", checkRequest(req({ origin: "https://evil.example", host: "127.0.0.1:1" })) !== null);
check('"null" Origin (sandboxed frame) -> refused', checkRequest(req({ origin: "null" })) !== null);
check("http://localhost Origin -> refused by default", checkRequest(req({ origin: "http://localhost:3000" })) !== null);
check("rebound Host -> refused", checkRequest(req({ host: "evil.example:10086" })) !== null);
check("lookalike Host -> refused", checkRequest(req({ host: "127.0.0.1.evil.example" })) !== null);
process.env.AWB_ALLOW_ORIGINS = "http://localhost:3000";
check("AWB_ALLOW_ORIGINS opts an origin in", checkRequest(req({ origin: "http://localhost:3000" })) === null);
delete process.env.AWB_ALLOW_ORIGINS;

// ---- integration against a real daemon ----
const port = await new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const { server, hub } = startServer({ host: "127.0.0.1", port });
await new Promise((r) => setTimeout(r, 200));

const call = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  r.on("error", reject); if (body) r.write(body); r.end();
});

const plain = await call("GET", "/status");
check("plain GET /status works (curl, fleet, MCP)", plain.status === 200 && JSON.parse(plain.body).running === true);

const post = await call("POST", "/command", { "content-type": "application/json" }, JSON.stringify({ action: "list_tabs" }));
check("plain POST /command still reaches the daemon", post.status === 200 && /not connected|extension/i.test(post.body), post.body.slice(0, 80));

const xsite = await call("POST", "/command", { "content-type": "text/plain", origin: "https://evil.example" }, JSON.stringify({ action: "evaluate", args: { code: "1" } }));
check("cross-site text/plain POST (no-cors) -> 403", xsite.status === 403, `${xsite.status} ${xsite.body.slice(0, 80)}`);

const reb = await call("POST", "/command", { "content-type": "application/json", host: "evil.example:" + port }, JSON.stringify({ action: "list_tabs" }));
check("DNS-rebinding Host -> 403", reb.status === 403, `${reb.status}`);

const shut = await call("POST", "/shutdown", { origin: "https://evil.example" });
check("cross-site /shutdown -> 403 and daemon stays up", shut.status === 403 && (await call("GET", "/status")).status === 200);

const wsOutcome = (headers) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  ws.on("open", () => { ws.close(); resolve("open"); });
  ws.on("unexpected-response", (_q, r) => resolve(`http ${r.statusCode}`));
  ws.on("error", () => resolve("error"));
  setTimeout(() => resolve("timeout"), 3000);
});
check("WebSocket from a web page Origin is refused", (await wsOutcome({ origin: "https://evil.example" })) === "http 403");
check("WebSocket from chrome-extension:// Origin is accepted", (await wsOutcome({ origin: "chrome-extension://ifodkkbkmngjlkhiphcjmbceeolhpfeo" })) === "open");
check("WebSocket with no Origin (stub/test client) is accepted", (await wsOutcome({})) === "open");

try { hub.close(); } catch {}
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
