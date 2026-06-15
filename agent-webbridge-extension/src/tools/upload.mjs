// upload.mjs — the `upload` tool: set files on a file <input>. DOM.setFileInputFiles
// needs a CDP node handle (nodeId / backendNodeId / objectId), so we resolve the
// selector to one of those here.
//
// Resolution order (each step backward-compatible with the last):
//   1. "@e" snapshot ref      -> backendNodeId (pierces shadow DOM; from a11y tree)
//   2. light-DOM CSS selector -> nodeId via DOM.querySelector from the document root
//   3. shadow-piercing CSS    -> objectId via Runtime.evaluate deep-walk into OPEN
//                                shadow roots (e.g. LinkedIn's composer file input,
//                                which lives in a shadow root and is invisible to
//                                DOM.querySelector).
//
// Returns: { success:true, fileCount, files, via }.

import { send } from "../dbg.mjs";
import * as refs from "../snapshot-refs.mjs";

// Deep-walk light DOM + every OPEN shadow root for the first match of `sel`.
// Returns the element (as a live RemoteObject when called with returnByValue:false).
function deepFindExpr(sel) {
  return (
    "(() => { const sel = " + JSON.stringify(sel) + ";" +
    "const seen = new Set();" +
    "function deep(root){" +
    "let el = null; try { el = root.querySelector(sel); } catch (e) {}" +
    "if (el) return el;" +
    "const all = root.querySelectorAll('*');" +
    "for (const h of all){ if (h.shadowRoot && !seen.has(h.shadowRoot)){ seen.add(h.shadowRoot); const f = deep(h.shadowRoot); if (f) return f; } }" +
    "return null; }" +
    "return deep(document); })()"
  );
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const selector = args.selector;
  const files = Array.isArray(args.files) ? args.files : [];

  // 1. snapshot "@e" ref -> backendNodeId (the a11y snapshot already pierced shadow DOM).
  if (typeof selector === "string" && selector.startsWith("@e")) {
    const { backendDOMNodeId } = refs.resolveRef(tabId, selector);
    await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: backendDOMNodeId });
    return { success: true, fileCount: files.length, files, via: "ref" };
  }

  // 2. light-DOM CSS selector via DOM.querySelector (fast path, unchanged behavior).
  let nodeId = 0;
  try {
    const { root } = await send(tabId, "DOM.getDocument", {});
    ({ nodeId } = await send(tabId, "DOM.querySelector", { nodeId: root.nodeId, selector }));
  } catch {
    nodeId = 0;
  }
  if (nodeId) {
    await send(tabId, "DOM.setFileInputFiles", { files, nodeId });
    return { success: true, fileCount: files.length, files, via: "light" };
  }

  // 3. shadow-piercing fallback: resolve a live object handle by deep-walking OPEN
  //    shadow roots, then set files on it by objectId.
  const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
    expression: deepFindExpr(selector),
    returnByValue: false,
  });
  if (exceptionDetails || !result || !result.objectId) {
    throw new Error("No node found for selector " + selector);
  }
  try {
    await send(tabId, "DOM.setFileInputFiles", { files, objectId: result.objectId });
  } finally {
    if (result.objectId) {
      await send(tabId, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    }
  }
  return { success: true, fileCount: files.length, files, via: "shadow" };
}
