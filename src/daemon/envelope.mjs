// envelope.mjs — pure HTTP-envelope shaping for the daemon's POST /command.
// Takes a tool's uniform { data } | { error } result (as returned by the
// extension over WS, or after disk-write for capture tools) and produces the
// exact JSON object the HTTP caller expects, per BUILD_SPEC §1 "HTTP envelope".
// No I/O, no side effects — a single pure function.

/**
 * Shape a tool result into the HTTP response body.
 *
 * @param {string} action  the tool name (e.g. "list_tabs", "screenshot")
 * @param {{data?:any, error?:string}} payload  uniform tool result
 * @returns {object} JSON object to send back to the caller
 */
export function shapeResponse(action, payload) {
  // Error short-circuits everything (HTTP 200, ok:false).
  if (payload && payload.error) {
    return { ok: false, error: payload.error };
  }

  const data = payload ? payload.data : undefined;

  switch (action) {
    // Spread `data` (which is { tabs:[...] }) to the top level.
    case "list_tabs":
      return { ok: true, success: true, ...(data || {}) };

    // Spread `data` (which is { closed:<bool|int> }) to the top level.
    case "close_tab":
    case "close_session":
      return { ok: true, success: true, ...(data || {}) };

    // Capture tools: data is the disk-write result { format, path, sizeBytes, mimeType }.
    case "screenshot":
    case "save_as_pdf":
      return { ok: true, data };

    // Everything else: nest the tool shape under `data`.
    default:
      return { ok: true, data };
  }
}
