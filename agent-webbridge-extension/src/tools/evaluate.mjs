// evaluate.mjs — the `evaluate` tool: run arbitrary JS in the target tab.
// Uses CDP Runtime.evaluate (returnByValue + awaitPromise) so async code and
// promises resolve before we read the result. A thrown exception in the page
// surfaces as a thrown Error here (its text), so the daemon reports {error}.
//
// Returns: { type: <result.type>, value: <result.value> }.

import { send } from "../dbg.mjs";

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const code = args.code;

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
