// connect_url.mjs — validation for the daemon URL that `awb connect` / `awb up` hand to the
// extension through its own popup page (chrome-extension://<id>/popup.html#connect=<url>).
//
// Privacy invariant: the extension talks to a daemon on 127.0.0.1 ONLY. Whatever reaches
// SET_URL is checked here, so even a crafted hash can only ever point at a loopback port.

const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:(\d{2,5})\/ws$/;

export function isLoopbackWsUrl(url) {
  if (typeof url !== "string") return false;
  const m = LOOPBACK_WS.exec(url);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535;
}

// Only the extension's own popup page may deliver a URL (a content script or another
// extension must not be able to re-point the bridge).
export function isOwnPopupSender(sender, extensionId, popupUrl) {
  return !!sender && sender.id === extensionId && typeof sender.url === "string" && sender.url.startsWith(popupUrl);
}

// The whole SET_URL decision, with every chrome.* effect injected so it is unit-testable.
// Returns the reply object for the popup. Nothing is stored or connected unless BOTH checks pass.
export async function applyConnectUrl({ url, sender, extensionId, popupUrl, saveLocalUrl, connect, closeTab }) {
  if (!isOwnPopupSender(sender, extensionId, popupUrl)) {
    return { ok: false, error: "rejected: SET_URL is only accepted from the extension's own popup page" };
  }
  if (!isLoopbackWsUrl(url)) {
    return { ok: false, error: "rejected: only ws://127.0.0.1:<port>/ws is allowed" };
  }
  try {
    await saveLocalUrl(JSON.stringify(url)); // same JSON-string format the fleet writes
    await connect(url);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  // We were opened as a tab by `awb`; close it so no popup tab is left behind.
  if (sender.tab && sender.tab.id != null) {
    try {
      await closeTab(sender.tab.id);
    } catch {
      // already gone
    }
  }
  return { ok: true };
}
