// diskwriter.mjs — turns a capture tool's base64 payload into a file on disk.
// Used by the daemon for screenshot / save_as_pdf: the extension returns the
// bytes as base64 (it never touches the filesystem), and the daemon writes
// them here, honoring an explicit caller `path` or building a default path
// under the OS temp dir. Per BUILD_SPEC §2 src/daemon/diskwriter.mjs.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const PDF_CAP_BYTES = 100 * 1024 * 1024; // 100MB cap for PDFs.

// Pick a file extension from the explicit format or the mimeType.
function pickExt(format, mimeType) {
  const fmt = String(format || "").toLowerCase();
  if (fmt === "png") return "png";
  if (fmt === "jpeg" || fmt === "jpg") return "jpg";
  if (fmt === "pdf") return "pdf";

  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("png")) return "png";
  if (mt.includes("jpeg") || mt.includes("jpg")) return "jpg";
  if (mt.includes("pdf")) return "pdf";

  // Default to png for screenshots when nothing else is known.
  return "png";
}

// Strip an optional data: URL prefix and sanitize whitespace before decoding.
function decodeBase64(b64) {
  let s = String(b64 || "");
  const comma = s.indexOf(",");
  if (s.startsWith("data:") && comma !== -1) {
    s = s.slice(comma + 1);
  }
  return Buffer.from(s, "base64");
}

// Sanitize a string for use as a filename component.
function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}

/**
 * Decode a capture payload and write it to disk.
 *
 * @param {string} action  "screenshot" | "save_as_pdf" (used in default name)
 * @param {{format?:string, data:string, mimeType?:string, pageTitle?:string,
 *          requestedFileName?:string, dataLength?:number}} data  the tool payload
 * @param {{path?:string, format?:string, file_name?:string}} args  caller args
 * @returns {Promise<{format:string, path:string, sizeBytes:number, mimeType:string}>}
 */
export async function writeCapture(action, data, args = {}) {
  const buf = decodeBase64(data && data.data);

  const ext = pickExt(args.format || (data && data.format), data && data.mimeType);

  // Enforce the 100MB cap for PDFs.
  if (ext === "pdf" && buf.length > PDF_CAP_BYTES) {
    throw new Error("PDF exceeds 100MB cap");
  }

  let outPath;
  if (args.path) {
    // Honor the caller's path verbatim; ensure its parent exists.
    outPath = args.path;
    await fs.mkdir(path.dirname(outPath), { recursive: true });
  } else {
    // Build a default path under the OS temp dir.
    const base =
      (data && (data.pageTitle || data.requestedFileName)) ||
      args.file_name ||
      action;
    const fileName = `${sanitizeName(base)}-${Date.now()}.${ext}`;
    outPath = path.join(os.tmpdir(), fileName);
  }

  await fs.writeFile(outPath, buf); // overwrite if present

  const mimeType =
    (data && data.mimeType) ||
    (ext === "pdf"
      ? "application/pdf"
      : ext === "jpg"
      ? "image/jpeg"
      : "image/png");

  return {
    format: ext === "jpg" ? "jpeg" : ext,
    path: outPath,
    sizeBytes: buf.length,
    mimeType,
  };
}
