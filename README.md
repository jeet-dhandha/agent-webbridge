# agent-webbridge

[![npm](https://img.shields.io/npm/v/agent-webbridge)](https://www.npmjs.com/package/agent-webbridge)
[![license](https://img.shields.io/npm/l/agent-webbridge)](LICENSE)
[![node](https://img.shields.io/node/v/agent-webbridge)](https://nodejs.org)

> Let an AI agent drive **your real Chrome** — with your **real logins** — across **many profiles and many tabs at once**. One local endpoint, no account, no telemetry, nothing leaves `127.0.0.1`.

`agent-webbridge` is a tiny Node daemon (one runtime dependency: [`ws`](https://www.npmjs.com/package/ws)) plus a clean-room MV3 Chrome extension. An agent POSTs a command to a local router → the router fans it out to the right profile's daemon → the extension attaches the Chrome DevTools Protocol **per tab**.

## Overview

- **Drive your real browser** — your actual Chrome, your actual login sessions. No headless re-login, no scraping around auth.
- **Run tabs in parallel** — the extension attaches `chrome.debugger` per tab, so N tabs in one profile run concurrently. 10 tabs finish as fast as 1 (~2 s, flat).
- **Span multiple profiles** — one daemon per profile. Total concurrency = **profiles × tabs**, all from one endpoint.
- **Stay private** — own daemon, own MV3 extension, no closed-source dependency, no account. Everything is local.

## Install

```bash
npm i -g agent-webbridge        # 1. the daemon + the `awb` CLI
awb setup "Work"                # 2. walks you through Chrome's "Load unpacked", then connects
```

`awb setup` prints the extension folder, opens `chrome://extensions`, and **polls** while you do the one manual step — toggle **Developer mode** and click **Load unpacked** → pick that folder. As soon as it detects the load, it wires the profile to its daemon and brings the fleet up.

**Requirements:** macOS · Google Chrome · Node.js ≥ 18.

## Quickstart

```bash
awb up "Work" "Personal"        # bring profiles up (setup did this on first run)

# Drive any profile by name — same endpoint, one extra field
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://news.ycombinator.com"},"session":"scan","profile":"Work"}'

awb down                        # stop the fleet when done
```

Every call is a `POST /command` on `127.0.0.1:10086`. `"session"` groups a task's tabs into one Chrome tab group; `"profile"` picks which Chrome profile to drive.

## Tools

| Tool | Does |
|---|---|
| `navigate` | Open a URL in a new or existing tab |
| `find_tab` | Locate a tab by URL / title |
| `evaluate` | Run JavaScript in the page, return the result |
| `snapshot` | Accessibility tree with stable `@e` element refs |
| `click` | Click an element by `@e` ref |
| `fill` | Set native inputs **and** `contenteditable` fields |
| `upload` | Upload a file to a file input |
| `screenshot` | Capture a page screenshot |
| `save_as_pdf` | Save the page as a PDF |
| `network` | Capture network requests |
| `list_tabs` | List the session's tabs |
| `close_tab` | Close a tab |
| `close_session` | Close a session and its tab group |

## How it works

```
  AI agent  ──HTTP POST /command──▶  router (127.0.0.1:10086)   routes by "profile"
                                          │
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                  daemon "Work"      daemon "Personal"     daemon …      one per profile
                       │  WebSocket
                       ▼
                  MV3 extension      ──chrome.debugger (a Map: one attach PER TAB)──▶
                       │
                       ▼
                  Chrome DevTools Protocol      tab 1 ║ tab 2 ║ tab 3   (concurrent)
```

The router proxies each command to the per-profile daemon on its deterministic hashed port; the daemon relays over WebSocket to that profile's extension; the extension keeps a `Map` of `chrome.debugger` attachments — one per tab — and issues CDP calls. That per-tab map is the whole trick: bridges that funnel everything through a single "current tab" can only drive one tab per profile; this drives N.

## CLI

| Command | Does |
|---|---|
| `awb setup <profile…>` | One-time install: walk through "Load unpacked", connect, bring the fleet up |
| `awb up <profile…>` | Start the named profiles' daemons + router, open windows, connect |
| `awb down` | Stop the router + fleet |
| `awb connect <profile…>` | Point each profile's extension at its daemon |
| `awb check [profile…] [--json]` | Read-only readiness probe (folder? dev-mode? loaded? connected?) — what an agent polls during install |
| `awb status` | Per-profile daemon + extension-connection status |
| `awb doctor` | Diagnose the environment (Chrome, profiles, daemon, extension) |
| `awb profiles` | List Chrome profiles, their hashed ports, and extension presence |

`<profile>` is anything that resolves uniquely — the profile **name** (`"Work"`), an **email**, or the Chrome **directory** (`"Profile 2"`).

## Use it from an AI agent

Ship it as a [Claude Code skill / plugin](.claude-plugin/) — the bundled `agent-webbridge` skill teaches an agent the full flow (install via `awb check --json`, then drive over `POST /command`). For development, load the extension from source: `chrome://extensions` → Developer mode → Load unpacked → [`agent-webbridge-extension/`](agent-webbridge-extension/). Because the extension ships its public key, Chrome derives the same stable id every time — the dev build and the released build are the same artifact.

## Platform

**macOS-first** — the profile launcher uses AppleScript, so macOS + Google Chrome is supported today. Linux / Windows are a documented follow-up.

## License

MIT © jeet-dhandha
