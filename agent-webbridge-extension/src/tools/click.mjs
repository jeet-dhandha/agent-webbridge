// click.mjs — the `click` tool: resolve a selector (CSS or @e ref) to a live
// DOM node, scroll it into view, and click it. Uses Runtime.callFunctionOn so
// the click runs in the page against the resolved objectId.
//
// Returns: { success:true, tag, text } where tag/text describe the clicked node.

import { resolveSelector } from "../dom.mjs";
import { send } from "../dbg.mjs";

const CLICK_FN =
  "function(){this.scrollIntoView({block:'center'});this.click();" +
  "return {tag:(this.tagName||'').toLowerCase()," +
  "text:((this.innerText||this.value||this.textContent||'').trim()).slice(0,200)};}";

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const selector = args.selector;

  const { objectId } = await resolveSelector(tabId, selector);

  const { result, exceptionDetails } = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: CLICK_FN,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (exceptionDetails) {
    const ex = exceptionDetails.exception;
    const message =
      (ex && (ex.description || ex.value)) ||
      exceptionDetails.text ||
      "click failed";
    throw new Error(String(message));
  }

  const out = (result && result.value) || {};
  return { success: true, tag: out.tag || "", text: out.text || "" };
}
