# Native multi-profile support — implementation spec for Kimi WebBridge

This document is an **explicit, implementable spec** for adding multi-profile
support **inside** Kimi WebBridge itself (the daemon + the extension), so the
[`kimi-webbridge-fleet`](../README.md) workaround (one daemon per profile + a
router) is no longer needed.

> **Status of the source.** Kimi WebBridge ships as a **compiled Go binary**
> (`~/.kimi-webbridge/bin/kimi-webbridge`, stripped) and a **minified MV3
> extension** (`background.js`). This spec is therefore written against the
> **observable interface** (HTTP endpoints, the WS protocol, `chrome.storage`
> keys, and the extension's command-dispatch map) rather than against named
> source lines. Each instruction cites the concrete hook it maps to so an
> implementer with the source can locate it immediately. An agent implementing
> this must **prove each change on the live surface** (see Acceptance tests),
> not assume it works.
>
> For the literal `grep`/`strings`/patch commands used to locate these hooks
> (and a working, tested extension patch for `list_all_tabs`), see
> [`REVERSE-ENGINEERING-RECIPE.md`](REVERSE-ENGINEERING-RECIPE.md).

---

## 1. Current behavior (observed, black-box verified)

| # | Fact | Evidence |
|---|------|----------|
| O1 | **Daemon singleton.** `kimi-webbridge start` refuses to launch if anything answers `http://127.0.0.1:10086/status`. The probe is hardcoded to `:10086` and ignores `--addr`. | Starting a 2nd daemon on `:10087`/`:10088` while `:10086` was up → "kimi-webbridge daemon is already running". With `:10086` free, multiple daemons on other ports start fine. |
| O2 | **Slot singleton.** One daemon keeps exactly one extension WS connection; a second extension is rejected and retries every ~5 s. | Daemon strings: `slot held by %s`, `replaced_session`. Live: a 2nd profile's extension is rejected until the first frees the slot. |
| O3 | **Extension identity is NOT per-profile.** The same `extension_id` is reported by every profile that installs the same build. | `/status` returns one `extension_id` (e.g. `fldmhce…`); different profiles produce the same id. |
| O4 | **Daemon URL is per-profile overridable.** The extension connects to `ws://127.0.0.1:10086/ws` by default, but reads an override from `chrome.storage.local.local_url` (and `chrome.storage.session.ws_url`). | `background.js`: `q = {WS_URL:'ws_url'}`, default `ve = 'ws://127.0.0.1:10086/ws'`, connect order = `session.ws_url` → `local.local_url` → default; the popup writes it. |
| O5 | **`stop` / `status` are hardcoded to `:10086`.** `stop` POSTs `http://127.0.0.1:10086/shutdown` regardless of which daemon you mean. | Stopping an off-port daemon via the CLI fails with `Post "http://127.0.0.1:10086/shutdown"`. The off-port daemon does serve `/shutdown` on its **own** port. |
| O6 | **`list_tabs` is session-scoped, not profile-scoped.** It only returns tabs the daemon opened for that `session`; there is no "all open tabs" action. | `background.js` `list_tabs` handler reads injected `_tabIds`/`_tabId` only; a fresh session returns `{tabs: []}`. |
| O7 | **The daemon already injects per-session routing keys** into every command before dispatch. | `background.js` dispatch receives `_session`, `_tabId`, `_tabIds`. So a routing/identity layer already exists at the session granularity. |
| O8 | **The extension already has `tabs` permission and uses `chrome.tabs.query`.** | `manifest.json` permissions include `tabs`; `background.js` calls `chrome.tabs.query/get/group`. |

The two blockers to native multi-profile are **O2** (single slot) and **O3**
(no per-profile identity). Everything else is secondary.

---

## 2. Goal

**One daemon, many simultaneous profile connections, addressable by a stable
profile identifier**, plus a whole-profile tab listing. This is strictly nicer
than the fleet workaround: no extra ports, no router, no per-profile popup
re-pointing.

```
            ┌──────────────────── kimi-webbridge daemon :10086 ────────────────────┐
 agent ───► │  connection registry  { tokenA → wsA, tokenB → wsB, tokenC → wsC }   │
 POST       │  /command {profile} ─► pick connection ─► dispatch                    │
 :10086     └──────────────────────────────────────────────────────────────────────┘
                 ▲ wsA (/ws)        ▲ wsB (/ws)        ▲ wsC (/ws)
            Chrome profile A   Chrome profile B   Chrome profile C   (all connected at once)
```

---

## 3. Required changes

### A. Extension (`background.js`)

**A1 — Emit a stable per-profile identity on connect (the crux; fixes O3).**
`extension_id` cannot distinguish profiles. On first run, generate a persistent
UUID and store it:

```js
// once, on startup
let { profile_token } = await chrome.storage.local.get("profile_token");
if (!profile_token) {
  profile_token = crypto.randomUUID();
  await chrome.storage.local.set({ profile_token });
}
```

Include it (plus a human label and, if available, the account email) in the WS
**handshake / hello** message the extension sends right after the socket opens:

```js
socket.send(JSON.stringify({
  type: "hello",
  extension_id: chrome.runtime.id,
  profile_token,                              // stable per Chrome profile
  profile_label,                              // user-set in popup, optional
  profile_email,                              // chrome.identity.getProfileUserInfo(), optional
  extension_version: chrome.runtime.getManifest().version,
}));
```
*Maps to:* the existing connect path in `background.js` (the `WebSocket(t)` /
`open` handler). The popup already writes settings to `chrome.storage.local`
(O4); add an optional `profile_label` field there.

**A2 — Add a `list_all_tabs` command (fixes O6).** Register a new handler in the
command map that returns every tab in the profile:

```js
class ListAllTabs {
  name = "list_all_tabs";
  async execute() {
    const tabs = await chrome.tabs.query({});
    return { success: true, tabs: tabs.map(t => ({
      tabId: t.id, url: t.url ?? "", title: t.title ?? "",
      windowId: t.windowId, active: t.active, groupId: t.groupId,
    })) };
  }
}
```
*Maps to:* the handler-registration function (minified `ge()` doing
`G(new _) … G(new fe)`) and the dispatch map (`W`, used by `_e(e,t)`). Register
`G(new ListAllTabs)` alongside the others. Uses the existing `tabs` permission
(O8).

**A3 — (optional) Report profile name/email** via
`chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })` so the daemon can
expose a friendly identifier. Requires the `identity` and
`identity.email` permissions in `manifest.json`.

### B. Daemon

**B1 — Connection registry instead of a single slot (fixes O2).** Replace the
single-extension slot with a map keyed by `profile_token` (from A1), or by a
server-assigned connection id if no token is present (back-compat). Accept and
hold **N concurrent** extension WS connections; do not evict on a new
connection. *Maps to:* the slot logic behind `slot held by %s` /
`replaced_session`.

**B2 — Route `/command` by `profile`.** Add an optional top-level `profile`
field to the `/command` body. Resolution order: exact `profile_token` →
`profile_label` → `profile_email`. If absent, route to the **default**
(configurable; otherwise the most-recently-active connection). Return a clear
`400`/`409` if `profile` matches zero or multiple connections. *Maps to:* the
command-intake path that already injects `_session`/`_tabId`/`_tabIds` (O7) —
extend that same layer to also select the target connection.

**B3 — `/status` returns all connections.** Change `/status` to report an array:

```json
{
  "running": true, "port": 10086, "version": "…",
  "clients": [
    { "profile_token": "…", "profile_label": "Work", "profile_email": "…",
      "extension_version": "1.9.17", "connected": true }
  ]
}
```
Keep the legacy single-object shape when exactly one client is connected, or
behind a `?legacy=1` flag, so existing tools don't break.

**B4 — Pass `list_all_tabs` through** to the extension like any other action.

**B5 — (only if you keep the multi-daemon model instead of B1)** If, instead of
one-daemon-multi-slot, you support running multiple daemons: make the singleton
check **per-port / per-state-dir** (a lockfile under the daemon's `HOME`,
not a hardcoded `:10086` probe — fixes O1), and make `stop`/`status` honor
`--addr`/`--port` (fixes O5). **B1 is strongly preferred** — it's simpler for
users and avoids port management entirely.

### C. Protocol & CLI summary

| Surface | Change |
|---|---|
| WS handshake | extension sends `hello` with `profile_token` / `profile_label` / `profile_email` (A1) |
| `POST /command` | optional `profile` field selects the target connection (B2) |
| `GET /status` | returns `clients[]` (B3) |
| new action | `list_all_tabs` (A2 + B4) |
| `kimi-webbridge status` | prints the client table |
| singleton/stop/status | per-port if multi-daemon is kept (B5) — N/A under B1 |

---

## 4. Backward compatibility

- A `/command` **without** `profile` behaves exactly as today (routes to the
  single/default connection).
- A single-profile user sees no change.
- `/status` keeps a legacy shape when one client is connected (B3).
- No change to the action protocol other than the additive `profile` field and
  the new `list_all_tabs` action.

---

## 5. Acceptance tests (prove it on the live surface)

An implementer must demonstrate **all** of these, not assert them:

1. **Two profiles connected at once.** Install the extension in two profiles,
   open both → `GET /status` lists **two** `clients` with distinct
   `profile_token`s. (Today this is impossible — the 2nd is rejected, O2.)
2. **Independent routing.** `POST /command {profile: A, action: navigate …}`
   acts in profile A; immediately `POST /command {profile: B, …}` acts in B;
   neither disconnects the other. Run them concurrently — both succeed.
3. **Default routing unchanged.** `POST /command` with no `profile` still works
   for a single connected profile.
4. **Whole-profile tabs.** `POST /command {profile: A, action: list_all_tabs}`
   returns A's real open tabs (cross-check against Chrome).
5. **Ambiguity is explicit.** `profile` matching zero/multiple connections
   returns a clear error, not a silent wrong-profile action.
6. **No regression.** Existing single-profile flows and tools that read
   `/status` keep working.

---

## 6. Why fleet does it differently

`kimi-webbridge-fleet` cannot change the daemon or extension, so it works
**around** O1–O2 by running one stock daemon per profile on a deterministic port
and routing with an external `:10086` proxy, and works around O6 by reading
Chrome's on-disk SNSS session journal for tabs. The changes above make all of
that unnecessary — at which point fleet becomes a thin convenience CLI over
native support, or retires entirely.
