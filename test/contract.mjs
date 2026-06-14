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
    // Short handshake-reaper window so the "silent socket gets terminated" test is fast.
    // Real/stub connections send hello within ms, well inside this, so they're unaffected.
    env: { ...process.env, AWB_HELLO_TIMEOUT_MS: "1200" },
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

  // 5) Forced reconnect (`awb up` recovery path): POST /reconnect must drop the bound
  //    socket — so a stale/zombie worker the daemon still believes is connected gets
  //    evicted — and a FRESH worker must then be able to re-handshake into the slot.
  {
    // (a) A worker connects; the daemon sees it.
    let stubC;
    try {
      stubC = await connectStub(port);
    } catch (e) {
      check("reconnect: fresh stub handshake", false, e.message);
      return finish(port);
    }
    let cClosed = false;
    stubC.on("close", () => { cClosed = true; });
    const upC = await waitForExtension(port, true);
    check(
      "reconnect: status connected:true before /reconnect",
      Boolean(upC && upC.extension_connected === true),
      JSON.stringify(upC)
    );

    // (b) /reconnect reports it dropped a bound socket, the daemon immediately reports
    //     disconnected, and the (stale) worker's socket actually closes.
    const { json: rj } = await httpJson("POST", port, "/reconnect");
    check(
      "reconnect: POST /reconnect → ok && dropped:true",
      Boolean(rj && rj.ok === true && rj.dropped === true),
      JSON.stringify(rj)
    );
    const downC = await waitForExtension(port, false);
    check(
      "reconnect: status connected:false right after /reconnect",
      Boolean(downC && downC.extension_connected === false),
      JSON.stringify(downC)
    );
    await sleep(200);
    check("reconnect: dropped worker's socket received close", cClosed === true);

    // (c) a FRESH worker re-handshakes into the now-empty slot and serves commands —
    //     this is the live SW that `awb up` wakes after the drop, displacing the stale one.
    let stubD;
    try {
      stubD = await connectStub(port);
    } catch (e) {
      check("reconnect: replacement worker handshake", false, e.message);
      return finish(port);
    }
    const upD = await waitForExtension(port, true);
    check(
      "reconnect: status connected:true after replacement worker",
      Boolean(upD && upD.extension_connected === true),
      JSON.stringify(upD)
    );
    {
      const { json } = await httpJson("POST", port, "/command", {
        action: "list_tabs",
        args: {},
        session: "s1",
      });
      check(
        "reconnect: command works on the replacement worker",
        Boolean(json && json.ok === true && json.success === true && Array.isArray(json.tabs)),
        JSON.stringify(json)
      );
    }
    try { stubD.close(); } catch {}
    await waitForExtension(port, false);

    // (d) /reconnect with nothing connected is a harmless no-op (dropped:false).
    const { json: rj2 } = await httpJson("POST", port, "/reconnect");
    check(
      "reconnect: POST /reconnect with no socket → ok && dropped:false",
      Boolean(rj2 && rj2.ok === true && rj2.dropped === false),
      JSON.stringify(rj2)
    );
  }

  // 6) Impostor rejection: a SECOND, unidentified extension (no extensionId in its hello —
  //    the signature of a leftover/legacy webbridge build) must NOT be able to displace the
  //    real one. Without this gate the two flap over the single slot every few seconds and
  //    tool calls become non-deterministic (the live root cause behind "list_tabs sometimes
  //    returns 0").
  {
    // The real extension connects and is adopted.
    let real;
    try {
      real = await connectStub(port);
    } catch (e) {
      check("impostor: real extension handshake", false, e.message);
      return finish(port);
    }
    const realUp = await waitForExtension(port, true);
    check(
      "impostor: real extension connected (id=stub-ext)",
      Boolean(realUp && realUp.extension_connected === true && realUp.extension_id === "stub-ext"),
      JSON.stringify(realUp)
    );

    // An impostor connects and sends a hello WITHOUT an extensionId.
    const impostor = new WebSocket(`ws://${HOST}:${port}/ws`);
    let impAck = false;
    let impClosed = false;
    impostor.on("message", (raw) => {
      try {
        const m = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (m && m.type === "hello_ack") impAck = true;
      } catch {}
    });
    impostor.on("close", () => { impClosed = true; });
    await new Promise((res, rej) => {
      impostor.on("open", () => {
        impostor.send(JSON.stringify({ type: "hello", payload: { extensionVersion: "1.9.13" } }));
        res();
      });
      impostor.on("error", rej);
    });
    await sleep(500);

    // The impostor must be shut out: no hello_ack, its socket closed, and the real
    // extension must STILL own the slot and serve commands.
    check("impostor: unidentified hello got NO hello_ack", impAck === false);
    check("impostor: daemon closed the impostor socket", impClosed === true);
    const stillReal = await httpJson("GET", port, "/status");
    check(
      "impostor: real extension still connected (id=stub-ext, not displaced)",
      Boolean(
        stillReal.json &&
          stillReal.json.extension_connected === true &&
          stillReal.json.extension_id === "stub-ext"
      ),
      JSON.stringify(stillReal.json)
    );
    {
      const { json } = await httpJson("POST", port, "/command", {
        action: "list_tabs",
        args: {},
        session: "s1",
      });
      check(
        "impostor: command still routes to the real extension",
        Boolean(json && json.ok === true && json.success === true && Array.isArray(json.tabs)),
        JSON.stringify(json)
      );
    }
    try { real.close(); } catch {}
    try { impostor.close(); } catch {}
    await waitForExtension(port, false);
  }

  // 7) Handshake-timeout reaper: a socket that completes the WS upgrade but never sends a
  //    valid hello is never adopted, so the ping keepalive can't reap it. The daemon must
  //    terminate it after AWB_HELLO_TIMEOUT_MS (set short for this run) so it can't leak.
  {
    const silent = new WebSocket(`ws://${HOST}:${port}/ws`);
    let opened = false, closed = false;
    silent.on("open", () => { opened = true; });
    silent.on("close", () => { closed = true; });
    await sleep(300);
    check("reaper: silent (no-hello) socket opened", opened === true);
    const deadline = Date.now() + 3000; // > AWB_HELLO_TIMEOUT_MS (1200) + margin
    while (!closed && Date.now() < deadline) await sleep(100);
    check("reaper: un-adopted silent socket was terminated by the handshake timeout", closed === true);
    try { silent.close(); } catch {}
  }

  return finish(port);
}

// 6) Shut the daemon down and report.
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
