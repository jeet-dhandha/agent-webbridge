// mcp.mjs — stdio Model Context Protocol server for agent-webbridge.
//
//   npx -y agent-webbridge mcp
//
// Zero dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout, forwarding every
// tool call to the local router (POST http://127.0.0.1:10086/command). Nothing leaves the
// machine. stdout carries protocol messages only; logs go to stderr.

import readline from "node:readline";
import { ROUTER_PORT } from "./profiles.mjs";

const ROUTER = process.env.AWB_ROUTER_URL || `http://127.0.0.1:${process.env.AWB_ROUTER_PORT || ROUTER_PORT}`;
const DEFAULT_SESSION = process.env.AWB_MCP_SESSION || "mcp";
const PROTOCOL = "2024-11-05";
const VERSION = "1.3.0";

const common = {
  profile: { type: "string", description: "Chrome profile name, email or directory (e.g. \"Work\"). Omit to use the default profile." },
  session: { type: "string", description: `Task id that groups tabs (default "${DEFAULT_SESSION}"). Use different sessions for independent tasks.` },
  tabId: { type: "number", description: "Target a specific tab (from list_tabs / navigate). Lets several tabs of one profile run in parallel." },
};

const tool = (action, description, props = {}, required = []) => ({
  action,
  def: {
    name: `browser_${action}`,
    description,
    inputSchema: { type: "object", properties: { ...props, ...common }, required },
  },
});

const TOOLS = [
  tool("navigate", "Open a URL in the user's real, logged-in Chrome. Returns {url, tabId}.", {
    url: { type: "string" },
    newTab: { type: "boolean", description: "Open in a new tab instead of reusing the current one." },
    group_title: { type: "string", description: "Label for the session's tab group." },
  }, ["url"]),
  tool("snapshot", "Accessibility tree of the page with @e refs for interactive elements. Prefer this over screenshots for reading a page.", {}),
  tool("click", "Click an element by @e ref or CSS selector (synthetic click).", {
    selector: { type: "string" },
  }, ["selector"]),
  tool("trusted_click", "Click with a real mouse event (isTrusted=true). Use when click is ignored by the page.", {
    selector: { type: "string" },
    x: { type: "number" }, y: { type: "number" },
    button: { type: "string", enum: ["left", "middle", "right"] },
    clickCount: { type: "number" },
  }),
  tool("fill", "Type into an input, textarea or contenteditable by @e ref or CSS selector.", {
    selector: { type: "string" },
    value: { type: "string" },
  }, ["selector", "value"]),
  tool("evaluate", "Run JavaScript in the page and return the result (async/await supported). Wrap code in an IIFE.", {
    code: { type: "string" },
  }, ["code"]),
  tool("screenshot", "Screenshot the page or one element. Saves to `path` and returns the file path, not base64.", {
    path: { type: "string", description: "Absolute file path to write." },
    selector: { type: "string" },
    format: { type: "string", enum: ["png", "jpeg"] },
  }),
  tool("list_tabs", "List open tabs with url, title and group.", {}),
  tool("find_tab", "Make an already-open tab current, by its full URL.", {
    url: { type: "string" },
    active: { type: "boolean" },
  }, ["url"]),
  tool("close_tab", "Close one tab.", {}),
  tool("close_session", "Close every tab opened by a session. Call when a task is done.", {}),
  tool("upload", "Set files on a file input.", {
    selector: { type: "string" },
    files: { type: "array", items: { type: "string" } },
  }, ["selector", "files"]),
  tool("network", "Capture network requests: cmd = start | stop | list | detail.", {
    cmd: { type: "string", enum: ["start", "stop", "list", "detail"] },
    filter: { type: "string" },
    requestId: { type: "string" },
  }, ["cmd"]),
  tool("save_as_pdf", "Save the current page as a PDF.", {
    paper_format: { type: "string" },
    path: { type: "string" },
  }),
];

const STATUS_TOOL = {
  name: "browser_status",
  description: "Fleet health: which Chrome profiles have a daemon up and the extension connected. Call first if other tools fail.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const byName = new Map(TOOLS.map((t) => [t.def.name, t]));

class RouterDown extends Error {}

async function callRouter(path, init) {
  let r;
  try {
    r = await fetch(`${ROUTER}${path}`, init);
  } catch (e) {
    throw new RouterDown(e.message);
  }
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, json };
}

const profileHint = (profile, detail) =>
  `${detail} — the Chrome profile${profile ? ` "${profile}"` : ""} is not connected. ` +
  `Run \`awb up "${profile || "<profile>"}"\` (first time: \`awb setup\`), check with browser_status, then retry.`;

const NOT_RUNNING =
  "agent-webbridge router is not reachable on " + ROUTER + ". Start it with `awb up \"<profile>\"` " +
  "(first time: `awb setup \"<profile>\"`), then retry. `awb doctor` diagnoses the setup.";

async function runTool(name, args = {}) {
  if (name === "browser_status") {
    const { json } = await callRouter("/status");
    return json;
  }
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  const { profile, session, tabId, ...rest } = args;
  const body = { action: t.action, args: rest, session: session || DEFAULT_SESSION };
  if (tabId != null) body.args._tabId = tabId;
  if (profile) body.profile = profile;
  const { ok, json } = await callRouter("/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ok || json?.ok === false || json?.error) {
    const err = new Error(typeof json?.error === "string" ? json.error : JSON.stringify(json));
    err.payload = json;
    throw err;
  }
  return json;
}

function reply(id, result) { out({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { out({ jsonrpc: "2.0", id, error: { code, message } }); }
function out(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-webbridge", version: VERSION },
        instructions:
          "Drives the user's real Chrome (real logins, multiple profiles, parallel tabs) through a local bridge. " +
          "Read pages with browser_snapshot, not screenshots. Pass `profile` to pick a Chrome profile and `tabId` to run tabs in parallel.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [STATUS_TOOL, ...TOOLS.map((t) => t.def)] });
    case "tools/call": {
      try {
        const result = await runTool(params?.name, params?.arguments || {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        let text = e.message;
        if (e instanceof RouterDown) text = NOT_RUNNING;
        else if (/proxy to :\d+ failed|no daemon available|not connected|no extension/i.test(e.message)) {
          text = profileHint(params?.arguments?.profile, e.message);
        }
        return reply(id, { isError: true, content: [{ type: "text", text }] });
      }
    }
    case "resources/list": return reply(id, { resources: [] });
    case "prompts/list": return reply(id, { prompts: [] });
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

let inflight = 0;
let closed = false;
const maybeExit = () => { if (closed && inflight === 0) process.exit(0); };

export function startMcp() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, "parse error"); }
    inflight++;
    handle(msg)
      .catch((e) => {
        console.error("[awb-mcp]", e.message);
        if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, e.message);
      })
      .finally(() => { inflight--; maybeExit(); });
  });
  // stdin closed: finish replying to in-flight calls, then exit
  rl.on("close", () => { closed = true; maybeExit(); });
  console.error(`[awb-mcp] stdio server ready (router ${ROUTER})`);
}

export const _tools = TOOLS;
