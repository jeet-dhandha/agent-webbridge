// screenshot.mjs — capture a PNG/JPEG of the target tab (or a single element) via
// CDP Page.captureScreenshot. The extension returns the raw base64 in `data`;
// the daemon (diskwriter.mjs) is what actually writes the file to disk. An optional
// CSS / @e selector clips the capture to a single element's box.

import { send } from "../dbg.mjs";
import { resolveSelector } from "../dom.mjs";

// Normalize a requested format to a value CDP accepts ("png" | "jpeg").
function normalizeFormat(format) {
  const f = String(format || "png").toLowerCase();
  if (f === "jpg" || f === "jpeg") return "jpeg";
  return "png";
}

// Resolve the bounding box of a selector into a CDP screenshot clip.
// Returns null when no usable box could be derived.
async function clipForSelector(tabId, selector) {
  const { objectId, backendNodeId, nodeId } = await resolveSelector(tabId, selector);

  // Prefer DOM.getBoxModel when we have a node handle; fall back to the
  // bounding client rect via Runtime.callFunctionOn for detached/abnormal nodes.
  let box = null;
  try {
    const params = {};
    if (typeof backendNodeId === "number") params.backendNodeId = backendNodeId;
    else if (typeof nodeId === "number") params.nodeId = nodeId;
    else if (objectId) params.objectId = objectId;
    const res = await send(tabId, "DOM.getBoxModel", params);
    const quad = res && res.model && res.model.border;
    if (Array.isArray(quad) && quad.length >= 8) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width > 0 && height > 0) box = { x, y, width, height };
    }
  } catch (_e) {
    box = null;
  }

  if (!box && objectId) {
    const { result, exceptionDetails } = await send(tabId, "Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration:
        "function(){const r=this.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};}",
    });
    if (!exceptionDetails && result && result.value) {
      const r = result.value;
      if (r.width > 0 && r.height > 0) {
        box = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
  }

  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const format = normalizeFormat(args.format);

  const params = { format };
  if (format === "jpeg" && typeof args.quality === "number") {
    params.quality = args.quality;
  }

  if (args.selector) {
    const clip = await clipForSelector(tabId, args.selector);
    if (clip) {
      params.clip = clip;
      params.captureBeyondViewport = true;
    }
  }

  const result = await send(tabId, "Page.captureScreenshot", params);
  const data = (result && result.data) || "";

  return {
    format,
    data,
    dataLength: data.length,
  };
}
