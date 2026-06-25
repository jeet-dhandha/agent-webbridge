# Changelog

All notable changes to **agent-webbridge** (formerly **kimi-webbridge-fleet**) are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.2] — 2026-06-25

**Official Chrome Web Store build.** `agent-webbridge` is now on the Chrome Web Store, and
`awb setup` installs it from there (click **Add to Chrome**) instead of guided Load-unpacked.

Added
- Chrome Web Store listing:
  https://chromewebstore.google.com/detail/agent-webbridge/kgnhhbkooeplfdkfnicgekdmegckcnpl
- `AWB_EXT_ID_STORE` (`kgnhh…`) + `CWS_LISTING_URL`. The daemon now recognizes **both** the
  store id and the Load-unpacked dev id (`ifodk…`): `isKimiExt` / `hasKimiExtension` and the
  on-disk orphan scan all match against `AWB_EXT_IDS` (store id first).

Changed
- `awb setup` opens the Web Store listing and polls for **Add to Chrome**. Developers use
  `awb install-dev` for the in-repo Load-unpacked build.
- Force-install policy (`forceInstallValue`) now targets the store id — the only id Chrome can
  fetch a CRX for.
- README / INSTALL / SKILL docs updated to "Add to Chrome" as the primary install; the new
  bridge icon ships in the package.

## [1.1.1] — 2026-06-23

**Docs polish + version sync.** README rewritten to a clean, minimal, concept-first
shape (overview bullets, one-block install, tightened "how it works"); removed the
"no Chrome Web Store" framing now that a store listing is in progress.

Changed
- README streamlined (~10.2 KB → ~6 KB) without dropping any of the install → setup →
  drive → tools → CLI workflow.
- Extension `manifest.json` version synced `1.0.2` → `1.1.1` to match the package
  (prep for the first Chrome Web Store upload).

## [1.1.0] — 2026-06-16

**Rebrand to `agent-webbridge` / `awb`.** The project's local identity is now fully
`agent-webbridge` and the CLI is `awb`. (The GitHub repo, npm package, plugin, and Chrome
extension were already named `agent-webbridge`; this release finishes the job in the code,
the CLI, the env vars, and the on-disk layout.)

### Changed
- CLI binary renamed `bin/kwb.mjs` → `bin/awb.mjs`; `awb` is now the sole command.
- Environment variables renamed `KWB_*` → `AWB_*` (e.g. `KWB_CHROME_BIN` → `AWB_CHROME_BIN`,
  `KWB_IDLE_TIMEOUT_MIN` → `AWB_IDLE_TIMEOUT_MIN`, `KWB_KIMI_BIN` → `AWB_DAEMON_BIN`).
- Internal identifiers de-Kimi'd (`kimiExtId` → `awbExtId`, `KIMI_EXT_ID(S)` → `AWB_EXT_ID(S)`,
  `KIMI_BIN` → `DAEMON_BIN`).
- Skill folder renamed `skills/kimi-webbridge-fleet/` → `skills/agent-webbridge/`.

### Removed
- The `kwb` back-compat CLI alias. Use `awb` (it is the same binary, just the one name now).

## [1.0.2] — 2026-06-14

**Bug fix: tool calls (`list_tabs`, etc.) no longer flap when a second webbridge extension is
present.** Symptom seen live: `list_tabs` oscillating between the real tabs and an empty list
on a ~5-second cycle while `/status` reported `connected:true` the whole time.

### Fixed
- **The daemon no longer lets an unidentified extension hijack the WebSocket slot.** With two
  webbridge extensions installed in the same Chrome profile (e.g. a leftover legacy build
  alongside the current one), both connected to the daemon and fought over its single
  extension slot: `adoptSocket`'s blind newest-connection-wins let each evict the other on its
  5-second reconnect, so tool calls hit whichever extension happened to own the slot at the
  time. The hub now adopts a socket **only after a valid hello**, and **rejects hellos with no
  `extensionId`**, so the real extension stays pinned and a stray/legacy one is shut out.
- Hardened the rest of the WS connection handling around that change: a socket that connects
  but never sends a valid hello is now reaped after a handshake timeout (it's never adopted,
  so the ping keepalive couldn't reap it); `pong`/`tool_result` frames are only honored from
  the currently-adopted socket; and the extension's wake path (`GET_STATUS`) now triggers a
  reconnect on an already-running worker, so `awb up` re-establishes the link immediately
  instead of waiting out the 5-second reconnect timer.

### Added
- **`POST /reconnect`** on the per-profile daemon — force-drops the currently bound extension
  socket so the live worker re-handshakes. `awb up` now uses it to force a fresh reconnect
  instead of no-op'ing "already connected", giving single-step recovery of a wedged connection
  (no `awb down && awb up` needed).
- **`AWB_WSHUB_DEBUG=<file>`** — opt-in WS-hub connection log (CONNECT / HELLO / CLOSE with peer
  address + extension id/version), off by default. This is the instrumentation that pinpointed
  the slot-flap above.

## [1.0.1] — 2026-06-14

**Load-unpacked install, agent-driven — and a fully clean rebrand.** There is no Chrome Web
Store listing, so "Load unpacked" is now the single, first-class install path, and the landing
page + docs drop the Kimi brand entirely.

### Added
- **`awb check [profile…] [--json]`** — a read-only install-readiness probe an orchestrating
  agent can poll: per profile it reports `developerMode`, `loaded`, `enabled`, `daemonUp`,
  `connected`, a `ready` boolean, and a single `nextStep` hint. Exits non-zero until every
  selected profile is ready.
- **`profiles.developerModeOn(dir)`** — reads `extensions.ui.developer_mode` from Secure
  Preferences (the precondition for "Load unpacked").
- **`INSTALL.md`** — standalone install guide (npm path + manual release-zip path +
  troubleshooting); shipped in the npm package and attached to the GitHub Release.

### Changed
- **`awb setup` is Load-unpacked-only.** It resolves the in-repo extension folder + stable id,
  repairs corrupt installs, opens `chrome://extensions`, prints the exact folder, and **polls**
  the registry until the load lands (no blocking Enter — an agent can drive it), then connects
  and brings the fleet up. New flags: `--no-open`, `--no-up`, `--timeout`.
- **Dropped the Chrome Web Store path** from `awb setup`, `awb install-dev`, the doctor hint,
  and `scripts/pack-extension.mjs` (the zip is now the downloadable "Load unpacked" bundle).
- **Full clean rebrand:** removed every Kimi/Moonshot reference and the now-false "orchestrates
  the stock Kimi daemon" positioning from the landing page (`docs/`), README, SKILL.md, AGENTS.md,
  and the plugin description; reframed the per-tab-parallelism comparison generically;
  regenerated `docs/demo.gif`; fixed the GitHub Pages SEO URLs.

### Fixed
- `unpackedExtPath()` resolved to the deleted `../kimi-webbridge-extension` dir, breaking
  `awb setup`/`awb up` on a clean checkout — now points at `agent-webbridge-extension/`.

### Removed
- `docs/cws/` (Chrome Web Store submission copy) and two unlinked reverse-engineering docs —
  obsolete under the no-CWS, clean-room positioning.

## [1.0.0] — 2026-06-13

**The pivot to a fully clean-room, open-source stack.** `kimi-webbridge-fleet` evolved into
**agent-webbridge** by replacing the two closed pieces it used to supervise — the 9.5 MB
closed-source "kimi-webbridge" Go daemon and the un-patchable official "Kimi WebBridge" Chrome
Web Store extension — with our own. The result: **no closed-source dependency, no account, no
telemetry, no `curl | bash` installer.** MIT, clean-room, contains no Kimi WebBridge code.

### Added
- **Clean-room Node daemon (`src/daemon/`).** Drop-in replacement for the closed Go daemon; the
  only runtime dependency is `ws`. Speaks the same HTTP `/command` + `/status` contract and a
  WebSocket `/ws` to the extension. Self-backgrounds on `start`. Shipped via npm.
- **Clean-room MV3 Chrome extension (`agent-webbridge-extension/`,** stable id
  `ifodkkbkmngjlkhiphcjmbceeolhpfeo`**).** Replaces the official CWS extension and is fully
  patchable. Permissions: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`; host_permissions
  `["<all_urls>"]`. Connects **only** to a daemon on `127.0.0.1` — no remote server, ever.
- **True per-tab parallelism — the killer feature.** The official extension funneled every CDP
  call through one global "current tab" (one tab per profile). Ours attaches `chrome.debugger`
  **per tab** (a `Map`), so N tabs in one profile run concurrently. Proven live: two tabs
  evaluate in parallel at **2007 ms wall vs ~4000 ms serial**.
- **Full 13-tool parity, all verified live in a real browser:** `navigate`, `find_tab`,
  `evaluate`, `snapshot` (accessibility tree with stable `@e` refs), `click`, `fill` (native
  inputs **and** contenteditable), `network` (request capture), `upload`, `screenshot`,
  `save_as_pdf`, `list_tabs`, `close_tab`, `close_session`. A "session" groups a task's tabs into
  a Chrome tab group.
- **npm package `agent-webbridge`.** `npm i -g agent-webbridge` brings the daemon + CLI.
- **CLI `awb`, with `kwb` kept as an alias.** Existing subcommands are unchanged: `setup`,
  `connect`, `up`, `down`, `status`, `doctor`, `profiles`.
- **Verification harness.** Browser-free daemon contract test (`test/contract.mjs`, `npm test`,
  11/11 PASS) plus isolated Chrome-for-Testing live gates (`scratch/live_m1.mjs` 7/7 — per-tab
  parallelism; `scratch/live_m2.mjs` 19/19 — all 13 tools). Adversarial interface audit: 0 defects.

### Changed
- **Replaced the closed stack.** No longer supervises the closed Go daemon or the official CWS
  extension; the fleet orchestration in `src/` now sits on pieces we fully own and can patch.
- Architecture unchanged in shape — caller → router (`127.0.0.1:10086`) → per-profile daemon
  (deterministic hashed port) → WebSocket → extension → per-tab CDP — but every box below the
  router is now our own code.

### Notes
- macOS-first (the profile launcher/connect layer uses AppleScript); Linux/Windows is a
  documented follow-up. Node `>=18`.
- No closed-source dependency, no account, no telemetry. Nothing leaves the machine.

## [0.0.2] — 2026-06-11

### Added
- **Interactive setup command (`kwb setup-interactive <profile...>`):** Automates the onboarding of new profiles by opening the Chrome Web Store to install the extension, writing daemon config to LevelDB, and starting the daemon.
- **Automatic Startup Tab Cleanup:** Automatically closes annoying `about:blank` and `chrome-extension://.../popup.html` tabs opened during the extension wake process as soon as the profile connects. Smart preservation ensures that if no other tabs are open, one `about:blank` tab is kept to keep the window open, maintaining the extension connection.

## [0.0.1] — 2026-06-08

First tagged release. Drives multiple real Chrome profiles (separate Google logins)
simultaneously through Kimi WebBridge — one daemon per profile, one router on `:10086`,
routed by a top-level `"profile"` field.

### Added
- **Zero-click connect — now fully end-to-end.** Pointing each profile's extension at its
  own daemon needs no popup click, in two halves:
  - **Write** the daemon URL straight into the extension's `storage.local` LevelDB
    (`local_url`) while Chrome is closed — pure Node, no CDP, no deps (`kwb connect`).
  - **Wake** the dormant MV3 service worker so it actually applies that URL, by opening the
    extension's popup page (`chrome-extension://<id>/popup.html`) headful via the Chrome
    binary. Without this the write never took effect on an already-set-up profile (the
    worker registers no `onStartup` listener, so Chrome never starts it on launch).
    Verified live on real profiles and on a throwaway copy.
- **Registry-based extension detection.** Reads Chrome's `Secure Preferences` registry and
  matches the extension **by name**, reading back whatever id Chrome assigned — so
  unpacked / "Load unpacked" developer-mode builds are detected too (the old
  `Extensions/<id>` folder check missed them). `kwb profiles` shows `store` / `unpacked`.
- **Idle auto-close.** The router closes the fleet itself after `KWB_IDLE_TIMEOUT_MIN`
  minutes (default `120`) with no `/command` — it stops the daemon **processes only** and
  **never closes your browser tabs**; restores the stock `:10086` daemon unless
  `KWB_IDLE_NO_RESTORE`.
- **Run-state recording + `kwb state`.** Records the last start (timestamp, per-profile
  connected, all-connected?) and stop reason (manual / idle) in
  `~/.kimi-webbridge/multi/run/fleet-state.json`.
- **`kwb connect` / `kwb connect --restore`** commands; `kwb up` now wakes each extension
  and polls until connected; the router logs to `run/router.log`.
- **Installable three ways.** Published to npm (`npx kimi-webbridge-fleet`), and packaged as
  a Claude Code plugin / Agent Skill — ships `.claude-plugin/plugin.json` +
  `.claude-plugin/marketplace.json` with the skill at `skills/kimi-webbridge-fleet/SKILL.md`,
  so `/plugin marketplace add jeet-dhandha/kimi-webbridge-fleet` →
  `/plugin install kimi-webbridge-fleet@kwb` installs it straight from GitHub.

### Changed
- Profile windows are launched via the Chrome binary directly (headful), not macOS `open`
  — `open` doesn't reliably forward a `chrome-extension://` URL.

### Notes
- macOS + Google Chrome only. Requires the stock Kimi WebBridge daemon + extension.
- Not affiliated with Moonshot AI / Kimi; contains no Kimi WebBridge code.

[1.1.0]: https://github.com/jeet-dhandha/agent-webbridge/releases/tag/v1.1.0
[1.0.2]: https://github.com/jeet-dhandha/agent-webbridge/releases/tag/v1.0.2
[1.0.1]: https://github.com/jeet-dhandha/agent-webbridge/releases/tag/v1.0.1
[1.0.0]: https://github.com/jeet-dhandha/agent-webbridge/releases/tag/v1.0.0
[0.0.2]: https://github.com/jeet-dhandha/kimi-webbridge-fleet/releases/tag/v0.0.2
[0.0.1]: https://github.com/jeet-dhandha/kimi-webbridge-fleet/releases/tag/v0.0.1
