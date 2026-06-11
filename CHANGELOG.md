# Changelog

All notable changes to **kimi-webbridge-fleet** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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

[0.0.2]: https://github.com/jeet-dhandha/kimi-webbridge-fleet/releases/tag/v0.0.2
[0.0.1]: https://github.com/jeet-dhandha/kimi-webbridge-fleet/releases/tag/v0.0.1
