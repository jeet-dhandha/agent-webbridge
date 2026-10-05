// trusted_click.mjs — the `trusted_click` tool: click like a real mouse. Resolves a
// selector (CSS or @e ref), scrolls it into view, then sends CDP
// Input.dispatchMouseEvent (moved -> pressed -> released) at the element's centre.
// Unlike `click` (a synthetic el.click(), isTrusted=false), these events are
// isTrusted=true, so pages that ignore synthetic input still respond.
//
// Args: { selector } or { x, y } (CSS px in the top-level viewport),
//       optional button ("left" | "middle" | "right", default "left"), clickCount (default 1),
//       activate (default true), force (default false).
// Returns: { success:true, x, y, tag, text, hit, visibility, activated }
//
// Safety: before pressing, the tool checks that the topmost element at the click point is
// the target (or inside it). If something covers it (banner, dialog, overlay) the tool
// throws instead of clicking the cover; pass force:true to click anyway (hit:false).
//
// A hidden tab drops CDP input silently (verified: no events reach the page). So the tool
// makes the tab active in its window and restores a minimized window (activate:false ->
// error instead), waits for the page to report visible, and re-checks after the click; if
// the tab is hidden at either point it throws rather than report a click that never landed.
//
// Limits: coordinates are top-level viewport coordinates, so elements inside iframes
// are rejected.

import { resolveSelector } from "../dom.mjs";
import { send } from "../dbg.mjs";

const LOCATE_FN =
  "function(){if(this.ownerDocument.defaultView!==window.top)return {iframe:true};" +
  "this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});" +
  "const r=this.getBoundingClientRect();" +
  "const x=r.left+r.width/2,y=r.top+r.height/2;" +
  // elementFromPoint on the element's own root (document or shadow root) so targets
  // inside shadow DOM are not retargeted to their host.
  "const root=this.getRootNode();" +
  "const top=(root.elementFromPoint?root:document).elementFromPoint(x,y);" +
  "const hit=!!top&&(top===this||this.contains(top));" +
  "return {x,y,w:r.width,h:r.height,hit," +
  "tag:(this.tagName||'').toLowerCase()," +
  "text:((this.innerText||this.value||this.textContent||'').trim()).slice(0,200)};}";

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

async function pageVisibility(tabId) {
  const { result } = await send(tabId, "Runtime.evaluate", {
    expression: "document.visibilityState",
    returnByValue: true,
  });
  return result && result.value;
}

// Chrome's own view of the tab (not page-controlled): active in a non-minimized window.
async function tabShown(chrome, tabId) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  return { tab, win, shown: tab.active && win.state !== "minimized" };
}

// Make sure the page can receive input: activate its tab / restore its window if needed,
// then wait for the page to report visible. Returns true when anything had to change.
async function ensureVisible(chrome, tabId, activate) {
  const { tab, win, shown } = await tabShown(chrome, tabId);
  if (shown && (await pageVisibility(tabId)) === "visible") return false;
  if (!activate) throw new Error("trusted_click: tab is hidden (activate:false)");
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  if (win.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await pageVisibility(tabId)) === "visible") return true;
  }
  throw new Error("trusted_click: tab still hidden after activating it; bring its window to the front");
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const { chrome } = ctx;
  const button = args.button || "left";
  const clickCount = args.clickCount || 1;
  if (!(button in BUTTON_MASK)) throw new Error("trusted_click: unknown button " + button);

  const activated = await ensureVisible(chrome, tabId, args.activate !== false);

  let info;
  if (args.selector) {
    const { objectId } = await resolveSelector(tabId, args.selector);
    const { result, exceptionDetails } = await send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: LOCATE_FN,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const ex = exceptionDetails.exception;
      throw new Error(String((ex && (ex.description || ex.value)) || exceptionDetails.text || "locate failed"));
    }
    info = (result && result.value) || {};
    if (info.iframe) throw new Error("trusted_click: element is inside an iframe (not supported) " + args.selector);
    if (!info.w || !info.h) throw new Error("trusted_click: element has no size (hidden?) " + args.selector);
    if (!info.hit && !args.force) {
      throw new Error("trusted_click: another element covers " + args.selector + " at (" +
        Math.round(info.x) + "," + Math.round(info.y) + "); not clicked (force:true to click anyway)");
    }
  } else if (typeof args.x === "number" && typeof args.y === "number") {
    info = { x: args.x, y: args.y, hit: null, tag: "", text: "" };
  } else {
    throw new Error("trusted_click requires selector or x/y");
  }

  // Another tab in the same window may have been activated while we located the target.
  if (!(await tabShown(chrome, tabId)).shown) {
    throw new Error("trusted_click: tab was hidden before the click; not clicked");
  }

  const { x, y } = info;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  // A real double click is two press/release pairs with clickCount 1 then 2.
  for (let n = 1; n <= clickCount; n++) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button, buttons: BUTTON_MASK[button], clickCount: n,
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button, buttons: 0, clickCount: n,
    });
  }

  if (!(await tabShown(chrome, tabId)).shown) {
    throw new Error("trusted_click: tab became hidden during the click; it may not have landed");
  }

  return {
    success: true,
    x,
    y,
    tag: info.tag || "",
    text: info.text || "",
    hit: info.hit,
    visibility: "visible",
    activated,
  };
}
