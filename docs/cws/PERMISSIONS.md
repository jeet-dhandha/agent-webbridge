# Agent WebBridge — permission justifications (for the CWS reviewer)

This document justifies every permission Agent WebBridge requests, ties each to the specific
tools that need it, and provides the "remote code" and "data usage" disclosures the Chrome
Web Store form asks for. The `debugger` permission and `<all_urls>` host access are sensitive
and trigger manual review — the justifications below are written for that review.

**Context for the reviewer:** Agent WebBridge is an open-source (MIT) browser-automation
bridge. The extension connects **only** to a daemon on `127.0.0.1` (localhost) that the user
installs and runs themselves (`npm i -g agent-webbridge`). It never contacts any remote
server. Its entire job is to act on the user's own tabs in response to commands from that
local daemon. The shipped manifest requests exactly:

```
"permissions": ["debugger", "tabs", "tabGroups", "storage", "alarms"]
"host_permissions": ["<all_urls>"]
```

## `debugger`

The extension's core function is automating pages through the Chrome DevTools Protocol, which
is only reachable via the `debugger` API. The extension attaches `chrome.debugger` **per tab**
— only to tabs that are part of a task the user explicitly drives through their own local
daemon — and detaches when the task or session ends. This permission is required by the tools
that read or act on page content: `navigate`, `evaluate`, `snapshot` (accessibility tree),
`click`, `fill`, `network` (request capture), `upload`, `screenshot`, and `save_as_pdf`. There
is no less-powerful API that provides DevTools-Protocol-level automation, so `debugger` is
essential and cannot be narrowed.

## `tabs`

Used to resolve, open, and enumerate the tabs a task operates on. It backs `navigate`
(open/select the task tab), `find_tab` (locate an existing tab by URL/title), `list_tabs`
(enumerate a session's tabs), and `close_tab` (close a tab when the agent is done). Without
`tabs`, the extension could not identify which tab a command targets or report tabs back to
the user's local daemon.

## `tabGroups`

A "session" groups a task's tabs into a Chrome tab group so the user can see at a glance which
tabs an automated task owns, and so the whole task can be cleaned up together. This permission
backs `close_session` (close a task's tab group) and the grouping done when task tabs are
created. It exists purely to keep automated work visually organized and easy to tear down.

## `storage`

Uses `chrome.storage.local` to persist small operational settings — primarily the
`127.0.0.1` daemon address the extension should connect to — so the extension can reconnect
to the user's local daemon across service-worker restarts. The data is a handful of local
settings; it stays on the user's machine and is never transmitted off-device.

## `alarms`

MV3 service workers are evicted when idle. `alarms` schedules a lightweight periodic wake so
the extension can keep its localhost WebSocket to the user's local daemon alive and remain
responsive to commands. Without it, the service worker would sleep and drop the connection
mid-task. It is used only for this keepalive/reconnect heartbeat.

## `host_permissions: <all_urls>`

Browser automation must work on **whatever site the user's task targets** — that site is not
known ahead of time and could be any URL the user is logged into. The `chrome.debugger`
attach and the page-acting tools (`evaluate`, `snapshot`, `click`, `fill`, `network`,
`upload`, `screenshot`, `save_as_pdf`, `navigate`) therefore need host access to arbitrary
origins. `<all_urls>` is the minimal scope that makes a general-purpose automation tool
usable; any narrower allow-list would silently break automation on sites the user legitimately
wants to drive. The extension acts only on tabs the user's own local daemon directs it to —
it does not crawl, scan, or touch sites on its own initiative.

## Remote code disclosure

**No remote code.** The extension executes only the JavaScript bundled in the package. It does
not load, `eval`, or inject any script fetched from a remote server. The `evaluate` tool runs
JavaScript **in the page** via the Chrome DevTools Protocol — that code originates from the
user's own local daemon over the `127.0.0.1` connection, not from any remote source, and it
runs in the page context, not as extension code. There is no remotely hosted code path
anywhere in the extension.

## Data usage disclosure

**The extension collects no user data and contacts no remote server.** Its only network
connection is a WebSocket to `127.0.0.1` (a daemon the user runs locally). There is no
analytics, no telemetry, no account, and no third-party service. Page content the extension
reads (for example an accessibility snapshot or a screenshot) is returned **only** to the
user's local daemon over the localhost connection so the user's own agent can use it — it is
never uploaded or shared with us or any third party.

For the CWS "Data usage" form, the correct selections are:

- **Does NOT** collect or use any of the listed user-data categories.
- Data is **NOT** sold or transferred to third parties.
- Data is **NOT** used or transferred for purposes unrelated to the item's single purpose.
- Data is **NOT** used or transferred to determine creditworthiness or for lending.

The full privacy policy is in [`PRIVACY.md`](./PRIVACY.md), and the listing copy (including the
required single-purpose description) is in [`LISTING.md`](./LISTING.md).
