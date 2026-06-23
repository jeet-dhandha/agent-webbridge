# Privacy Policy — Agent WebBridge

**Last updated:** June 23, 2026

Agent WebBridge ("the extension") is an open-source (MIT-licensed) Chrome extension
that lets a local AI agent automate **your own Chrome browser** through the Chrome
DevTools Protocol. This policy explains, in full, what the extension does and does
not do with data.

## Summary

**The extension sends nothing to any remote server.** There is no backend, no
analytics, and no telemetry. It collects no personal information. Its only network
connection is a WebSocket to a program running on **your own computer** at the
loopback address `127.0.0.1` (localhost). All data stays on your machine.

## What the extension connects to

The extension opens a single WebSocket connection to `ws://127.0.0.1:<port>` — a
local "agent-webbridge" Node daemon that **you** install and run on your own machine
(from the open-source `agent-webbridge` npm package). This connection:

- Targets **only** the loopback interface (`127.0.0.1`). It never connects to any
  external, remote, or third-party host.
- Carries plain JSON messages: a handshake, keep-alive pings, and the automation
  commands ("tool calls") issued by **your** local agent, along with their results.
- Is the **only** outbound connection the extension makes.

## Data the extension stores (locally, on device only)

The extension uses Chrome's storage APIs solely for configuration and short-lived
task state. None of it is transmitted off the device:

- **`storage.local` → `local_url`:** the `ws://127.0.0.1:<port>` address of your
  local daemon, written during setup so the extension knows where to connect.
- **`storage.session` → session-to-tab-group map:** a short-lived mapping of each
  automation task to its Chrome tab group. It is cleared on browser restart.

## What the extension reads from web pages

When your local agent directs it to, the extension uses the `debugger` permission to
read and act on the page in a tab it is driving (navigate, read the accessibility
tree, click, fill, screenshot, etc.). This page content is used **only** to carry
out the command you requested and is relayed **only** to your own local daemon on
`127.0.0.1`. It is **never** sent to the developer, to Anthropic, or to any third
party. The extension only ever acts on a tab when your local agent explicitly
targets it.

## What the extension does NOT do

- It does **not** collect, transmit, sell, or share any personal or sensitive data.
- It includes **no** analytics, tracking, telemetry, advertising, or fingerprinting.
- It contacts **no** remote server — its only connection is `127.0.0.1` on your machine.
- It runs **no** remotely-hosted code; all code ships inside the extension package.
- It creates **no** user account and requires no login.

## Permissions

The extension requests `debugger`, `tabs`, `tabGroups`, `storage`, and `alarms`, plus
host access to `<all_urls>`. Each is used strictly to automate the tabs you direct it
to drive and to keep the local connection alive. None of these permissions is used to
send your data anywhere off your device. A per-permission explanation is published on
the Chrome Web Store listing.

## Data retention and deletion

The only persisted item is the local daemon URL in `storage.local`. You can delete all
stored data at any time by removing the extension from `chrome://extensions`, which
clears its storage. The session-to-tab-group map is discarded automatically on browser
restart.

## Children's privacy

The extension is a developer/automation tool, is not directed at children, and
collects no data from anyone.

## Changes to this policy

If this policy changes, an updated version will be published at this URL with a revised
"Last updated" date. Because the extension is open source, all changes are also visible
in the project's public repository.

## Contact

Questions about this policy or the extension can be raised on the project's public
repository issue tracker (https://github.com/jeet-dhandha/agent-webbridge/issues) or by
email to the maintainer at jeet.dhandha.2511@gmail.com.
