# Launch posts

Ready-to-paste copy for the launch. **Order: r/LocalLLaMA + r/ClaudeAI first (where Kimi/Claude
users cluster), then HN.**

> **Gate (pre-mortem T3): do not post until the plugin install is smoke-tested.** The posts link
> people at `/plugin marketplace add …`; if that path is broken on a clean machine the launch
> backfires. Run the §2 smoke-test in `PUBLISHING.md` first.
>
> Honesty: the repo's `demo.gif` is a labeled *illustration*, not a screen recording. None of the
> copy below claims a real demo video — keep it that way.

**Framing (important):** lead with **Kimi WebBridge's actual limitation** — it is single-slot (one
daemon, one extension, one profile at a time) — and the contribution: a layer that makes it drive
*several* Chrome profiles at once via per-profile daemons + a `:10086` router + rewiring each
profile's extension to its own daemon. This is **not** a generic "AI drives your browser" product;
it's a multi-profile extension/daemon layer *on top of Kimi WebBridge*. Don't pitch it as a
standalone product — pitch the Kimi WebBridge problem it solves.

---

## 1. r/LocalLLaMA

**Title:**
`Kimi WebBridge only drives one Chrome profile at a time — I made it drive all of them at once`

**Body:**

```
Kimi WebBridge (Moonshot's extension + local daemon that lets a model control your real Chrome with
your real login) is single-slot by design: one daemon on :10086, one extension, one profile. If you
have a work Google account and a personal one, only one is drivable at a time — the other is rejected
until you quit its Chrome or toggle its extension off.

I wrote a small layer that removes that limit without patching Kimi WebBridge at all. Two things made
it work:

1. The daemon singleton only guards :10086. `kimi-webbridge start` refuses to launch if anything
   answers http://127.0.0.1:10086/status — but that probe is hardcoded to :10086 regardless of
   --addr. So leave :10086 free and you can run one stock daemon per Chrome profile on its own port
   (10100 + hash(profileDir)), each an independent connection slot. A router on :10086 then proxies
   /command to the right daemon by a top-level "profile" field, so existing :10086 calls keep working.

2. Each profile's extension has to point at ITS OWN daemon — and I do that with zero clicks. Instead
   of opening the extension popup per profile, I write the daemon URL (a plain `local_url` key) into
   the extension's storage.local LevelDB on disk while Chrome is closed (it's single-writer, not
   integrity-protected). The catch: the MV3 service worker only re-reads local_url when it *starts*,
   and it registers no onStartup listener, so on an already-set-up profile the write alone does
   nothing. I wake the worker by opening the extension's own popup page as a tab — the headful
   equivalent of clicking the toolbar icon.

No CDP (branded Chrome 136+ blocks remote-debugging on the default profile dir where real profiles
live anyway), no binary patching, pure Node. There's also a written spec for adding multi-profile
support *natively* inside the daemon + extension, which would make this layer unnecessary.

macOS + Chrome only. MIT. Repo: https://github.com/jeet-dhandha/kimi-webbridge-fleet

Happy to go into the LevelDB / MV3 details — that was the whole fight.
```

**Notes:** r/LocalLLaMA hates marketing. No emojis, no "🚀". The post is about the Kimi WebBridge
internals, which is exactly what this sub upvotes. Flair: `Resources` or `Tutorial | Guide`.

---

## 2. r/ClaudeAI

**Title:**
`Made Kimi WebBridge multi-profile (it's single-profile by default) — packaged as a Claude Code plugin`

**Body:**

```
Kimi WebBridge lets an AI drive your real Chrome with your real login, but it's single-slot: one
daemon, one extension, one profile at a time. I built a layer that lets it drive several Chrome
profiles (several Google logins) at once, and packaged it as a Claude Code plugin/skill.

Under the hood it runs one stock Kimi WebBridge daemon per Chrome profile on its own port, with a
router on :10086 that routes by a "profile" field (your existing :10086 calls keep working — no
patching). The fiddly part is pointing each profile's extension at its own daemon: it writes the
daemon URL into the extension's storage.local on disk (with Chrome closed) and wakes the MV3 service
worker by opening its popup page — so there's no per-profile popup-clicking.

Install (the repo is its own plugin marketplace):

    /plugin marketplace add jeet-dhandha/kimi-webbridge-fleet
    /plugin install kimi-webbridge-fleet@kwb

There's also `kwb doctor` to check your setup (Chrome, the Kimi WebBridge daemon binary, which
profiles have the extension) before you start.

macOS + Chrome only, MIT, no telemetry, no Kimi WebBridge patching. Repo:
https://github.com/jeet-dhandha/kimi-webbridge-fleet

Feedback welcome — especially on multi-profile workflows you'd point it at.
```

**Notes:** Leads with the Kimi WebBridge limit, then the Claude Code install (what this sub wants).
`kwb doctor` lowers the "will it work on my machine" friction that kills plugin adoption.
**Dependency:** this post mentions `kwb doctor` — make sure that command is committed + pushed (and
in the published npm package) before posting, or it's a broken promise.

---

## 3. Hacker News — Show HN

**Title:**
`Show HN: Making Kimi WebBridge drive multiple Chrome profiles at once`

**URL:** `https://github.com/jeet-dhandha/kimi-webbridge-fleet`

**First comment (post immediately after submitting):**

```
Author here. Kimi WebBridge is a Chrome extension + local daemon (on :10086) that lets an AI drive
your real Chrome tab with your real login. By design it's single-slot: one daemon, one extension,
one profile. So with a work Google account and a personal one, only one is drivable at a time — the
other is rejected until you quit its Chrome or toggle its extension off.

This is a layer that removes that limit without patching Kimi WebBridge. Two non-obvious bits:

1. The daemon singleton only guards :10086. `kimi-webbridge start` refuses to launch if anything
   answers http://127.0.0.1:10086/status — but that probe is hardcoded to :10086 regardless of
   --addr. Leave :10086 free and you can start as many stock daemons as you like on other ports,
   each its own independent slot. So: one daemon per Chrome profile on a deterministic port
   (10100 + hash(profileDir)), plus a router on :10086 that proxies /command to the right daemon by
   a "profile" field. Existing :10086 callers don't change.

2. Pointing each profile's extension at its own daemon, with no clicking. The daemon URL is a plain
   `local_url` key in the extension's storage.local LevelDB — not integrity-protected — so I write
   it directly while Chrome is closed (single-writer) instead of opening the popup. The catch: the
   MV3 service worker only re-reads local_url on startup and registers no onStartup listener, so on
   an already-set-up profile the write alone does nothing. I wake it by opening the extension's own
   popup page (chrome-extension://<id>/popup.html) as a tab — the headful equivalent of clicking the
   toolbar icon. No CDP: branded Chrome 136+ refuses remote-debugging on the default user-data-dir
   where real profiles live.

No binary patching, nothing that breaks on a Kimi WebBridge upgrade. There's also a spec in the repo
for doing this natively inside the daemon + extension, which would make the layer unnecessary.

macOS + Chrome only today. MIT. Happy to answer anything about the MV3 / LevelDB / routing details.
```

**Notes:** Show HN title is plain (no "revolutionary"). Submit when you can babysit the thread for
the first 1–2 hours. Best windows: weekday ~8–10am ET. Don't post HN the same hour as Reddit — stagger
so you can respond to each.
