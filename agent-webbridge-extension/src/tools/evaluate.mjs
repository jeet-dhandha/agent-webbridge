// evaluate.mjs — the `evaluate` tool: run arbitrary JS in the target tab.
// Uses CDP Runtime.evaluate (returnByValue + awaitPromise) so async code and
// promises resolve before we read the result. A thrown exception in the page
// surfaces as a thrown Error here (its text), so the daemon reports {error}.
//
// Frame mode: pass allFrames / frameUrl / frameTitle to run in every frame,
// including cross-origin iframes that Runtime.evaluate on the tab cannot reach.
// This uses chrome.scripting (ISOLATED world by default) and returns one entry
// per frame: { ok, url, title, value } or { ok:false, ..., error }.
//
// Returns: { type: <result.type>, value: <result.value> }.

import { send } from "../dbg.mjs";

const frameEval = async (code) => {
  try {
    const value = await (0, eval)(code);
    return { ok: true, url: location.href, title: document.title, value };
  } catch (e) {
    return {
      ok: false,
      url: location.href,
      title: document.title,
      error: String((e && e.message) || e),
    };
  }
};

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const code = args.code;

  if (args.allFrames || args.frameUrl || args.frameTitle) {
    const chrome = ctx.chrome;
    if (!chrome?.scripting?.executeScript) {
      throw new Error("frame evaluate needs the scripting permission (reload the extension)");
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: args.world === "MAIN" ? "MAIN" : "ISOLATED",
      func: frameEval,
      args: [code],
    });
    const frames = results
      .filter((r) => r && r.result)
      .map((r) => r.result)
      .filter((f) => {
        if (args.frameUrl && !String(f.url || "").includes(args.frameUrl)) return false;
        if (args.frameTitle && !String(f.title || "").includes(args.frameTitle)) return false;
        return true;
      });
    if (args.first) {
      if (!frames.length) throw new Error("no frame matched");
      return frames[0];
    }
    return { frames };
  }

  const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (exceptionDetails) {
    // Prefer the rich exception text/description; fall back to the plain text.
    const ex = exceptionDetails.exception;
    const message =
      (ex && (ex.description || ex.value)) ||
      exceptionDetails.text ||
      "evaluation failed";
    throw new Error(String(message));
  }

  return { type: result && result.type, value: result && result.value };
}
