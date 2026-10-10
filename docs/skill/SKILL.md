---
name: agent-webbridge
description: Control the user's real, signed-in Google Chrome profiles in parallel using Agent WebBridge. Retains authentic logins, cookies, and 2FA. Built for Claude Code, Google Gemini, Qwen, Cursor, Windsurf, and DeepSeek. Supports multi-profile routing, per-tab CDP concurrency, accessibility tree snapshots (@e refs), trusted clicks, and framework input automation.
license: MIT
metadata:
  version: 1.3.2
  category: browser-automation
  protocol: Model Context Protocol (MCP) & HTTP REST
  compatible_assistants: ["Claude Code", "Gemini CLI", "Qwen Code", "Cursor", "Windsurf", "DeepSeek"]
---

# Agent WebBridge: Universal Agent Skill

Drive the user's **actual Google Chrome browser** with their real sessions, saved cookies, and active logins across multiple profiles and parallel tabs.

## 1. Quick Verification
Ensure the daemon is running before dispatching browser commands:
```bash
awb status
```
If not running:
```bash
awb up "<profile-name>"   # e.g., awb up "Work" or awb up "Default"
```

## 2. Command Dispatch Helper (Shell / cURL)
When communicating over shell or cURL, use this single-line helper:
```bash
cmd(){ curl -s -m 60 -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' -d "$1"; echo; }
```

### Universal Envelope Contract
Every command specifies `action`, `session`, and optional `profile`:
```json
{
  "action": "navigate | evaluate | click | trusted_click | fill | snapshot | screenshot | upload | close_session",
  "args": {},
  "session": "task-name",
  "profile": "Work"
}
```

## 3. Essential Tool Matrix

| Action | Key Arguments | Return Value | Description |
|---|---|---|---|
| `navigate` | `url`, `newTab` (bool), `group_title` | `{tabId, url}` | Navigates or opens tab; creates labeled tab group |
| `snapshot` | none | `{tree, title, url}` | Returns semantic accessibility tree with `@e` element refs |
| `click` | `selector` (CSS or `@e` ref) | `{success, tag}` | Synthetic element click |
| `trusted_click`| `selector` or `x, y` | `{success, hit}` | Real CDP mouse input (`isTrusted: true`) |
| `fill` | `selector`, `value` | `{success, mode}` | Fills inputs, textareas, and contenteditable elements |
| `evaluate` | `code` (IIFE string) | `{value}` | Executes JavaScript inside page context |
| `screenshot` | `path` (file path), `format` | `{path, sizeBytes}` | Writes image directly to disk (prevents base64 spam) |
| `upload` | `selector`, `files` (array) | `{fileCount}` | Attaches files to input elements |
| `close_session`| none | `{closed}` | Closes all tabs in the session tab group |

## 4. Production Recipes

### A. Semantic Reading with Snapshot
Always prefer `snapshot` over arbitrary CSS selectors. It returns `@e` refs that survive dynamic class hashing:
```bash
cmd '{"action":"snapshot","session":"audit","profile":"Work"}'
# Response includes: [Button: Submit Form] (@e42)
cmd '{"action":"click","args":{"selector":"@e42"},"session":"audit","profile":"Work"}'
```

### B. In-Page Authenticated API Execution (CORS Bypass)
When scraping authenticated APIs, execute `fetch()` inside the page via `evaluate` so the browser attaches session cookies automatically:
```bash
cmd '{"action":"evaluate","args":{"code":"(async()=>{ const r=await fetch(\"/api/v1/user/data\"); return await r.json(); })()"},"session":"audit","profile":"Work"}'
```

### C. React & Synthetic Controlled Inputs
If regular `fill` does not trigger framework state updates:
```bash
cmd '{"action":"evaluate","args":{"code":"(()=>{ const el=document.querySelector(\"input#username\"); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,\"value\").set; s.call(el,\"my-value\"); el.dispatchEvent(new Event(\"input\",{bubbles:true})); return true; })()"},"session":"audit","profile":"Work"}'
```

### D. Screenshots Directly to Disk
Never request screenshots without a path; writing to disk keeps your agent context clean:
```bash
cmd '{"action":"screenshot","args":{"path":"/tmp/preview.png"},"session":"audit","profile":"Work"}'
```

## 5. Architectural Guardrails
1. **Always Pin `_tabId` in Parallel Loops:** When driving multiple tabs, pass `_tabId` in `args` to prevent actions from landing on the currently focused foreground tab.
2. **One Task = One Session:** Group all related tabs for a single workflow under the same `session` name so they remain organized within a single Chrome tab group.
3. **Always Clean Up:** Call `close_session` upon task completion to keep the user's browser tidy.
