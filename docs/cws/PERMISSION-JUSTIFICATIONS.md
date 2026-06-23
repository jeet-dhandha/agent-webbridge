# Chrome Web Store — Privacy tab answers

Paste these into the **Privacy practices** tab of the Developer Dashboard. Each
permission below gets its own auto-populated justification field.

## Single purpose

> Agent WebBridge lets a local AI agent automate the user's own Chrome — opening,
> grouping, and driving tabs via the Chrome DevTools Protocol — by relaying commands
> from a Node daemon running on the user's own machine over a `127.0.0.1` localhost
> WebSocket. No data ever leaves the device.

## Per-permission justifications

**`debugger`** — This is the core automation mechanism. The extension calls
`chrome.debugger.attach({tabId}, "1.3")` and `sendCommand(...)` to issue Chrome
DevTools Protocol commands per tab — navigating, reading the accessibility tree,
clicking, filling inputs, capturing screenshots/PDFs, and observing network requests
on behalf of the user's local agent. A separate attachment is held per tab so multiple
tabs can be automated concurrently. The extension never attaches to a tab the user's
agent has not asked it to drive, and all CDP traffic originates from and returns to the
daemon on the user's own machine (`127.0.0.1`).

**`tabs`** — Automation tasks need to create and manage the tabs they run in. The
extension uses `chrome.tabs.group()` to place a task's tabs into a tab group,
`chrome.tabs.query()`/`get()` to enumerate and resolve a task's tabs, and
`chrome.tabs.remove()`/`onRemoved` to close task tabs and clean up state. It is not used
to read browsing history or monitor the user's unrelated tabs.

**`tabGroups`** — Each task ("session") is mirrored onto a real Chrome tab group so the
user can *see* exactly which tabs the automation owns. The extension uses
`chrome.tabGroups.update()` to title and color the group and `get()` to read it. This
makes the automation visible and revocable, and lets "close session" tear down precisely
the tabs the task created.

**`storage`** — Stores only local configuration and ephemeral task state, never user
content or analytics. `storage.local` holds a single key, `local_url`
(`ws://127.0.0.1:<port>`, the address of the user's own local daemon). `storage.session`
holds a short-lived session-to-tab-group map that is cleared on browser restart. Nothing
in storage is transmitted off the device.

**`alarms`** — Keeps the MV3 service worker's connection to the local daemon reliable.
MV3 service workers are terminated after short idle periods, which would drop the
WebSocket. The extension creates a single `chrome.alarms` timer that wakes the worker to
re-establish its localhost connection if it was torn down. The alarm does no other work —
no network beacons, no remote polling.

**`host_permissions: <all_urls>`** — The user (via their local agent) decides at runtime
which website to automate — it could be any site they are logged into (email, dashboards,
SaaS apps, etc.). Because the target site is chosen dynamically and is not known at
install time, a fixed host list is impossible; the automation must be able to run on
whatever URL the user navigates a task tab to. This access is exercised only inside tabs
the agent is actively driving, and no page data is sent to any third party — it is relayed
solely to the user's own daemon on `127.0.0.1`.

## Remote code

**Answer: "No, I am not using remote code."** All executable code ships inside the
extension package. The localhost WebSocket carries data and automation commands only;
the `evaluate` tool runs JavaScript in the page context via the Chrome DevTools Protocol
(`Runtime.evaluate`), which is CDP page automation — not remotely-hosted extension code
fetched over the network. Nothing is loaded into the extension from any server.

## Data collection disclosures

Declare **no data collected/transmitted** — all data stays on `127.0.0.1`. Certify
truthfully:

1. We do **not** sell or transfer user data to third parties (outside approved use cases).
2. We do **not** use or transfer user data for purposes unrelated to the item's single purpose.
3. We do **not** use or transfer user data to determine creditworthiness or for lending.
