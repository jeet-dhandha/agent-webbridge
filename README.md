# agent-webbridge — drive your real Chrome, across many profiles, in parallel

> Open-source (MIT), clean-room browser automation for AI agents. It drives **your real Chrome** — with your **real login sessions** — across **multiple Chrome profiles at once**, and runs **multiple tabs per profile concurrently**. No closed-source dependency, no account, no telemetry, no `curl | bash` installer.

`agent-webbridge` is a lightweight Node daemon (only runtime dependency: [`ws`](https://www.npmjs.com/package/ws)) plus a clean-room MV3 Chrome extension. An AI agent posts a command to a local router; the router fans it out to the right profile's daemon, which speaks to the extension, which attaches the Chrome DevTools Protocol **per tab**. Everything stays on `127.0.0.1` — no data ever leaves your machine.

## Why

It's **clean-room and standalone** — its own lightweight Node daemon and its own MV3 Chrome extension, with **no closed-source dependency, no account, no telemetry, and no bootstrap installer**. Install it from npm, load the extension once, and drive your real Chrome over localhost.

The killer feature is **true per-tab parallelism**.

Most browser-automation bridges funnel every CDP call through **one global "current tab"** — so they drive exactly one tab per profile at a time. `agent-webbridge` attaches `chrome.debugger` **per tab** (a `Map` keyed by tab), so **N tabs in one profile run concurrently**.

This is proven live and it **scales**: 2, 5, and **10 tabs in a single profile** each finish in **~2 seconds flat** (measured 2007 / 2007 / 2010 ms, with every tab's interval overlapping every other). The same work run serially would take 4 s → 10 s → **20 s**. Wall-clock stays flat as you add tabs — that's true N× per-profile parallelism.

Combine that with multiple profiles and you get two axes of concurrency at once: **N profiles × N tabs per profile**, all driven from a single endpoint.

## Install

**1. The daemon + CLI** (via npm):

```bash
npm i -g agent-webbridge
```

This puts the `awb` command on your PATH (with `kwb` kept as an alias) and brings the Node daemon. The only runtime dependency is `ws`.

**2. The Chrome extension** — a clean-room MV3 extension (stable id `ifodkkbkmngjlkhiphcjmbceeolhpfeo`) installed via Chrome's built-in **"Load unpacked"**. There is no Chrome Web Store listing — and you don't need one. Let the CLI walk you through it:

```bash
awb setup "Work"          # or any profile name / email / "Profile 2"
```

`awb setup` prints the exact extension folder, opens `chrome://extensions`, then **polls** while you do the one manual step Chrome requires: toggle **Developer mode** on (top-right) and click **Load unpacked** → pick that folder. As soon as it detects the load, it wires the profile to its daemon and brings the fleet up. Because the extension ships its public key in `manifest.json`, Chrome always derives the same stable id — the folder you load *is* the published build. (Manual steps: [Dev](#dev). Driving install from an agent: [`awb check --json`](#dev).)

**Requirements:** macOS + Google Chrome, and Node.js ≥ 18.

## 60-second Quickstart

```bash
# 1. One-time install — walks you through "Load unpacked", then connects + brings the fleet up.
#    Pass the profile(s) you want to drive (name / email / "Profile 2").
awb setup "Work" "Personal"

# 2. Already set up? Just bring the fleet up (setup already did this on first run).
awb up "Work" "Personal"

# 3. Drive any profile by name — same endpoint, one extra field
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://search.google.com/search-console"},"session":"audit","profile":"Work"}'

# 4. When done
awb down
```

Every command is a `POST /command` on the router at `127.0.0.1:10086`. A `"session"` groups a task's tabs into a Chrome tab group; a `"profile"` selects which Chrome profile to drive.

## Tools

Full parity with the official bridge — **13 tools, all verified live in a real browser**:

| Tool | What it does |
|---|---|
| `navigate` | Open a URL in a (new or existing) tab |
| `find_tab` | Locate an existing tab by URL / title |
| `evaluate` | Run JavaScript in the page and return the result |
| `snapshot` | Accessibility tree with stable `@e` refs for elements |
| `click` | Click an element (by `@e` ref) |
| `fill` | Set a value on native inputs **and** `contenteditable` fields |
| `network` | Capture network requests |
| `upload` | Upload a file to a file input |
| `screenshot` | Capture a screenshot of the page |
| `save_as_pdf` | Save the current page as a PDF |
| `list_tabs` | List the tabs in the current session |
| `close_tab` | Close a tab |
| `close_session` | Close a session and its tab group |

## Architecture

```
  AI agent / caller
        │  HTTP POST /command
        ▼
  ┌───────────────────────────┐
  │ router  (127.0.0.1:10086) │   routes by "profile"
  └───────────────────────────┘
        │
        ├──────────────┬───────────────┐
        ▼              ▼               ▼
  ┌───────────┐  ┌───────────┐   ┌───────────┐
  │  daemon   │  │  daemon   │   │  daemon   │   one Node daemon per profile
  │ (Profile  │  │ (Profile  │   │ (Profile  │   on a deterministic hashed port
  │   "Work") │  │"Personal")│   │    …)     │
  └───────────┘  └───────────┘   └───────────┘
        │  WebSocket
        ▼
  ┌───────────────────────────┐
  │  MV3 extension            │   clean-room, per profile
  └───────────────────────────┘
        │  chrome.debugger  (a Map: one attach PER TAB)
        ▼
  ┌───────────────────────────┐
  │  Chrome DevTools Protocol │   tab 1 ║ tab 2 ║ tab 3  (concurrent)
  └───────────────────────────┘
```

A caller POSTs to the **router**; the router proxies the command to the right **per-profile daemon** (chosen by the `"profile"` field) over its deterministic hashed port; the daemon relays over a **WebSocket** to that profile's **MV3 extension**; the extension attaches `chrome.debugger` **per tab** and issues **CDP** calls.

## Parallelism model

Two independent axes multiply:

- **Cross-profile** — one daemon per Chrome profile, each on its own deterministic hashed port, each with its own real login session. N profiles run side by side.
- **Per-tab** — within a single profile, the extension keeps a `Map` of `chrome.debugger` attachments, one per tab. N tabs in that profile run concurrently — the thing the official single-"current-tab" extension cannot do.

Total concurrency = **N profiles × N tabs per profile**, all addressed through the one router endpoint. Proven live: 2, 5, and **10 tabs in a single profile** each finish in ~2 s (2007 / 2007 / 2010 ms) — flat wall-clock, **10× parallelism** — versus serial time that grows linearly with tab count.

## CLI reference

The CLI is `awb` (with `kwb` kept as an alias — both invoke the same binary).

| Command | What it does |
|---|---|
| `awb setup <profile…>` | One-time install: walk you through "Load unpacked", then connect + bring the fleet up |
| `awb check [profile…] [--json]` | Read-only readiness probe (folder? dev-mode? loaded? connected?) — what an agent polls during install |
| `awb connect <profile…>` | Point each profile's extension at its own daemon |
| `awb up <profile…>` | Start the named profiles' daemons + the router, open windows, connect |
| `awb down` | Stop the router + fleet daemons |
| `awb status` | Fleet status — every profile's daemon + whether its extension is connected |
| `awb doctor` | Diagnose the environment (Chrome, profiles, daemon, extension) |
| `awb profiles` | List Chrome profiles, their hashed ports, and extension presence |

`<profile>` is anything that resolves uniquely — the profile **name** (`"Work"`), an **email**, or the Chrome **directory** (`"Profile 2"`).

## Dev

To run the extension from source during development:

1. Open `chrome://extensions/` in the target profile.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** (top-left).
4. Select the [`agent-webbridge-extension/`](agent-webbridge-extension/) directory in this repo (or run `npm root -g`/`npm i -g agent-webbridge` and load the `agent-webbridge-extension/` inside the installed package). `awb setup` prints the exact path.

Because the unpacked extension ships its public key in `manifest.json`, Chrome derives the same stable id (`ifodkkbkmngjlkhiphcjmbceeolhpfeo`) every time — the "dev" build and the released build are the same artifact.

**Driving install from an agent.** `awb check [profile…] --json` is a read-only readiness probe an orchestrating agent can poll: for each profile it reports whether the extension folder is present, **Developer mode** is on, the extension is **loaded + enabled**, and the daemon is **up + connected**, plus a single `nextStep` hint. Loop on it until `ready: true`, guiding the user through the one Chrome click in between.

## Verified

Daemon contract test **11/11 PASS** · adversarial interface audit **0 defects** · M1 live **7/7** + scaling **6/6** (2 / 5 / 10 tabs in one profile all fully parallel, flat ~2 s wall-clock) · M2 live **19/19** (all 13 tools verified in a real browser, Chrome for Testing 149) · **real-consumer gate**: the external `yc_scan.ts` scraper ran end-to-end against live ycombinator.com through the stack — harvested **144 companies**, scraped 5 in parallel (10-tab concurrency), exit 0.

## Platform

**macOS-first.** The profile launcher / connect layer uses AppleScript, so macOS + Google Chrome is the supported platform today. Linux / Windows support is a documented follow-up.

## License

MIT © jeet-dhandha
