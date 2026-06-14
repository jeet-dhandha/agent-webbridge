# AGENTS.md — contributor & repo guide for agent-webbridge

`agent-webbridge` is clean-room, open-source (MIT) browser automation for AI agents. It drives
the user's **real Chrome** — with their **real login sessions** — across **multiple Chrome
profiles in parallel**, and within a single profile it runs **multiple tabs concurrently**. No
account, no telemetry, no closed-source dependency, no `curl | bash` installer.

This file is the map of the repo for anyone (human or agent) about to make a change. For the
end-user "how do I drive it" doc, see `README.md`; for the exhaustive contract, see `BUILD_SPEC.md`.

> Scope: **macOS-first** (the profile launcher / connect layer uses AppleScript). Linux/Windows
> is a documented follow-up. Node `>=18`.

## What this is

agent-webbridge is a **clean-room, standalone** browser-automation stack: our own daemon and our
own MV3 Chrome extension, plus a multi-profile orchestration layer (routing, connect, lifecycle)
on top. Every piece is ours — fully owned and patchable — with **no closed-source dependency,
no account, and no telemetry**.

The killer feature this unlocked: **true per-tab parallelism**. The official extension funnels
every CDP call through one global "current tab" (so effectively one tab per profile). Our
extension attaches `chrome.debugger` **per tab** (a `Map`), so N tabs in one profile run
concurrently — proven live, two tabs evaluating in parallel at ~2007 ms wall vs ~4000 ms serial.

## Architecture

```
caller ──HTTP POST /command──▶ router (127.0.0.1:10086)
                                  │  routes by top-level "profile" field
                                  ▼
                        per-profile Node daemon  (deterministic hashed port)
                                  │  WebSocket /ws
                                  ▼
                        MV3 extension  ──per-tab chrome.debugger──▶ Chrome DevTools Protocol
```

Parallelism is two-dimensional: **cross-profile** (N profiles, each its own daemon) ×
**per-tab** (N tabs/profile, each its own debugger attachment). A "session" groups a task's tabs
into a Chrome tab group. For large batch jobs this composes into a **fleet fan-out**: split a
worklist across N profiles × M tabs (total concurrency = N×M) and write output **incrementally**
so an interrupted run resumes from the remainder instead of redoing work — see the
high-throughput section in [SKILL.md](SKILL.md). All profiles share one egress IP, so widening
fan-out helps when visiting many distinct sites but not when hammering a single rate-limited service.

## Repo layout

| Path | What lives here |
| --- | --- |
| `bin/agent-webbridge.mjs` | Daemon entrypoint — thin wrapper that runs `src/daemon`. |
| `bin/kwb.mjs` | The CLI (`awb`, with `kwb` as an alias). Subcommands: `setup`, `connect`, `up`, `down`, `status`, `doctor`, `profiles` (plus `state`, `tabs`, `resolve`, `install`). |
| `src/daemon/` | **Our clean-room daemon.** Only runtime dep is `ws`. `index.mjs` (CLI start/stop/status, self-backgrounds), `server.mjs` (HTTP `/command` + `/status`), `wshub.mjs` (WebSocket `/ws` to the extension), `envelope.mjs` (command envelopes), `registry.mjs`, `lifecycle.mjs` (pid file), `diskwriter.mjs`. |
| `src/` (fleet) | Multi-profile orchestration: `router.mjs` (the `:10086` router), `fleet.mjs`, `profiles.mjs` (profile discovery + hashed ports), `extension.mjs`, `storage.mjs` (LevelDB `local_url` write), `connect`/`up`/`down` glue, `runstate.mjs`, `snss.mjs` (session/tab read), `doctor.mjs`. |
| `agent-webbridge-extension/` | **Our clean-room MV3 extension** (stable id `ifodkkbkmngjlkhiphcjmbceeolhpfeo`). `manifest.json`, `background.js`, `popup.{html,js}`, `icon/`, `src/`. Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`; host_permissions `["<all_urls>"]`. Connects **only** to a daemon on `127.0.0.1`. |
| `test/contract.mjs` | Browser-free daemon contract test (see below). |
| `scratch/live_m1.mjs` | M1 live gate: per-tab parallelism, in isolated Chrome for Testing. |
| `scratch/live_m2.mjs` | M2 live gate: all 13 tools verified, in isolated Chrome for Testing. |
| `BUILD_SPEC.md` | The authoritative command/envelope contract the daemon implements. |
| `README.md` / `SKILL.md` | End-user usage and the Claude Code skill. |

## The 13 tools (full parity, all verified live)

`navigate`, `find_tab`, `evaluate`, `snapshot` (accessibility tree with stable `@e` refs),
`click`, `fill` (native inputs **and** contenteditable), `network` (request capture), `upload`,
`screenshot`, `save_as_pdf`, `list_tabs`, `close_tab`, `close_session`.

## Install & local dev

```bash
# As a user
npm i -g agent-webbridge          # installs the daemon + CLI (bin: awb, kwb alias)

# From a checkout (no build step — pure ESM Node)
npm install                       # only dep: ws
node bin/kwb.mjs profiles         # `awb <cmd>` == `node bin/kwb.mjs <cmd>`
```

The Chrome extension installs via Chrome's **"Load unpacked"** of `agent-webbridge-extension/`
(there is no Chrome Web Store listing). `awb setup <profile…>` walks a user — or an agent
polling `awb check --json` — through it: it prints the exact folder, opens `chrome://extensions`,
waits for Developer-mode + Load-unpacked, then connects + brings the fleet up.

## Tests

There is no transpile/build step; everything is ESM Node `>=18`.

**Contract test (no browser):**

```bash
npm test            # → node test/contract.mjs
```

`test/contract.mjs` boots the real daemon on a free port via `bin/agent-webbridge.mjs`,
connects a **stub** extension over the WebSocket `/ws` (no real Chrome), serves canned tool
results, and asserts the daemon's `/command` envelopes match `BUILD_SPEC` §1 — including the
not-connected path and the screenshot disk-write side effect. Exits non-zero on any failed
assertion. **Status: 11/11 PASS.**

**Live gates (require Chrome for Testing):**

```bash
# Point KWB_CHROME_BIN at a Chrome / Chrome for Testing binary, then:
KWB_CHROME_BIN="/path/to/Google Chrome for Testing" node scratch/live_m1.mjs   # → 7/7
KWB_CHROME_BIN="/path/to/Google Chrome for Testing" node scratch/live_m2.mjs   # → 19/19
```

Both live scripts are **fully isolated** — they cold-start a throwaway Chrome with a fresh
`--user-data-dir` and load the unpacked `agent-webbridge-extension/`; they **never touch the
user's real Chrome or profiles**. `live_m1.mjs` drives two tabs to evaluate concurrently and
asserts their in-page sleep intervals overlap (true per-tab parallelism). `live_m2.mjs` serves a
controlled test page and exercises every one of the 13 tools with real assertions. If
`KWB_CHROME_BIN` is unset, the scripts fall back to a default Chrome path; prefer Chrome for
Testing so the run is reproducible and never collides with your daily browser.

> Per the project's verification discipline: don't stop at the contract test. Any change to the
> daemon, extension, fleet, or parallelism path must be re-validated against the live gates.

## CLI surface (unchanged)

`awb setup`, `connect`, `up`, `down`, `status`, `doctor`, `profiles`. The router lives on
`127.0.0.1:10086`; per-profile daemons bind a deterministic hashed port and never use `:10086`.
The router idle-auto-closes the daemon **processes only** after a timeout — it never closes your
browser tabs.

## Drive it: the `/command` HTTP contract

POST to the router on `:10086`. The body is the normal command body **plus** a top-level
`"profile"` field selecting the target profile. The router strips `"profile"` and proxies the
rest to that profile's daemon. **Omit `"profile"`** to hit the default profile.

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com"},"session":"audit","profile":"Work"}'
```

`"profile"` accepts a name, email, or Chrome directory — anything that resolves uniquely.

## Privacy & security invariants (do not break)

- The extension connects **only** to `127.0.0.1` — a daemon the user runs locally.
- No data leaves the machine; no remote server is ever contacted; no analytics; no account.
- The daemon's only runtime dependency is `ws`. Keep it that way — no new runtime deps without
  a very good reason.
- MIT, clean-room — every line is ours. No closed-source dependency, no account, no telemetry.

## House rules

- Pure ESM, Node `>=18`, no build step. Match the existing terse, comment-led module style.
- Branch before committing; never commit straight to `main`.
- If you change anything in `src/daemon/`, `agent-webbridge-extension/`, or the parallelism path,
  run `npm test` **and** both live gates before claiming it works.
