---
name: kimi-webbridge-fleet
description: Drive MULTIPLE real Chrome profiles with their LIVE Google logins SIMULTANEOUSLY through Kimi WebBridge — automate the user's actual Chrome with their real logged-in sessions, many profiles at once (not headless/scrape like Playwright or Firecrawl). Use for any task needing a real browser across one or more logged-in Chrome profiles: multi-account workflows, acting as the user across several Google accounts at once, or driving a specific profile by name.
---

# kimi-webbridge-fleet

Drives the user's **actual** Chrome — multiple profiles with their **live Google logins** at the
same time — through [Kimi WebBridge](https://www.kimi.com/features/webbridge). One stock daemon
per profile on a deterministic hashed port; a router on `:10086` proxies `/command` to the right
daemon by a top-level `"profile"` field. macOS + Google Chrome only.

## When to use

Use this whenever a task needs a **real browser with the user's real logins**, especially across
more than one account:

- Any browser / web / "open this URL" / navigate / click / read-a-page task in the user's own
  Chrome.
- Multi-account or multi-profile workflows — acting as the user across several Google accounts
  (Work + Personal, multiple Gmail / Search Console / Drive / Ads accounts) **at once**.
- Anything you would otherwise reach for a headless tool (Playwright, Firecrawl) for, but where
  the real logged-in session matters — here you get the user's actual Chrome instead.

Prefer this over headless/scrape tools when login state, real cookies, or multiple simultaneous
profiles matter.

## How to use

Full, copy-pasteable setup is in **[AGENTS.md](../../AGENTS.md)** — read it for prerequisites
(Kimi WebBridge daemon + CWS extension), install, and details. Summary:

```bash
kwb profiles                 # list profiles, hashed ports, extension presence, daemon up?
kwb install --forcelist      # add the CWS extension to all profiles (needs Chrome restart)
kwb connect "Work" "Personal"  # point each extension at its daemon (zero clicks; closes Chrome)
kwb up      "Work" "Personal"  # start each profile's daemon + router on :10086, open windows
kwb status                   # verify: extensionConnected:true per profile
kwb down                     # tear down; restore the stock single :10086 bridge
```

(Pre-publish, run `node bin/kwb.mjs <cmd>` from the repo; post-publish, `kwb` / `npx
kimi-webbridge-fleet`.)

**Zero-click connect:** `kwb connect` points each profile's extension at its daemon by writing
`local_url` directly into the extension's on-disk `storage.local` — no popup, no clicks. It
quits Chrome to write (LevelDB is single-writer) and the value persists, so later `kwb up` runs
just reconnect. If Chrome is already quit, `kwb up` alone does the write for you.

### Driving a profile

POST to the router with the normal Kimi WebBridge body plus a top-level `"profile"` field
(name / email / directory). Omit `"profile"` to hit the default profile.

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://mail.google.com"},"session":"s1","profile":"Work"}'
```
