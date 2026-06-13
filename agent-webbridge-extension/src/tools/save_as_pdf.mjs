// save_as_pdf.mjs — render the target tab to a PDF via CDP Page.printToPDF.
// The extension returns the raw base64 in `data` (plus a few hints the daemon
// uses to name the file); diskwriter.mjs in the daemon decodes and writes it.

import { send } from "../dbg.mjs";

// Paper sizes in inches (CDP printToPDF expects inches). Defaults to "letter".
const PAPER_SIZES = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  ledger: { width: 17, height: 11 },
  a0: { width: 33.1, height: 46.8 },
  a1: { width: 23.4, height: 33.1 },
  a2: { width: 16.54, height: 23.4 },
  a3: { width: 11.7, height: 16.54 },
  a4: { width: 8.27, height: 11.7 },
  a5: { width: 5.83, height: 8.27 },
  a6: { width: 4.13, height: 5.83 },
};

// Read the current page's title for default file naming. Best-effort.
async function readPageTitle(tabId) {
  try {
    const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    if (!exceptionDetails && result && typeof result.value === "string") {
      return result.value;
    }
  } catch (_e) {
    // ignore — fall through to empty title
  }
  return "";
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;

  const paper = PAPER_SIZES[String(args.paper_format || "letter").toLowerCase()] ||
    PAPER_SIZES.letter;

  const params = {
    landscape: args.landscape === true,
    printBackground: args.print_background !== false,
    paperWidth: paper.width,
    paperHeight: paper.height,
    preferCSSPageSize: false,
  };
  if (typeof args.scale === "number") params.scale = args.scale;

  const pageTitle = await readPageTitle(tabId);

  const result = await send(tabId, "Page.printToPDF", params);
  const data = (result && result.data) || "";

  return {
    data,
    mimeType: "application/pdf",
    dataLength: data.length,
    pageTitle,
    requestedFileName: args.file_name || "",
  };
}
