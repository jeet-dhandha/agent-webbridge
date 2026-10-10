# Chrome Web Store — Listing Metadata (Updated v1.3.2)

**Item name (strict ≤ 45 chars):**
```text
WebBridge: AI Browser Automation for Agents
```
*(Length: 44 chars)*

**Category:** Developer Tools  
**Language:** English (default_locale `en`)  
**Store URL:** https://chromewebstore.google.com/detail/agent-webbridge/kgnhhbkooeplfdkfnicgekdmegckcnpl  
**Developer Console:** https://chrome.google.com/webstore/devconsole/  

---

## Summary / Short Description (strict ≤ 132 chars)

```text
Let Claude Code, Cursor, and AI agents automate your real Chrome locally, with signed-in profiles and parallel tabs.
```
*(Length: 116 chars)*

---

## Detailed Description (Front-Loaded for Google Page 1 & AI Discovery)

```text
WebBridge (Agent WebBridge) connects Claude Code, Cursor, and AI agents to your real Chrome browser — 100% locally with zero cloud dependencies.

It pairs with the open-source `agent-webbridge` stdio Model Context Protocol (MCP) server and daemon (npm). The daemon listens strictly on `127.0.0.1`; this extension connects to it over local loopback WebSockets and executes commands via the Chrome DevTools Protocol (CDP) — attaching the debugger per tab, so multiple tabs and profiles run in parallel.

Every connection stays on your computer. The extension never contacts an external host — its only network destination is 127.0.0.1.

Core Capabilities for AI Agents:
• Real Browser Sessions: Drive your actual Chrome with existing cookies, active logins, and 2FA. No headless re-login walls or bot detection.
• True Parallelism: DevTools debugger attaches per tab in an internal Map, allowing concurrent multi-tab scraping and evaluation (~3.5s for 5 tabs vs 9.3s serial).
• Multi-Profile Routing: Automate multiple distinct Chrome profiles (Work, Personal, Developer) simultaneously behind loopback router 127.0.0.1:10086.
• Compact Element References: Extract LLM-friendly accessibility-tree snapshots with compact @e refs rather than bloated raw HTML.
• 13 Essential Tools: Navigate, click, trusted_click (isTrusted: true), fill (inputs & contenteditable), evaluate, screenshot to disk, PDF export, network capture, file upload, tab management.
• Visible & Revocable: Tasks live in explicit labeled tab groups (e.g. agent:mcp). Watch execution in real time or close the group to stop anytime.

Privacy & Security Guarantee:
WebBridge operates 100% on local loopback (127.0.0.1). Strict Host and Origin guards reject remote web traffic. No credentials, cookies, tokens, or browsing history are ever uploaded to cloud servers.

Requirements:
Requires the companion open-source agent-webbridge CLI & daemon:
npm i -g agent-webbridge && awb setup "Work"

MCP Server for Claude Code:
claude mcp add chrome -- npx -y agent-webbridge mcp

Source code: https://github.com/jeet-dhandha/agent-webbridge
MIT License. Open source browser automation for AI agents.
```

---

## Reviewer Test Instructions

```text
This extension is a bridge: it does nothing on its own and only becomes active when its open-source companion daemon is running locally. To reproduce full functionality:

1. Install Node.js ≥ 18.
2. npm i -g agent-webbridge
3. Run `awb up "Default"` (starts the local daemon on 127.0.0.1 and connects this extension).
4. Open the extension popup — it flips from Disconnected to Connected.
5. Send a test command:
   curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' -d '{"action":"navigate","args":{"url":"https://example.com"},"session":"test","profile":"Default"}'
   — a new tab opens at example.com inside a titled "test" tab group, driven by the extension.

Source code: https://github.com/jeet-dhandha/agent-webbridge
npm: https://www.npmjs.com/package/agent-webbridge
```
