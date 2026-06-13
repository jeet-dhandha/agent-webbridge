// contract.mjs — browser-free contract test for the agent-webbridge daemon.
//
// Boots the real daemon on a free port (via bin/agent-webbridge.mjs, which
// self-backgrounds), connects a STUB extension as a WS client to /ws (no real
// Chrome), serves canned tool results, and asserts the daemon's HTTP /command
// envelopes match BUILD_SPEC §1. Also verifies the not-connected path and the
// disk-write side effect for screenshot. Uses only node builtins + `ws`.
//
// Run:  node test/contract.mjs
// Exits non-zero on any failed assertion.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const BIN = path.join(REPO, "bin", "agent-webbridge.mjs");

// ---- tiny assertion harness -------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

// ---- helpers ----------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Grab a currently-free TCP port by binding to :0 and reading the assignment.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Minimal JSON HTTP client over node:http (no deps).
function httpJson(method, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        host: HOST,
        port,
        path: urlPath,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Poll /status until extension_connected matches `want` (or time out).
async function waitForExtension(port, want, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { json } = await httpJson("GET", port, "/status");
      if (json && json.extension_connected === want) return json;
    } catch {
      // daemon may not be listening yet
    }
    await sleep(100);
  }
  return null;
}

// Poll /status until the daemon answers at all (it's listening).
async function waitForListening(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { json } = await httpJson("GET", port, "/status");
      if (json && json.running) return true;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return false;
}

// ---- the stub extension -----------------------------------------------------

// Canned tool data keyed by tool name. `args` is the args object the daemon
// forwarded (includes _session). Shapes mirror BUILD_SPEC §4 tool returns.
function cannedData(name, args) {
  switch (name) {
    case "navigate":
      return { success: true, url: args.url, tabId: 42 };
    case "evaluate":
      return { type: "string", value: args.code };
    case "list_tabs":
      return {
        success: true,
        tabs: [{ tabId: 42, url: "x", title: "t", active: true, groupTitle: "g" }],
      };
    case "close_tab":
      return { success: true, closed: true };
    case "close_session":
      return { success: true, closed: 2 };
    case "screenshot":
      return {
        format: "png",
        data: Buffer.from("PNGDATA").toString("base64"),
        dataLength: 7,
      };
    default:
      return { ok: true };
  }
}

// Connect a WS stub to ws://HOST:port/ws, send hello, answer tool_calls.
function connectStub(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws`);
    let settled = false;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          payload: { extensionVersion: "0.1.0", extensionId: "stub-ext" },
        })
      );
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "hello_ack") {
        if (!settled) {
          settled = true;
          resolve(ws);
        }
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "tool_call") {
        const { requestId, payload } = msg;
        const name = payload && payload.name;
        const args = (payload && payload.args) || {};
        ws.send(
          JSON.stringify({
            type: "tool_result",
            responseToRequestId: requestId,
            payload: { data: cannedData(name, args) },
          })
        );
        return;
      }
    });

    ws.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

// ---- main -------------------------------------------------------------------

async function main() {
  const port = await getFreePort();

  // 1) Start the real daemon. `start` self-backgrounds: the foreground process
  //    spawns a detached child and exits 0, so this returns immediately.
  const launcher = spawn(process.execPath, [BIN, "start", "--addr", `${HOST}:${port}`], {
    cwd: REPO,
    stdio: "ignore",
  });
  await new Promise((res) => launcher.on("exit", res));

  const listening = await waitForListening(port);
  check("daemon is listening on /status", listening, `port ${port}`);
  if (!listening) {
    return finish(port);
  }

  // 2) Connect the stub extension and complete the hello handshake.
  let stub;
  try {
    stub = await connectStub(port);
    check("stub extension WS handshake (hello_ack)", true);
  } catch (e) {
    check("stub extension WS handshake (hello_ack)", false, e.message);
    return finish(port);
  }

  // 3) /status reflects the connection.
  const connStatus = await waitForExtension(port, true);
  check(
    "status shows extension_connected:true",
    Boolean(connStatus && connStatus.extension_connected === true),
    JSON.stringify(connStatus)
  );

  // navigate -> { ok:true, data:{...} }
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "navigate",
      args: { url: "https://example.com" },
      session: "s1",
    });
    check(
      "navigate envelope: ok===true && data present",
      Boolean(json && json.ok === true && json.data),
      JSON.stringify(json)
    );
  }

  // evaluate -> { ok:true, data:{...} }
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "evaluate",
      args: { code: "1+1" },
      session: "s1",
    });
    check(
      "evaluate envelope: ok===true && data present",
      Boolean(json && json.ok === true && json.data),
      JSON.stringify(json)
    );
  }

  // list_tabs -> { ok:true, success:true, tabs:[...] } (spread to top level)
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "list_tabs",
      args: {},
      session: "s1",
    });
    check(
      "list_tabs envelope: ok && success && Array.isArray(tabs)",
      Boolean(json && json.ok === true && json.success === true && Array.isArray(json.tabs)),
      JSON.stringify(json)
    );
  }

  // close_tab -> { ok:true, success:true, closed:true }
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "close_tab",
      args: { _tabId: 42 },
      session: "s1",
    });
    check(
      "close_tab envelope: success===true",
      Boolean(json && json.success === true),
      JSON.stringify(json)
    );
  }

  // close_session -> { ok:true, success:true, closed:2 }
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "close_session",
      args: {},
      session: "s1",
    });
    check(
      "close_session envelope: success===true",
      Boolean(json && json.success === true),
      JSON.stringify(json)
    );
  }

  // screenshot -> { ok:true, data:{ path, ... } } and the file exists with bytes
  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "screenshot",
      args: {},
      session: "s1",
    });
    let onDisk = false;
    let bytes = 0;
    const p = json && json.data && json.data.path;
    if (p) {
      try {
        const st = fs.statSync(p);
        onDisk = st.isFile();
        bytes = st.size;
      } catch {
        onDisk = false;
      }
    }
    check(
      "screenshot envelope: ok && data.path is a real file with bytes (diskwriter ran)",
      Boolean(json && json.ok && p && onDisk && bytes > 0),
      JSON.stringify({ json, onDisk, bytes })
    );
    // clean up the temp capture file
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }

  // 4) Disconnect the stub, then a command must fail with "fetch failed".
  try {
    stub.close();
  } catch {}
  // ws 'close' must propagate to the daemon so the registry flips to disconnected.
  const discStatus = await waitForExtension(port, false);
  check(
    "status shows extension_connected:false after disconnect",
    Boolean(discStatus && discStatus.extension_connected === false),
    JSON.stringify(discStatus)
  );

  {
    const { json } = await httpJson("POST", port, "/command", {
      action: "navigate",
      args: { url: "https://example.com" },
      session: "s1",
    });
    check(
      'command with no extension: ok===false && error includes "fetch failed"',
      Boolean(
        json &&
          json.ok === false &&
          typeof json.error === "string" &&
          json.error.includes("fetch failed")
      ),
      JSON.stringify(json)
    );
  }

  return finish(port);
}

// 5) Shut the daemon down and report.
async function finish(port) {
  try {
    await httpJson("POST", port, "/shutdown");
  } catch {
    // already gone
  }

  console.log("");
  console.log(`RESULT  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  unexpected error — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
