# Chrome Web Store — listing copy

**Item name:** Agent WebBridge
**Category:** Developer Tools
**Language:** English (default_locale `en`)

## Short description (≤ 132 chars)

> Let a local AI agent drive your real Chrome over 127.0.0.1 — open, read, click,
> fill, screenshot. Fully local. Open source.

(123 chars.)

## Detailed description

> **Agent WebBridge connects a local AI agent to your own Chrome — and nothing leaves
> your machine.**
>
> It pairs with the open-source `agent-webbridge` Node daemon (npm) you run locally.
> The daemon listens on `127.0.0.1`; this extension connects to it over a localhost
> WebSocket and carries out commands using the Chrome DevTools Protocol — attaching the
> debugger *per tab*, so several tabs can be automated at the same time.
>
> Every connection stays on your computer. The extension never contacts an external
> host — its only network connection is `127.0.0.1`.
>
> **What the agent can do**
> - Navigate to a URL in a new or existing tab
> - Read a page: accessibility-tree snapshot with stable element refs, or run JS and return the result
> - Act on a page: click elements, fill native inputs and contenteditable fields, upload files
> - Capture: take a screenshot, save the page as PDF, record network requests
> - Organize: group each task's tabs into a labelled Chrome tab group you can see, then close it when done
>
> **Why use it**
> - **Drive your real browser** — your actual Chrome, your actual logins. No headless re-login.
> - **Tabs run in parallel** — the debugger attaches per tab, so tabs run concurrently.
> - **Fully local & private** — your own daemon, your own extension, no cloud, no account. Everything stays on 127.0.0.1.
> - **Visible & revocable** — each task lives in its own titled tab group; you always see what the agent is doing.
>
> **Who it's for:** developers and power users who want to give a local AI agent
> hands-on control of a real, logged-in Chrome — without shipping browsing data to the cloud.
>
> **Requires** the companion open-source agent-webbridge daemon (Node.js) running on
> your machine: https://github.com/jeet-dhandha/agent-webbridge
>
> Open source (MIT).

## Reviewer test instructions (REQUIRED — the extension is inert without the daemon)

> This extension is a bridge: it does nothing on its own and only becomes active when
> its open-source companion daemon is running locally. To reproduce full functionality:
>
> 1. Install Node.js ≥ 18.
> 2. `npm i -g agent-webbridge`
> 3. Run `awb up "Default"` (starts the local daemon on 127.0.0.1 and connects this extension).
> 4. Open the extension popup — it flips from **Disconnected** to **Connected**.
> 5. Send a test command:
>    `curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' -d '{"action":"navigate","args":{"url":"https://example.com"},"session":"test","profile":"Default"}'`
>    — a new tab opens at example.com inside a titled "test" tab group, driven by the extension.
>
> Source code: https://github.com/jeet-dhandha/agent-webbridge · npm:
> https://www.npmjs.com/package/agent-webbridge · A short screen recording can be provided on request.

## Required graphics (to produce)

- **Icon:** 128×128 — already in `agent-webbridge-extension/icon/128.png`.
- **Screenshots:** at least 1, up to 5, at **1280×800** or **640×400** (PNG/JPEG).
  Suggested: (1) popup in "Connected" state; (2) a titled tab group mid-automation;
  (3) the one-line POST /command + the resulting driven tab.
- **Small promo tile (optional, recommended):** 440×280.
