// dom.mjs — selector -> CDP node resolution.
// Resolves either an "@e" snapshot ref (minted by snapshot-refs.mjs during an
// accessibility snapshot) or a plain CSS selector into a CDP objectId that the
// click/fill/screenshot/upload tools operate on. All CDP traffic is keyed by an
// explicit tabId via dbg.mjs, preserving per-tab concurrency.

import * as refs from "./snapshot-refs.mjs";
import { send } from "./dbg.mjs";

export async function resolveSelector(tabId, selector) {
  // "@e" refs come from a prior snapshot and map to a backend DOM node id.
  if (typeof selector === "string" && selector.startsWith("@e")) {
    const { backendDOMNodeId } = refs.resolveRef(tabId, selector);
    const { object } = await send(tabId, "DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
    });
    return { objectId: object.objectId, backendNodeId: backendDOMNodeId };
  }

  // Otherwise treat it as a CSS selector against the live document.
  const doc = await send(tabId, "DOM.getDocument", {});
  const { nodeId } = await send(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error("No node found for selector " + selector);
  const { object } = await send(tabId, "DOM.resolveNode", { nodeId });
  return { objectId: object.objectId, nodeId };
}
