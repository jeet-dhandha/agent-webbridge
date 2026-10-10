// mcp.mjs — browser-free test for `awb mcp`. Stands up a stub router, spawns the real
// MCP server over stdio, and checks the JSON-RPC handshake, tool list and routing.
//
// Run:  node test/mcp.mjs

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

const seen = [];
const stub = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/status")) return res.end(JSON.stringify({ router: true, fleet: [] }));
    const body = JSON.parse(b || "{}");
    seen.push(body);
    if (body.action === "fail") return res.end(JSON.stringify({ ok: false, error: "boom" }));
    res.end(JSON.stringify({ success: true, url: body.args?.url, tabId: 7 }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

function client(env) {
  const p = spawn(process.execPath, [path.join(REPO, "bin", "awb.mjs"), "mcp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => reject(new Error("timeout " + method)), 8000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { p, rpc, notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n") };
}

const c = client({ AWB_ROUTER_URL: `http://127.0.0.1:${port}` });
try {
  const init = await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "agent-webbridge");
  check("initialize advertises tools", !!init.result?.capabilities?.tools);
  c.notify("notifications/initialized");

  const list = await c.rpc("tools/list");
  const names = list.result.tools.map((t) => t.name);
  check("tools/list has browser_navigate + browser_snapshot + browser_status",
    ["browser_navigate", "browser_snapshot", "browser_status"].every((n) => names.includes(n)));
  check("tools/list has browser_file_chooser_intercept", names.includes("browser_file_chooser_intercept"));
  check("tools/list has 16 tools (15 browser + status)", list.result.tools.length === 16);
  check("every tool has an object inputSchema", list.result.tools.every((t) => t.inputSchema?.type === "object"));

  const nav = await c.rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com", newTab: true, profile: "Work", session: "s1", tabId: 5 } });
  check("navigate returns text content", nav.result.content[0].type === "text" && JSON.parse(nav.result.content[0].text).tabId === 7);
  const navTool = list.result.tools.find((t) => t.name === "browser_navigate");
  check("browser_navigate schema lists active (boolean) and group_title", navTool.inputSchema.properties.active?.type === "boolean" && !!navTool.inputSchema.properties.group_title);
  const sent = seen.at(-1);
  check("router got action/profile/session", sent.action === "navigate" && sent.profile === "Work" && sent.session === "s1");
  check("tabId forwarded as args._tabId, url as args.url", sent.args._tabId === 5 && sent.args.url === "https://example.com");

  await c.rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com/bg", newTab: true, active: false, group_title: "G", session: "s1", tabId: 5 } });
  check("active:false and group_title are forwarded in args", seen.at(-1).args.active === false && seen.at(-1).args.group_title === "G");

  const intercept = await c.rpc("tools/call", { name: "browser_file_chooser_intercept", arguments: { enabled: true } });
  check("file_chooser_intercept returns success", !intercept.result.isError);
  check("file_chooser_intercept routes enabled arg", seen.at(-1).action === "file_chooser_intercept" && seen.at(-1).args.enabled === true);

  const dflt = await c.rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  check("default session is applied", seen.at(-1).session === "mcp" && !dflt.result.isError);

  const st = await c.rpc("tools/call", { name: "browser_status", arguments: {} });
  check("browser_status reads /status", JSON.parse(st.result.content[0].text).router === true);

  const unk = await c.rpc("tools/call", { name: "browser_nope", arguments: {} });
  check("unknown tool is an isError result", unk.result.isError === true);

  const bad = await c.rpc("nope/method");
  check("unknown method is JSON-RPC -32601", bad.error?.code === -32601);
} finally {
  c.p.kill();
}

// router down -> helpful, actionable error instead of a crash
const d = client({ AWB_ROUTER_URL: "http://127.0.0.1:1" });
try {
  await d.rpc("initialize", { protocolVersion: "2024-11-05" });
  const r = await d.rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  check("router down -> isError with `awb up` hint", r.result.isError === true && /awb up/.test(r.result.content[0].text));
} finally {
  d.p.kill();
}
stub.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
