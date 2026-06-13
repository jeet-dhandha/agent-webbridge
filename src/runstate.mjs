// runstate.mjs — shared on-disk locations for the fleet's run dir, plus a tiny state
// record. The state file remembers the last successful start (so we can confirm
// "everything worked") and the last stop (manual or idle). Pure built-ins, no deps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN = path.join(os.homedir(), ".agent-webbridge", "multi", "run");
export const ROUTER_PID = path.join(RUN, "router.pid");
export const ROUTER_LOG = path.join(RUN, "router.log");
export const STATE_FILE = path.join(RUN, "fleet-state.json");

export function ensureRun() {
  fs.mkdirSync(RUN, { recursive: true });
}

// Last recorded fleet state, or null if none yet.
export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(state) {
  ensureRun();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

// Merge a patch into the existing state (used to stamp stoppedAt onto a prior start).
export function patchState(patch) {
  return writeState({ ...(readState() || {}), ...patch });
}
