# AGENTS.md — drive the fleet autonomously

`kimi-webbridge-fleet` drives **multiple real Chrome profiles with their LIVE Google logins
SIMULTANEOUSLY** through [Kimi WebBridge](https://www.kimi.com/features/webbridge). Unlike
headless/scrape browser tools (Playwright, Firecrawl, etc.) that spin up a fresh single
session, this automates the user's **actual** Chrome with their **real** logged-in sessions —
many profiles at once. It runs one stock Kimi WebBridge daemon per profile on a deterministic
hashed port and puts a router on `:10086` that proxies `/command` to the right daemon by a
top-level `"profile"` field. The consumer of this doc is an AI agent; execute it top to bottom.

> Scope: **macOS + Google Chrome only.** Commands below assume both.

## 1. Prerequisites

Kimi WebBridge itself must be installed (the fleet layer supervises it — it contains no Kimi
WebBridge code):

```bash
# (a) Local daemon — official bootstrap installer
curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash

# (b) Verify the daemon binary answers
~/.kimi-webbridge/bin/kimi-webbridge status
```

The **Kimi WebBridge Chrome extension** (CWS id `fldmhceldgbpfpkbgopacenieobmligc`) must be
present in each profile you want to drive. Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)
or via force-install policy (see step 3). Do **not** rely on `--load-extension` of an unpacked
build — it is ignored in branded Google Chrome 137+; installation is via CWS / forcelist only.

## 2. Install the fleet CLI

```bash
# Post-publish (npm package: kimi-webbridge-fleet)
npx kimi-webbridge-fleet profiles
# or install globally and use the `kwb` bin
npm i -g kimi-webbridge-fleet && kwb profiles
```

From a checkout of the repo (works today, pre-publish):

```bash
node bin/kwb.mjs profiles      # `kwb <cmd>` below == `node bin/kwb.mjs <cmd>`
```

## 3. Setup: list profiles and ensure the extension is present

```bash
# List every profile, its deterministic hashed port, extension presence, daemon up?
kwb profiles

# Which profiles are missing the extension?
kwb install --missing

# Add the CWS extension to ALL profiles via Chrome's force-install policy.
# Takes effect only after a Chrome restart (a Chrome constraint, not a fleet one).
kwb install --forcelist
```

A `<profile>` argument is anything that resolves uniquely: the profile **name** (`"Work"`), an
**email**, or the Chrome **directory** (`"Profile 2"`).

## 4. Connect the extensions, then bring the fleet up

Each profile's extension must point at **its own** daemon port. `kwb connect` sets that with
**zero clicks** by writing the extension's `local_url` directly into its on-disk `storage.local`
(no popup, no CDP). The write needs Chrome closed (LevelDB is single-writer), so `kwb connect`
quits Chrome first (the session is saved for restore):

```bash
kwb connect "Work" "Personal"   # closes Chrome, points each extension at its daemon
kwb up      "Work" "Personal"   # starts daemons + router, opens windows → they connect
```

`kwb up` frees `:10086`, starts each named profile's daemon on its hashed port, starts the
router on `:10086`, opens each profile's window **and wakes its extension**, then polls until
each reports connected (`✓ connected … → :<port>`). The `local_url` write **persists**, so
later `kwb up` runs just reconnect — no need to `kwb connect` again.

> **Why the wake step exists.** Writing `local_url` to disk is only half the job. The kimi
> MV3 service worker re-reads `local_url` only when it *starts*, but it registers no
> `onStartup` listener, so Chrome never auto-starts it on launch — on an already-set-up
> profile the write alone does nothing. `kwb up` wakes the worker by opening the extension's
> own popup page (`chrome-extension://<id>/popup.html`) as a tab, the headful equivalent of
> clicking the toolbar icon. This is launched via the Chrome binary directly (headful), not
> macOS `open`, which doesn't reliably forward a `chrome-extension://` URL.

Shortcut: if Chrome is already **fully quit**, `kwb up` performs the `connect` write itself, so
`kwb up "Work" "Personal"` alone is enough. If Chrome is **running** and a profile isn't pointed
at its daemon yet, `kwb up` prints the exact `kwb connect …` command to run (it won't quit Chrome
out from under you). Use `kwb up --all-ext` to bring up every profile that has the extension.

To point profiles back at the stock single `:10086` bridge: `kwb connect "Work" --restore`.

## 5. Drive it: the `/command` HTTP contract

POST to the router on `:10086`. The body is the normal Kimi WebBridge command body **plus** a
top-level `"profile"` field selecting the target profile. The router strips `"profile"` and
proxies the rest to that profile's daemon. **Omit `"profile"` to hit the default** profile
(`KWB_DEFAULT_PROFILE`, else the last-used profile whose daemon is up).

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://search.google.com/search-console"},"session":"audit","profile":"Work"}'
```

`"profile"` accepts a name, email, or directory — anything that resolves uniquely.

## 6. Verify and tear down

```bash
# Per-profile fleet status; the field to check is extensionConnected
kwb status        # → daemonUp:true and extensionConnected:true for each driven profile

# Confirm the last bring-up succeeded (start time + per-profile connected + all-connected?)
kwb state

# Stop the router + all fleet daemons; restore the stock single :10086 bridge
kwb down          # add --no-restore to leave :10086 empty
```

`kwb tabs "Work"` lists a profile's normal open tabs (read from Chrome's on-disk session — no
daemon required). `kwb resolve <query>` shows what a query resolves to.

> **Idle auto-close.** The router closes the fleet itself after `KWB_IDLE_TIMEOUT_MIN` minutes
> (default 120) with no `/command`. It stops the **daemon processes only** — it never closes
> your browser tabs (the extensions just disconnect). The start/stop is recorded for `kwb state`.
> Set `KWB_IDLE_TIMEOUT_MIN=0` to disable. Re-run `kwb up` to bring it back.

## 7. Scope and limits

- **macOS + Google Chrome only.**
- **One daemon per profile**, each on a deterministic port `10100 + hash(profileDir)`, with its
  own isolated state dir.
- **`:10086` is reserved** for the router (or the stock daemon when the fleet is down) — it is
  never assigned to a profile.
- Extensions connect to their own daemon's `/ws` **directly**; the router only proxies HTTP
  `/command`.
- Zero-click `kwb connect` edits the **installed** extension's `storage.local` on disk and needs
  Chrome **closed** for the write (it quits Chrome for you). The value persists across restarts.
