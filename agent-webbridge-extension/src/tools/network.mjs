// network.mjs — per-tab network capture over CDP.
//
// Drives the chrome.debugger Network domain for a single tab and records the
// request/response lifecycle (requestWillBeSent / responseReceived /
// loadingFinished) into a per-tab map. Because every CDP event carries its
// source tabId, captures for different tabs stay isolated and concurrent.
//
// Commands (args.cmd):
//   start  -> Network.enable + begin capturing            -> { success:true }
//   list   -> list captured requests (optional url filter) -> { requests:[...] }
//   detail -> one request + Network.getResponseBody        -> { request, response, body }
//   stop   -> stop capturing                               -> { success:true, count }

import { send } from "../dbg.mjs";

// tabId -> { byId: Map<requestId, entry>, order: requestId[] }
const captures = new Map();

// Single global CDP event listener, installed lazily. It fans events out to the
// per-tab capture map keyed by the event's source.tabId.
let listenerInstalled = false;

function ensureListener() {
  if (listenerInstalled) return;
  if (!chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source && source.tabId;
    if (tabId == null) return;
    const cap = captures.get(tabId);
    if (!cap) return; // not capturing this tab
    handleEvent(cap, method, params || {});
  });
  listenerInstalled = true;
}

// Fold a single Network.* event into the tab's capture state.
function handleEvent(cap, method, params) {
  switch (method) {
    case "Network.requestWillBeSent": {
      const id = params.requestId;
      if (id == null) return;
      let entry = cap.byId.get(id);
      if (!entry) {
        entry = {
          requestId: id,
          url: "",
          method: "",
          status: null,
          statusText: "",
          mimeType: "",
          type: params.type || "",
          requestHeaders: {},
          responseHeaders: {},
          encodedDataLength: 0,
          finished: false,
        };
        cap.byId.set(id, entry);
        cap.order.push(id);
      }
      const req = params.request || {};
      entry.url = req.url || entry.url;
      entry.method = req.method || entry.method;
      entry.requestHeaders = req.headers || entry.requestHeaders;
      if (params.type) entry.type = params.type;
      break;
    }
    case "Network.responseReceived": {
      const id = params.requestId;
      const entry = id != null && cap.byId.get(id);
      if (!entry) return;
      const res = params.response || {};
      entry.status = res.status != null ? res.status : entry.status;
      entry.statusText = res.statusText || entry.statusText;
      entry.mimeType = res.mimeType || entry.mimeType;
      entry.responseHeaders = res.headers || entry.responseHeaders;
      if (params.type) entry.type = params.type;
      break;
    }
    case "Network.loadingFinished": {
      const id = params.requestId;
      const entry = id != null && cap.byId.get(id);
      if (!entry) return;
      entry.finished = true;
      if (params.encodedDataLength != null) {
        entry.encodedDataLength = params.encodedDataLength;
      }
      break;
    }
    default:
      break;
  }
}

// Public, serializable view of a captured request.
function toPublic(entry) {
  return {
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    type: entry.type,
    encodedDataLength: entry.encodedDataLength,
    finished: entry.finished,
  };
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  if (tabId == null) throw new Error("network requires a target tab");

  const cmd = args.cmd || "list";

  if (cmd === "start") {
    ensureListener();
    captures.set(tabId, { byId: new Map(), order: [] });
    await send(tabId, "Network.enable", {});
    return { success: true };
  }

  if (cmd === "stop") {
    const cap = captures.get(tabId);
    const count = cap ? cap.order.length : 0;
    try {
      await send(tabId, "Network.disable", {});
    } catch {
      // tab may be gone; report the count we have either way
    }
    captures.delete(tabId);
    return { success: true, count };
  }

  if (cmd === "list") {
    const cap = captures.get(tabId);
    if (!cap) return { requests: [] };
    const filter = args.filter;
    let requests = cap.order
      .map((id) => cap.byId.get(id))
      .filter(Boolean)
      .map(toPublic);
    if (filter) {
      requests = requests.filter(
        (r) => typeof r.url === "string" && r.url.includes(filter)
      );
    }
    return { requests };
  }

  if (cmd === "detail") {
    const cap = captures.get(tabId);
    const id = args.requestId;
    if (id == null) throw new Error("network detail requires a requestId");
    const entry = cap && cap.byId.get(id);
    if (!entry) throw new Error("no captured request for id " + id);

    const request = {
      requestId: entry.requestId,
      url: entry.url,
      method: entry.method,
      headers: entry.requestHeaders,
    };
    const response = {
      status: entry.status,
      statusText: entry.statusText,
      mimeType: entry.mimeType,
      headers: entry.responseHeaders,
      encodedDataLength: entry.encodedDataLength,
    };

    let body = null;
    try {
      const res = await send(tabId, "Network.getResponseBody", {
        requestId: id,
      });
      if (res) {
        body = { data: res.body || "", base64Encoded: !!res.base64Encoded };
      }
    } catch (e) {
      // Body may be unavailable (no longer cached, redirect, etc.).
      body = { data: "", base64Encoded: false, error: e.message };
    }

    return { request, response, body };
  }

  throw new Error("unknown network cmd: " + cmd);
}
