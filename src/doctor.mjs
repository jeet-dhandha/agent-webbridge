// doctor.mjs — `kwb doctor`: one read-only self-check that answers the only
// question a new user has before anything works: "is my machine set up, and if
// not, what one thing do I fix?"
//
// Pre-mortem FF1: the #1 first-run failure is a silent environment gap (no
// Chrome, the bundled agent-webbridge daemon missing, extension never installed,
// :10086 already taken by a stale daemon). Each of those used to surface as a confusing error
// three commands later. `doctor` front-loads them into a single PASS/WARN/FAIL
// report with the exact remedy, and exits non-zero if anything is FAIL so it's
// usable in a setup script.
//
// Read-only: it never starts a daemon, edits storage, or touches Chrome. Safe to
// run any time, even mid-fleet.

import fs from "node:fs";
import { chromeUserDataDir, listProfiles, ROUTER_PORT } from "./profiles.mjs";
import { chromeBinary } from "./extension.mjs";
import { KIMI_BIN, daemonStatus } from "./fleet.mjs";
import { RUN, ROUTER_PID, ensureRun } from "./runstate.mjs";

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";

function check(name, status, detail, hint) {
  return { name, status, detail, hint };
}

// Is OUR router (vs the stock kimi daemon) the thing holding :10086? The router
// records its pid in ROUTER_PID; a live pid there means it's ours.
function ourRouterPid() {
  try {
    const pid = parseInt(fs.readFileSync(ROUTER_PID, "utf8").trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function nodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}

// Returns { checks: [...], summary: { pass, warn, fail } }. Pure data — the CLI
// layer formats it. Each check is independent; a FAIL in one doesn't short-circuit
// the rest, so the user sees every problem in one pass.
export async function runDoctor() {
  const checks = [];

  // 1. Node — listProfiles/router rely on global fetch + modern fs (>=18).
  const nv = process.versions.node;
  checks.push(
    nodeMajor() >= 18
      ? check("Node.js", PASS, `v${nv}`)
      : check("Node.js", FAIL, `v${nv}`, "needs Node >=18 (global fetch + ESM). Upgrade Node."),
  );

  // 2. Platform — every launcher path is macOS + Chrome specific.
  checks.push(
    process.platform === "darwin"
      ? check("Platform", PASS, "macOS")
      : check(
          "Platform",
          FAIL,
          process.platform,
          "macOS + Google Chrome only today (open/defaults + Chrome paths are mac-specific). See README → Platform & scope.",
        ),
  );

  // 3. Google Chrome binary.
  const chrome = (() => {
    try {
      return chromeBinary();
    } catch {
      return null;
    }
  })();
  checks.push(
    chrome && fs.existsSync(chrome)
      ? check("Google Chrome", PASS, chrome)
      : check(
          "Google Chrome",
          FAIL,
          chrome || "not found",
          "install Google Chrome, or set KWB_CHROME_BIN to its binary path.",
        ),
  );

  // 4. Chrome user-data dir (where profiles + the extension registry live).
  const udd = chromeUserDataDir();
  checks.push(
    fs.existsSync(udd)
      ? check("Chrome user-data dir", PASS, udd)
      : check(
          "Chrome user-data dir",
          FAIL,
          udd,
          "launch Chrome once so the profile dir is created, or set KWB_CHROME_DIR (e.g. for Chrome Beta).",
        ),
  );

  // 5. agent-webbridge daemon binary — the engine each profile's daemon runs.
  // This ships inside the package (bin/agent-webbridge.mjs), so it should always
  // be present; a miss usually means a broken install or a bad KWB_KIMI_BIN.
  checks.push(
    fs.existsSync(KIMI_BIN)
      ? check("agent-webbridge daemon", PASS, KIMI_BIN)
      : check(
          "agent-webbridge daemon",
          FAIL,
          `${KIMI_BIN} (missing)`,
          "the bundled daemon (bin/agent-webbridge.mjs) is missing — reinstall with `npm i -g agent-webbridge`, or unset/correct KWB_KIMI_BIN.",
        ),
  );

  // 6/7. Profiles + extension coverage (only meaningful once the udd exists).
  let profiles = [];
  let profilesErr = null;
  try {
    profiles = listProfiles();
  } catch (e) {
    profilesErr = e.message;
  }
  if (profilesErr) {
    checks.push(check("Chrome profiles", FAIL, profilesErr, "could not read Chrome's Local State — is the user-data dir correct?"));
  } else if (profiles.length === 0) {
    checks.push(check("Chrome profiles", WARN, "0 discovered", "sign into at least one Chrome profile, then re-run."));
  } else {
    checks.push(check("Chrome profiles", PASS, `${profiles.length} discovered`));

    const withExt = profiles.filter((p) => p.hasExtension);
    const enabled = withExt.filter((p) => p.extEnabled);
    if (withExt.length === 0) {
      checks.push(
        check(
          "agent-webbridge extension",
          WARN,
          "not installed in any profile",
          "run `awb setup <profile>` — it opens chrome://extensions, prints the folder to Load unpacked, and waits. `awb up` needs the extension to connect.",
        ),
      );
    } else if (enabled.length === 0) {
      checks.push(
        check(
          "agent-webbridge extension",
          WARN,
          `present in ${withExt.length} profile(s) but all disabled`,
          "enable it in chrome://extensions for the profile(s) you want to drive.",
        ),
      );
    } else {
      const names = enabled.map((p) => `${p.name}[${p.extType}]`).join(", ");
      checks.push(check("agent-webbridge extension", PASS, `enabled in ${enabled.length}/${profiles.length}: ${names}`));
    }
  }

  // 8. Router port :10086 — must be free (or held by OUR router) before `kwb up`,
  // because the router's singleton probe is hardwired to :10086.
  const portStatus = await daemonStatus(ROUTER_PORT);
  if (!portStatus) {
    checks.push(check(`Router port :${ROUTER_PORT}`, PASS, "free"));
  } else if (ourRouterPid()) {
    checks.push(check(`Router port :${ROUTER_PORT}`, PASS, `held by our router (pid ${ourRouterPid()}) — fleet is up`));
  } else {
    checks.push(
      check(
        `Router port :${ROUTER_PORT}`,
        WARN,
        "held by another process (e.g. a stale daemon)",
        "that's fine — `kwb up` stops it automatically before starting the fleet.",
      ),
    );
  }

  // 9. Run/state dir writable (router pid, logs, fleet-state.json live here).
  let runOk = true;
  try {
    ensureRun();
    fs.accessSync(RUN, fs.constants.W_OK);
  } catch (e) {
    runOk = false;
    checks.push(check("Run state dir", FAIL, `${RUN} not writable (${e.code || e.message})`, "fix permissions on ~/.agent-webbridge/multi/run."));
  }
  if (runOk) checks.push(check("Run state dir", PASS, RUN));

  const summary = {
    pass: checks.filter((c) => c.status === PASS).length,
    warn: checks.filter((c) => c.status === WARN).length,
    fail: checks.filter((c) => c.status === FAIL).length,
  };
  return { checks, summary };
}

const ICON = { pass: "✓", warn: "!", fail: "✗" };

// Print a human report and return the process exit code (0 unless any FAIL).
export function printDoctor({ checks, summary }) {
  console.log("kwb doctor — environment self-check\n");
  for (const c of checks) {
    console.log(`  ${ICON[c.status]} ${c.name.padEnd(26)} ${c.detail}`);
    if (c.hint && c.status !== PASS) console.log(`      ↳ ${c.hint}`);
  }
  console.log(
    `\n${summary.pass} ok · ${summary.warn} warning${summary.warn === 1 ? "" : "s"} · ${summary.fail} failure${
      summary.fail === 1 ? "" : "s"
    }`,
  );
  if (summary.fail > 0) {
    console.log("\nFix the ✗ items above, then re-run `kwb doctor`.");
    return 1;
  }
  if (summary.warn > 0) {
    console.log("\nReady — the ! items are optional setup, not blockers.");
    return 0;
  }
  console.log("\nAll good. Try: kwb profiles");
  return 0;
}

// CLI: `node src/doctor.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(printDoctor(await runDoctor()));
}
