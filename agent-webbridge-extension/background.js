// background.js — Agent WebBridge MV3 service worker: the dispatcher / entry point.
//
// Wires the WS transport to the 13 tool modules. Every incoming tool_call lands in
// dispatch(), which resolves the target tab, builds the uniform `ctx` object, serializes
// work per-tab (so different tabs run concurrently — that is the parallelism), and returns
// a uniform { data } | { error } back to the daemon. No HTTP-envelope quirks live here.

import { WSClient } from "./src/ws.mjs";
import { initDebugger, attach } from "./src/dbg.mjs";
import { startKeepalive, beginHeartbeat, endHeartbeat } from "./src/keepalive.mjs";

import navigate from "./src/tools/navigate.mjs";
import find_tab from "./src/tools/find_tab.mjs";
import evaluate from "./src/tools/evaluate.mjs";
import snapshot from "./src/tools/snapshot.mjs";
import click from "./src/tools/click.mjs";
import fill from "./src/tools/fill.mjs";
import network from "./src/tools/network.mjs";
import upload from "./src/tools/upload.mjs";
import screenshot from "./src/tools/screenshot.mjs";
import save_as_pdf from "./src/tools/save_as_pdf.mjs";
import list_tabs from "./src/tools/list_tabs.mjs";
import close_tab from "./src/tools/close_tab.mjs";
import close_session from "./src/tools/close_session.mjs";

const TOOLS = {
  navigate,
  find_tab,
  evaluate,
  snapshot,
  click,
  fill,
  network,
  upload,
  screenshot,
  save_as_pdf,
  list_tabs,
  close_tab,
  close_session,
};

let currentTab = null; // last navigated/selected tabId
const queues = new Map(); // queueKey -> tail Promise (per-tab serialization)

// Resolve the target tab + the queue key for a given tool call (see §3 of BUILD_SPEC).
function resolveTarget(name, args) {
  if (args._tabId !== undefined && args._tabId !== null) {
    return { tabId: args._tabId, key: "tab:" + args._tabId };
  }
  if (name === "navigate" && args.newTab) {
    return { tabId: null, key: null }; // fully concurrent — brand new tab
  }
  if (name === "list_tabs" || name === "close_session") {
    return { tabId: null, key: "meta" };
  }
  return { tabId: currentTab, key: "current" };
}

// payload = { name, args } ; returns { data } | { error }
async function dispatch(payload) {
  const { name, args = {} } = payload || {};
  const tool = TOOLS[name];
  if (!tool) return { error: "unknown tool: " + name };

  const { tabId, key } = resolveTarget(name, args);

  const ctx = {
    tabId,
    session: args._session,
    get currentTab() {
      return currentTab;
    },
    setCurrentTab(id) {
      currentTab = id;
    },
    attach,
    chrome,
  };

  const exec = async () => {
    beginHeartbeat();
    try {
      const data = await tool(ctx, args);
      return { data };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    } finally {
      endHeartbeat();
    }
  };

  // No queue key -> run fully concurrently (e.g. new-tab navigation).
  if (!key) return exec();

  // Chain on the per-key tail so work for the same tab is serialized. The tail never
  // rejects (exec swallows errors into { error }), keeping the chain alive.
  const prev = queues.get(key) || Promise.resolve();
  const runP = prev.then(exec, exec);
  // Keep the tail resolved (no value leak) and self-prune when this is the latest.
  const tail = runP.then(
    () => {},
    () => {}
  );
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });

  return runP;
}

function main() {
  initDebugger();

  const ws = new WSClient({ onToolCall: dispatch });

  // Testability / observability hooks on the SW global — used by the popup and by the
  // live test harness to set the daemon URL and force a reconnect without waiting for
  // the keepalive alarm.
  globalThis.__awb = {
    reconnect: () => ws.reconnectIfNeeded(),
    disconnect: () => ws.disconnect(),
    connected: () => ws.isConnected(),
  };

  startKeepalive(() => ws.reconnectIfNeeded());

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    const type = m && m.type;
    if (type === "GET_STATUS") {
      // GET_STATUS is also the service-worker wake trigger the fleet relies on (popup.js
      // sends it on load; `awb up` opens the popup to fire it). On an ALREADY-running worker
      // main() won't re-run, so kick a reconnect here too — otherwise a wake after the daemon
      // dropped our socket would idle until the 5s reconnect timer. reconnectIfNeeded() is a
      // no-op when already connected.
      ws.reconnectIfNeeded();
      reply({ connected: ws.isConnected() });
    } else if (type === "CONNECT") {
      ws.reconnectIfNeeded();
      reply({ ok: true });
    } else if (type === "DISCONNECT") {
      ws.disconnect();
      reply({ ok: true });
    } else {
      reply({ ok: false });
    }
    return true; // keep the message channel open for the async reply
  });

  ws.reconnectIfNeeded();
}

main();
