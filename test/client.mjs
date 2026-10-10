// client.mjs — browser-free test for WebBridgeClient SDK.
// Stands up a stub router, verifies command payload construction, tab tracking, and wrappers.
//
// Run:  node test/client.mjs

import http from "node:http";
import { WebBridgeClient } from "../src/client.mjs";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

const seen = [];
let mockTabId = 42;
let mockResponseOverride = null;

const stub = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (mockResponseOverride) {
      const resp = mockResponseOverride;
      mockResponseOverride = null;
      res.writeHead(resp.status || 200, { "Content-Type": "application/json" });
      return res.end(resp.body);
    }

    const body = JSON.parse(b || "{}");
    seen.push(body);

    res.writeHead(200, { "Content-Type": "application/json" });
    if (body.action === "navigate") {
      res.end(JSON.stringify({ ok: true, data: { url: body.args.url, tabId: mockTabId } }));
    } else if (body.action === "evaluate") {
      res.end(JSON.stringify({ ok: true, data: { value: "mock title" } }));
    } else if (body.action === "snapshot") {
      res.end(JSON.stringify({ ok: true, data: { nodes: [] } }));
    } else {
      res.end(JSON.stringify({ ok: true, data: { success: true } }));
    }
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;
const router = `http://127.0.0.1:${port}`;

try {
  const client = new WebBridgeClient({
    router,
    profile: "TestProfile",
    session: "test-sess",
  });

  check("initial tabId is null", client.currentTabId === null);
  check("profile is initialized", client.profile === "TestProfile");
  check("session is initialized", client.session === "test-sess");

  // 1. Navigate & auto tabId tracking
  const navRes = await client.navigate("https://example.com", { newTab: true, groupTitle: "MyGroup" });
  check("navigate returns data", navRes.url === "https://example.com");
  check("currentTabId is tracked after navigate", client.currentTabId === mockTabId);
  const navCmd = seen.at(-1);
  check("navigate payload has session and profile", navCmd.session === "test-sess" && navCmd.profile === "TestProfile");
  check("navigate payload has args", navCmd.args.url === "https://example.com" && navCmd.args.newTab === true && navCmd.args.group_title === "MyGroup");

  await client.navigate("https://example.com/bg", { newTab: true, groupTitle: "MyGroup", active: false });
  check("navigate sends active:false for a background tab", seen.at(-1).args.active === false);
  await client.navigate("https://example.com/fg", { newTab: true });
  check("navigate omits active by default", !("active" in seen.at(-1).args));

  // 2. Evaluate uses pinned tabId & unwraps value
  const evalRes = await client.evaluate("document.title");
  check("evaluate unwraps value", evalRes === "mock title");
  const evalCmd = seen.at(-1);
  check("evaluate pinned currentTabId in args._tabId", evalCmd.args._tabId === mockTabId);

  // 3. Click & trustedClick
  await client.click("#btn");
  check("click sends selector and pinned tabId", seen.at(-1).args.selector === "#btn" && seen.at(-1).args._tabId === mockTabId);

  await client.trustedClick("#btn", { x: 10, y: 20 });
  check("trustedClick sends coordinates", seen.at(-1).action === "trusted_click" && seen.at(-1).args.x === 10 && seen.at(-1).args.y === 20);

  // 4. Fill
  await client.fill("#input", "hello");
  check("fill sends value", seen.at(-1).args.selector === "#input" && seen.at(-1).args.value === "hello");

  // 5. Snapshot
  const snapRes = await client.snapshot();
  check("snapshot returns data", Array.isArray(snapRes.nodes));

  // 6. Screenshot (path string and options object)
  await client.screenshot("/tmp/shot.png");
  check("screenshot with string path", seen.at(-1).args.path === "/tmp/shot.png");

  // 7. Upload
  await client.upload("#file", ["/tmp/a.txt", "/tmp/b.txt"]);
  check("upload sends files array", Array.isArray(seen.at(-1).args.files) && seen.at(-1).args.files.length === 2);

  // 8. File chooser intercept
  await client.fileChooserIntercept(true);
  check("fileChooserIntercept sends enabled true", seen.at(-1).action === "file_chooser_intercept" && seen.at(-1).args.enabled === true);

  // 9. Network
  await client.network("start", { filter: "*.png" });
  check("network sends cmd and filter", seen.at(-1).action === "network" && seen.at(-1).args.cmd === "start" && seen.at(-1).args.filter === "*.png");

  // 10. List tabs, find tab, close tab, save as PDF
  await client.listTabs();
  check("listTabs action", seen.at(-1).action === "list_tabs");

  await client.findTab("https://example.com");
  check("findTab action", seen.at(-1).action === "find_tab" && seen.at(-1).args.url === "https://example.com");

  await client.closeTab();
  check("closeTab action", seen.at(-1).action === "close_tab");

  await client.saveAsPdf({ path: "/tmp/doc.pdf" });
  check("saveAsPdf action", seen.at(-1).action === "save_as_pdf" && seen.at(-1).args.path === "/tmp/doc.pdf");

  // 11. Close session does not send _tabId
  await client.closeSession();
  check("closeSession does not pin _tabId", seen.at(-1).action === "close_session" && seen.at(-1).args._tabId === undefined);

  // 12. Error handling: router returns ok: false
  mockResponseOverride = { status: 200, body: JSON.stringify({ ok: false, error: "element not found" }) };
  let caught = null;
  try {
    await client.click("#missing");
  } catch (e) {
    caught = e;
  }
  check("throws on ok:false with error message", caught && /element not found/.test(caught.message));

  // 13. Error handling: HTTP 500
  mockResponseOverride = { status: 500, body: "internal error" };
  caught = null;
  try {
    await client.click("#missing");
  } catch (e) {
    caught = e;
  }
  check("throws on HTTP error status", caught && /HTTP 500/.test(caught.message));
} finally {
  stub.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
