// dbg.mjs — per-tab chrome.debugger attach Map (THE parallelism core).
// Every CDP call is keyed by an explicit tabId, so different tabs run
// concurrently and independently. This module owns the attach/detach
// lifecycle and normalizes CDP/Chrome errors so callers can detect the
// retryable substrings defined in the build spec (§1).

const attached = new Map(); // tabId -> true

// Register listeners that prune the attach map when Chrome detaches the
// debugger (e.g. devtools opened) or when a tab is removed. Safe to call once.
export function initDebugger() {
  if (chrome.debugger?.onDetach) {
    chrome.debugger.onDetach.addListener((source) => {
      if (source && typeof source.tabId === "number") {
        attached.delete(source.tabId);
      }
    });
  }
  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      attached.delete(tabId);
    });
  }
}

// Attach the debugger to a tab. Idempotent: if we already hold the tab, or if
// Chrome reports another debugger is already attached, treat it as attached.
export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.set(tabId, true);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes("Another debugger") || msg.includes("already attached")) {
      // Someone else (or a racing call) already attached — adopt it.
      attached.set(tabId, true);
      return;
    }
    throw e;
  }
}

// Best-effort detach. Never throws; always drops the tab from the map.
export async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore — tab may already be gone or never attached
  }
  attached.delete(tabId);
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

// Send a CDP command to a specific tab, attaching first if needed.
// Errors are normalized to carry the retryable substrings expected by the
// daemon/tooling so failed calls can be safely retried.
export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes("No tab with given id")) {
      // Keep the substring verbatim so callers can detect it.
      throw e instanceof Error ? e : new Error(msg);
    }
    if (msg.includes("not attached")) {
      attached.delete(tabId);
      throw new Error("Debugger is not attached (" + tabId + ")");
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}
