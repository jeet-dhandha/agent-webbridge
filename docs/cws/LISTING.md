# Agent WebBridge — Chrome Web Store listing copy

Paste-ready text for the Chrome Web Store submission. Everything here is grounded in the
shipped extension (`agent-webbridge-extension/`) and daemon (`agent-webbridge` on npm).

## Item name

```
Agent WebBridge
```

## Short summary (<= 132 chars)

```
Let an AI agent drive your real Chrome — multiple profiles in parallel — over a localhost-only daemon you run. No account.
```

(118 characters.)

## Category

**Developer Tools**

## Single-purpose description (required by CWS)

```
Agent WebBridge lets an AI agent automate your real Chrome — navigating, reading, and
interacting with pages — by connecting only to a daemon you run on your own machine at
127.0.0.1. Its single purpose is browser automation driven by your local daemon.
```

## Full description

```
Agent WebBridge turns your real Chrome into something an AI agent can drive — with your
actual login sessions, across multiple Chrome profiles, all at once. It is open source
(MIT), localhost-only, and uses no account, no telemetry, and no remote server.

HOW IT WORKS
You install a small Node daemon on your machine (npm i -g agent-webbridge) and this
extension. Your agent sends a command to a local router at 127.0.0.1:10086, which routes
it to a per-profile daemon, which talks to this extension over a localhost WebSocket. The
extension then acts on the page using Chrome's debugger (DevTools Protocol). Every hop runs
on your own computer — the extension never contacts any remote server.

TRUE PER-TAB PARALLELISM
Agent WebBridge attaches Chrome's debugger PER TAB, not through one global "current tab."
That means many tabs in a single profile can run concurrently, and you can drive several
profiles at the same time. Parallelism is cross-profile (N profiles) times per-tab
(N tabs per profile).

13 TOOLS (full browser-automation toolkit)
• navigate — open a URL in a task tab
• find_tab — locate an existing tab
• evaluate — run JS in the page
• snapshot — accessibility tree with stable @e element refs
• click — click an element
• fill — type into native inputs and contenteditable fields
• network — capture network requests
• upload — set files on a file input
• screenshot — capture the page
• save_as_pdf — print the page to PDF
• list_tabs — list a session's tabs
• close_tab — close a tab
• close_session — close a task's tab group
A "session" groups a task's tabs into a Chrome tab group so work stays organized.

PRIVACY BY DESIGN
• No data collection. No analytics. No telemetry. No account.
• Connects ONLY to 127.0.0.1 (localhost) — a daemon you run yourself.
• No remote server is ever contacted. Page content the extension reads is returned only to
  your local daemon, never uploaded.
• Open source (MIT) — audit exactly what it does.

REQUIREMENTS
• A local Agent WebBridge daemon (npm i -g agent-webbridge), Node 18+.
• macOS-first today; Linux/Windows support is a documented follow-up.

Agent WebBridge is a clean-room, open-source browser-automation bridge for AI agents. You
stay in control: it only drives the tabs your local daemon tells it to, and nothing leaves
your machine.
```

## Notes for the submission form

- **Website / homepage:** the project's public GitHub repository.
- **Privacy policy URL:** host [`PRIVACY.md`](./PRIVACY.md) at a public URL and link it here.
- **Permission justifications:** see [`PERMISSIONS.md`](./PERMISSIONS.md). The `debugger`
  permission and `<all_urls>` host access are sensitive and trigger manual review — submit
  the justifications verbatim.
- **Data usage disclosures:** select that the extension does **not** collect or use any user
  data, and that data is **not** sold or transferred to third parties (it stays on the user's
  machine; the only recipient is the user's own local daemon).
