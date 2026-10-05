// trusted_click.mjs — the `trusted_click` tool: click like a real mouse. Resolves a
// selector (CSS or @e ref), scrolls it into view, then sends CDP
// Input.dispatchMouseEvent (moved -> pressed -> released) at the element's centre.
// Unlike `click` (a synthetic el.click(), isTrusted=false), these events are
// isTrusted=true, so pages that ignore synthetic input still respond.
//
// Args: { selector } or { x, y } (CSS px in the top-level viewport),
//       optional button ("left" | "middle" | "right", default "left"), clickCount (default 1),
//       activate (default true).
// Returns: { success:true, x, y, tag, text, hit, visibility, activated }
//   hit: true when the topmost element at (x, y) is the target or inside it; false means
//   something overlays it and that overlay received the click.
//
// A hidden tab drops CDP input silently (verified: no events reach the page). So when the
// page is hidden the tool makes the tab active in its window (activate:false -> error
// instead) and waits for it to become visible; if it stays hidden (window minimized or
// fully covered) it throws rather than report a click that never landed.
//
// Limits: coordinates are top-level viewport coordinates, so elements inside iframes
// are not supported.

import { resolveSelector } from "../dom.mjs";
import { send } from "../dbg.mjs";

const LOCATE_FN =
  "function(){this.scrollIntoView({block:'center',inline:'center'});" +
  "const r=this.getBoundingClientRect();" +
  "const x=r.left+r.width/2,y=r.top+r.height/2;" +
  "const top=document.elementFromPoint(x,y);" +
  "const hit=!!top&&(top===this||this.contains(top)||(this.shadowRoot&&this.shadowRoot.contains(top)));" +
  "return {x,y,w:r.width,h:r.height,hit,visibility:document.visibilityState," +
  "tag:(this.tagName||'').toLowerCase()," +
  "text:((this.innerText||this.value||this.textContent||'').trim()).slice(0,200)};}";

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

async function visibility(tabId) {
  const { result } = await send(tabId, "Runtime.evaluate", {
    expression: "document.visibilityState",
    returnByValue: true,
  });
  return result && result.value;
}

// Make sure the page can receive input: activate its tab if hidden, then wait for it
// to report visible. Returns true when the tab had to be activated.
async function ensureVisible(ctx, tabId, activate) {
  if ((await visibility(tabId)) === "visible") return false;
  if (!activate) throw new Error("trusted_click: tab is hidden (activate:false)");
  await ctx.chrome.tabs.update(tabId, { active: true });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await visibility(tabId)) === "visible") return true;
  }
  throw new Error("trusted_click: tab still hidden after activating it; bring its window to the front");
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const button = args.button || "left";
  const clickCount = args.clickCount || 1;
  if (!(button in BUTTON_MASK)) throw new Error("trusted_click: unknown button " + button);

  const activated = await ensureVisible(ctx, tabId, args.activate !== false);

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
    if (!info.w || !info.h) throw new Error("trusted_click: element has no size (hidden?) " + args.selector);
  } else if (typeof args.x === "number" && typeof args.y === "number") {
    info = { x: args.x, y: args.y, hit: null, tag: "", text: "" };
  } else {
    throw new Error("trusted_click requires selector or x/y");
  }

  const { x, y } = info;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button, buttons: BUTTON_MASK[button], clickCount,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button, buttons: 0, clickCount,
  });

  return {
    success: true,
    x,
    y,
    tag: info.tag || "",
    text: info.text || "",
    hit: info.hit,
    visibility: info.visibility || null,
    activated,
  };
}
