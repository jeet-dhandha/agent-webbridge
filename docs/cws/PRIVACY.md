# Agent WebBridge — Privacy Policy

**Last updated: 2026-06-13**

Agent WebBridge is an open-source (MIT) Chrome extension that lets an AI agent drive
**your own** Chrome — your real profiles, your real login sessions — by talking to a
small daemon **you run on your own machine**. This policy describes exactly what the
extension does and does not do with your data.

## Short version

**Agent WebBridge collects nothing.** It has no servers, no account, no analytics, and
no telemetry. The only network connection it ever opens is a WebSocket to a daemon on
**`127.0.0.1` (localhost)** that you start yourself. Nothing you browse, type, or
automate ever leaves your computer through this extension.

## What we collect

**None.** We do not collect, transmit, store off-device, sell, or share any personal
information, browsing history, page content, credentials, or usage data.

To be explicit, the extension does **not**:

- contact any remote server, API, or website operated by us or any third party;
- send analytics, telemetry, crash reports, or "phone-home" pings of any kind;
- require, create, or use an account, login, license key, or registration;
- include any tracking pixels, advertising SDKs, or third-party scripts;
- read your browsing history or bookmarks for any purpose of its own.

There is no remote endpoint in the code to receive your data. You can verify this in the
published source — the extension's only outbound connection is the localhost WebSocket
described below.

## Where data goes (localhost only)

Agent WebBridge connects **only** to `127.0.0.1` (localhost) — a daemon process running
on the same machine, which you install and start yourself (`npm i -g agent-webbridge`).
The flow is entirely local:

```
your AI agent  →  local router (127.0.0.1:10086)  →  local per-profile daemon (127.0.0.1)
               →  Agent WebBridge extension  →  chrome.debugger  →  the page
```

Every hop in that chain runs on your own computer. The extension never opens a connection
to any address other than `127.0.0.1`. No remote server is ever contacted, by us or anyone
else.

## How the extension automates pages

When your local daemon sends a command, the extension uses the Chrome **`chrome.debugger`**
API (the Chrome DevTools Protocol) to act on a tab on your behalf — navigate, read the
accessibility tree, click, fill a field, capture a screenshot, and so on. It attaches the
debugger **per tab, only for tabs involved in a task you explicitly drive through your own
local daemon**, and detaches when the work is done or the session is closed.

Page content the extension reads (for example, an accessibility snapshot or a screenshot)
is returned **only** to your local daemon over the localhost connection, so your own agent
can use it. It is never uploaded anywhere by the extension.

## Local storage

The extension uses `chrome.storage.local` to hold small operational settings (such as the
local daemon address it should connect to). This data stays on your machine in your Chrome
profile and is never transmitted off-device.

## Permissions

Agent WebBridge requests `debugger`, `tabs`, `tabGroups`, `storage`, and `alarms`, plus
host access to `<all_urls>`. These exist solely to automate pages on your behalf over the
localhost connection. A per-permission justification is in
[`PERMISSIONS.md`](./PERMISSIONS.md).

## Third parties

There are no third parties. The extension shares data with no one — not with us, not with
any analytics or advertising provider, not with any cloud service. The only party that ever
receives data from the extension is **the local daemon on your own machine that you chose
to run.**

## Children's privacy

Agent WebBridge is a developer tool that collects no data from anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be published in this repository with a new
"Last updated" date. Because the extension is open source (MIT), you can always audit the
code to confirm what it does.

## Contact

Questions about this policy can be raised as an issue on the project's public GitHub
repository.
