// upload.mjs — the `upload` tool: set files on a file <input>. DOM.setFileInputFiles
// needs a CDP nodeId (not an objectId), so we resolve the selector straight through
// DOM.getDocument + DOM.querySelector here rather than via resolveSelector.
//
// Returns: { success:true, fileCount, files }.

import { send } from "../dbg.mjs";

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const selector = args.selector;
  const files = Array.isArray(args.files) ? args.files : [];

  const { root } = await send(tabId, "DOM.getDocument", {});
  const { nodeId } = await send(tabId, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error("No node found for selector " + selector);

  await send(tabId, "DOM.setFileInputFiles", { files, nodeId });

  return { success: true, fileCount: files.length, files };
}
