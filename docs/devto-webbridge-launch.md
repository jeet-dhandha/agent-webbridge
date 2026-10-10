---
title: WebBridge for Agents - Multi-Profile Chrome Browser Automation & MCP Server for AI Agents (agent-webbridge)
published: true
description: Drive your real, logged-in Chrome with Claude Code, Cursor, and MCP clients across multiple profiles at once with true per-tab parallelism. 100% local, MIT.
tags: ai, webdev, chrome, opensource
canonical_url: https://jeet-dhandha.github.io/agent-webbridge/
cover_image: https://opengraph.githubassets.com/1/jeet-dhandha/agent-webbridge
---

## TL;DR / What is WebBridge?

**WebBridge** ([`agent-webbridge`](https://github.com/jeet-dhandha/agent-webbridge)) is an open-source (MIT), clean-room browser automation engine and stdio **Model Context Protocol (MCP)** server for AI agents. 

Unlike traditional headless scrapers that trigger Cloudflare captchas or official extensions restricted to a single tab, WebBridge drives your **real Google Chrome**—with your authentic login sessions, cookies, and 2FA—across **multiple profiles simultaneously**, with **true per-tab DevTools parallelism**.

- 🌐 **Interactive Documentation & Live Demos**: [jeet-dhandha.github.io/agent-webbridge](https://jeet-dhandha.github.io/agent-webbridge/)
- 📦 **npm Package**: [`agent-webbridge`](https://www.npmjs.com/package/agent-webbridge)
- 🧩 **Chrome Web Store**: [Agent WebBridge](https://chromewebstore.google.com/detail/agent-webbridge/kgnhhbkooeplfdkfnicgekdmegckcnpl)
- 📖 **Community Playbooks**: [awb-recipes](https://github.com/jeet-dhandha/awb-recipes)

---

## The Problem: Why Existing Browser Bridges Choke on Real Work

If you've tried giving AI agents (Claude Code, Cursor, Windsurf) access to a browser, you've likely hit these walls:

1. **Headless Scrapers (Playwright / Puppeteer)**: Bot protection (Cloudflare Turnstile, Akamai, Google reCAPTCHA) immediately flags them. Re-logging into Google, GitHub, or LinkedIn headlessly is painful and fragile.
2. **Single-Tab Bottlenecks**: Most browser extensions funnel every Chrome DevTools Protocol (CDP) command through a single global "active tab". If your agent needs to compare 5 documentation pages or scrape 10 search results, it has to wait serially.
3. **Single Account Concurrency**: You can't easily instruct an agent to inspect a deployment in your `Work` Google profile while drafting an issue in your `Personal` profile without manual tab switching.

---

## How WebBridge Solves It

```
caller (Claude / Cursor / curl)
          │ HTTP POST /command (port 10086) or stdio MCP
          ▼
   awb central router
     ├── Profile "Work"      ──▶ daemon (port 13336) ──▶ extension ──▶ Tabs 1, 2, 3 (parallel)
     ├── Profile "Personal"  ──▶ daemon (port 13222) ──▶ extension ──▶ Tabs 4, 5    (parallel)
     └── Profile "Developer" ──▶ daemon (port 13431) ──▶ extension ──▶ Tabs 6, 7    (parallel)
```

### 1. True Per-Tab CDP Parallelism
WebBridge attaches `chrome.debugger` per tab using an internal `Map` keyed by `tabId`. N tabs in one profile run concurrently:
- **Serial execution**: 5 tabs evaluating sleeping payloads take **~9.3 seconds**.
- **WebBridge parallel execution**: 5 tabs evaluate concurrently in **~3.5 seconds**.

### 2. Multi-Profile Fleet Orchestration
Behind a lightweight loopback router on `127.0.0.1:10086`, WebBridge manages isolated daemons for each Chrome profile. Pass `"profile": "Work"` or `"profile": "Personal"` in any command to drive multiple identities at once.

### 3. Community Recipes (`awb-recipes`)
Never let your agent guess fragile CSS selectors. WebBridge includes [awb-recipes](https://github.com/jeet-dhandha/awb-recipes)—structured, community-maintained JSON playbooks with battle-tested fallback selectors and anti-bot caveats for Google Search, GitHub Gists, Hacker News, LinkedIn, and more.

### 4. Zero Cloud, Zero Telemetry
Everything runs locally on `127.0.0.1`. No external relay, no accounts, and built-in security filters rejecting any unauthorized non-loopback Host or remote Origin requests.

---

## Architectural Comparison

| Feature | Headless Playwright | Cloud Browser APIs | Traditional Bridges | **WebBridge (`agent-webbridge`)** |
|---|---|---|---|---|
| **Real Logged-in Sessions** | ❌ Requires re-login | ❌ Isolated remote box | ✅ Yes | ✅ **Yes (Full 2FA & Cookies)** |
| **Multi-Profile Concurrency** | ❌ Complex setup | ❌ Costly | ❌ 1 profile | ✅ **Unlimited Profiles (N×M)** |
| **Per-Tab Parallelism** | ✅ Yes | ⚠️ Metered/Throttled | ❌ 1 Tab at a time | ✅ **True Parallel CDP (Map)** |
| **Bot Detection Bypass** | ❌ Frequently flagged | ⚠️ Varies | ✅ Authentic Chrome | ✅ **Authentic Chrome** |
| **MCP Integration** | ⚠️ Needs wrapper | ⚠️ Custom REST | ⚠️ Experimental | ✅ **Zero-dep stdio & HTTP MCP** |
| **Cost & Privacy** | Free / Local | $0.05–$0.20 / min | Free / Closed | **100% Free, MIT, 127.0.0.1** |

---

## 30-Second Setup for Claude Code & Cursor

### Step 1: Install CLI & Daemon
```bash
npm i -g agent-webbridge
awb setup "Work"
```
*(Follow the interactive prompt to load the unpacked extension into Chrome Developer mode.)*

### Step 2: Add to your MCP Config

#### For Claude Code:
```bash
claude mcp add chrome -- npx -y agent-webbridge mcp
```

#### For Claude Desktop / Cursor / Windsurf (`mcpServers`):
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["-y", "agent-webbridge", "mcp"]
    }
  }
}
```

---

## The 13 Headful Browser Tools Included

1. `navigate` — Open URLs, wait for network idle, or spawn new background tabs.
2. `find_tab` — Locate tabs across profiles by URL regex or page title.
3. `evaluate` — Execute sandboxed JS expressions in page context.
4. `snapshot` — Extract clean accessibility trees with stable `@e` element references.
5. `click` / `trusted_click` — Dispatch real CDP-level mouse events (`isTrusted: true`).
6. `fill` — Set input values with native event dispatching (supports `<input>`, `<textarea>`, and `contenteditable`).
7. `network` — Capture and inspect XHR/fetch request traffic.
8. `upload` — Handle native file input uploads.
9. `screenshot` — Capture full-page or viewport PNGs directly to disk.
10. `save_as_pdf` — Export pages to clean PDFs.
11. `list_tabs` — Inspect all open tabs and tab groups across profiles.
12. `close_tab` — Safely release debugger attachments and close tabs.
13. `close_session` — Clean up tab groups when tasks conclude.

---

## Links & Ecosystem

- **Documentation**: [https://jeet-dhandha.github.io/agent-webbridge/](https://jeet-dhandha.github.io/agent-webbridge/)
- **GitHub Repository**: [https://github.com/jeet-dhandha/agent-webbridge](https://github.com/jeet-dhandha/agent-webbridge)
- **Community Recipes**: [https://github.com/jeet-dhandha/awb-recipes](https://github.com/jeet-dhandha/awb-recipes)
- **Official MCP Registry**: `io.github.jeet-dhandha/agent-webbridge`

*Feedback, PRs, and community recipes are welcome! ⭐ Star the project on GitHub if you find it helpful!*
