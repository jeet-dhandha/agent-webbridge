---
name: agent-webbridge
description: Drive the user's REAL Chrome — multiple profiles with their LIVE logins, and MULTIPLE TABS PER PROFILE, all IN PARALLEL — through agent-webbridge. Clean-room, open-source (MIT), no account, no telemetry. Automates the user's actual Chrome with their real logged-in sessions (not headless/scrape like Playwright or Firecrawl). Use for any task needing a real browser across one or more logged-in Chrome profiles: multi-account workflows, acting as the user across several accounts at once, or driving N tabs in one profile concurrently.
license: MIT
---

# agent-webbridge

Clean-room, open-source (MIT) browser automation for AI agents. Drives the user's **actual**
Chrome — multiple profiles with their **live logins**, and **multiple tabs per profile**, all
**in parallel**. A lightweight Node daemon runs per profile on a deterministic hashed port; a
router on `http://127.0.0.1:10086` proxies `/command` to the right daemon by a top-level
`"profile"` field. macOS-first (Google Chrome).

> This repository is packaged as a Claude Code plugin/skill. The canonical skill also lives at
> [skills/kimi-webbridge-fleet/SKILL.md](skills/kimi-webbridge-fleet/SKILL.md); this root copy
> exists so skill indexers that expect a top-level `SKILL.md` can discover it. (The `skills/`
> directory name is kept for backward compatibility; the product is **agent-webbridge**.)

agent-webbridge evolved from `kimi-webbridge-fleet` by **replacing** the two closed pieces it
used to depend on — a closed-source Go daemon and an un-patchable official extension — with our
own clean-room daemon (`src/daemon/`, only runtime dep is `ws`) and clean-room MV3 Chrome
extension (`agent-webbridge-extension/`, stable id `ifodkkbkmngjlkhiphcjmbceeolhpfeo`). The
result has **no** closed-source dependency, **no** account, **no** telemetry, and **no**
`curl|bash` installer. It is **localhost-only**: the extension connects only to a daemon you run
on `127.0.0.1`; no data leaves the machine and no remote server is ever contacted.

## When to use

Use this whenever a task needs a **real browser with the user's real logins**, especially across
more than one account or with several pages in flight at once:

- Any browser / web / "open this URL" / navigate / click / read-a-page task in the user's own
  Chrome.
- Multi-account or multi-profile workflows — acting as the user across several accounts (Work +
  Personal, multiple Gmail / Drive / Ads accounts) **at once**.
- Throughput tasks where **many tabs in one profile** should run **concurrently** — agent-
  webbridge attaches `chrome.debugger` **per tab**, so N tabs in one profile run in parallel
  (the killer feature vs the official Kimi WebBridge, which funnels every call through one
  global "current tab").
- Anything you would otherwise reach for a headless tool (Playwright, Firecrawl) for, but where
  the real logged-in session matters — here you get the user's actual Chrome instead.

Prefer this over headless/scrape tools when login state, real cookies, multiple simultaneous
profiles, or per-profile tab parallelism matter.

## Health check (always do this first)

```bash
awb status        # `kwb` is kept as an alias
```

Then act on the result:

- **`daemonUp: true` and `extensionConnected: true`** for the profile(s) you want — healthy.
  Proceed with the tool calls below.
- **Anything else** (router/daemon not up, extension not connected) — bring the fleet up with
  the commands under [How to use](#how-to-use), then re-check. See **[AGENTS.md](AGENTS.md)**
  for the full setup, install, and diagnose flow.

## How to use

Full, copy-pasteable setup is in **[AGENTS.md](AGENTS.md)** — read it for prerequisites
(`npm i -g agent-webbridge` for the daemon + CLI; the Chrome extension from the Chrome Web Store
or "Load unpacked" of `agent-webbridge-extension/` in dev), install, and details. Summary:

```bash
awb setup                       # list profiles, hashed ports, extension presence, daemon up?
awb connect "Work" "Personal"   # point each extension at its daemon (zero clicks; closes Chrome)
awb up      "Work" "Personal"   # start each profile's daemon + router on :10086, open windows
awb status                      # verify: extensionConnected:true per profile
awb down                        # tear down the fleet
```

(Install with `npm i -g agent-webbridge`, then use the `awb` CLI — `kwb` remains an alias.
Pre-publish, run `node bin/kwb.mjs <cmd>` from the repo. Run `awb doctor` first for a read-only
environment self-check.)

**Zero-click connect:** `awb connect` points each profile's extension at its daemon by writing
`local_url` directly into the extension's on-disk `storage.local` — no popup, no clicks. It
quits Chrome to write (LevelDB is single-writer) and the value persists, so later `awb up` runs
just reconnect. If Chrome is already quit, `awb up` alone does the write for you.

### Driving a profile

POST to the router on `http://127.0.0.1:10086/command`. The body is the normal command body
**plus** a top-level `"profile"` field (name / email / directory) selecting the target profile.
Omit `"profile"` to hit the default profile. Every command also carries a top-level `"session"`
naming the current task — see [Sessions](#sessions).

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://mail.google.com"},"session":"s1","profile":"Work"}'
```

Parallelism is **cross-profile** (N profiles) **× per-tab** (N tabs/profile): fire several
`/command` requests at once — across different profiles, or at different tabs within the same
profile — and they run concurrently.

### High-throughput batch jobs (fan-out + resume)

For a large worklist (hundreds–thousands of items — scrape N companies, check N accounts,
fill N forms), drive it as a **fleet fan-out**:

- **Total concurrency = #profiles × tabs-per-profile.** Bring up several profiles
  (`awb up "P1" "P2" …`), split the worklist into one chunk per profile, and within each
  profile keep up to M `/command` requests (M tabs) in flight at once — e.g.
  **5 profiles × 10 tabs = 50 items processed concurrently**. Per-tab parallelism is real
  (`chrome.debugger` is attached per tab), so tabs in one profile don't block each other.
- **Make it resumable.** Write results to disk **incrementally** — rewrite/append the output
  file after *each* item, not once at the end. On (re)start, load the existing output, skip the
  items already done, and process only the remainder. An interrupted run (crash, `awb down`,
  machine sleep) then resumes where it stopped instead of redoing everything — and you can
  safely stop a run to re-tune concurrency, then relaunch.
- **Mind the shared egress IP.** All profiles and tabs share one outbound IP. Fanning wider
  speeds up visiting **many distinct sites**, but for a step that hammers **one** service
  (e.g. a search engine), more parallel requests get rate-limited / CAPTCHA'd sooner — not
  finished faster. Throttle those steps.

## Tools

13 tools, full parity, all verified live in a real browser:

| Tool | Args | Returns | Note |
|------|------|---------|------|
| `navigate` | `url`, `newTab`(bool), `group_title` | `{success, url, tabId}` | First call opens a tab — see [Tabs](#tabs-and-the-current-tab). `group_title` sets the group's visible label |
| `find_tab` | `url`, `active`(bool) | `{success, url, tabId}` | Select an already-open tab as the current one — see [Tabs](#tabs-and-the-current-tab) |
| `snapshot` | — | `{url, title, tree}` with `@e` refs | **Accessibility tree** (text) — use this to read page content and locate elements |
| `click` | `selector` (@e ref or CSS) | `{success, tag, text}` | Synthetic `el.click()` |
| `fill` | `selector`, `value` | `{success, tag, mode}` | Works on `<input>`/`<textarea>` AND `[contenteditable]` (ProseMirror/Lexical/Slate). `mode` is `"value"` or `"contenteditable"` |
| `evaluate` | `code` (supports async/await) | `{type, value}` | |
| `screenshot` | `format`(png\|jpeg), `quality`(0-100), optional `selector` (@e/CSS), optional `path` | `{format, path, sizeBytes, mimeType}` | Returns a file path, not base64 — see [Screenshots](#screenshots) |
| `network` | `cmd`(start\|stop\|list\|detail), `filter`, `requestId` | request/response data | Capture requests/responses |
| `upload` | `selector`, `files`(string[]) | `{success, fileCount}` | |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, optional `path` | `{path, sizeBytes, mimeType, pageTitle}` | Render current page → PDF, returns a file path — see [Save as PDF](#save-the-current-page-as-pdf) |
| `list_tabs` | — | `{success, tabs:[{tabId, url, title, active, groupTitle}]}` | Inspect tabs in the current session |
| `close_tab` | — | `{success, closed: bool}` | Close the current tab in the session |
| `close_session` | — | `{success, closed: int}` | Close all tabs in the session — `closed` is the count. See [Sessions](#sessions) |

### Tabs and the current tab

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`) act on the **current
tab** — the one you most recently opened with `navigate` or selected with `find_tab`. Because the
daemon attaches `chrome.debugger` **per tab**, multiple tabs in the same profile can be driven
concurrently from parallel `/command` requests.

- **Opening pages**: use `newTab:true` when pages should coexist (comparing, cross-referencing,
  or running in parallel); omit it to send the current tab to a new URL.
- **Going back to an earlier tab**: call `find_tab` to make a tab you already opened the current
  one again. Pass the tab's **full URL** — take it from `list_tabs` or the earlier `navigate`
  result. A bare root domain may miss a `www.` tab, so prefer the exact URL. `active:true` picks
  the tab the user is currently viewing; otherwise the leftmost match wins.
- If `find_tab` returns "no open tab found", the page isn't open — `navigate` with `newTab:true`
  instead.

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"find_tab","args":{"url":"https://www.example.com","active":true},"session":"research","profile":"Work"}'
```

### Call Format

Every command carries a top-level `session` naming the current task — see [Sessions](#sessions).
Add a top-level `profile` to target a specific profile (omit for the default). The examples in
later sections omit them only for brevity; in real calls always include `session` (and `profile`
when driving a non-default profile).

```bash
curl -s -X POST http://127.0.0.1:10086/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"My task"},"session":"my-task","profile":"Work"}'
```

## Sessions

**One task = one session = one tab group.** A `session` collects every tab this task opens into a
single Chrome tab group, so the user sees one group representing "what the agent is doing right
now". Pass it as a **top-level field** of the request body (not inside `args`).

Rules:

1. **Pick one session name when the task starts, put it on _every_ command, and never change it
   mid-task.**
2. **One task uses one session — even across multiple sites.** Searching and then opening results
   on three different domains all share the same session and land in the same group. **Do not
   switch session names per site** — that is the #1 cause of fragmented tab groups.
3. Name the session after the **task**, not the site or domain — e.g. `camping-research`,
   `phone-compare`.
4. `group_title` is the human-readable label shown on the group in the browser. Pass it on the
   **first** `navigate`; later calls in the same session don't need it.
5. Use multiple sessions **only when the user asks for several unrelated tasks at once** — one
   session per task.

```bash
# First tab of the task: set session + human-readable label
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.google.com/search?q=tents","newTab":true,"group_title":"Camping gear research"},"session":"camping-research","profile":"Work"}'

# Another SITE, SAME task → same session → joins the same group automatically
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"navigate","args":{"url":"https://www.example.com/search?q=tents","newTab":true},"session":"camping-research","profile":"Work"}'

# Every later command carries the same session
curl -s -X POST http://127.0.0.1:10086/command \
  -d '{"action":"snapshot","args":{},"session":"camping-research","profile":"Work"}'
```

When the task is finished and the user no longer needs these pages, `close_session` clears the
whole group. If they might want to look further, deliver your answer first and leave the tabs
open — closing too eagerly throws away work the user can still see.

## Screenshots

The daemon writes the image to disk and returns `{format, path, sizeBytes, mimeType}` — never
base64, since the model can't read raw image bytes. Take the `.path` and open it with the `Read`
tool to actually see it.

```bash
# Default: PNG of the visible viewport, daemon picks a temp path
curl ... -d '{"action":"screenshot","args":{}}'
# Options (each independent): JPEG quality, element-only via @e/CSS selector, custom output path
curl ... -d '{"action":"screenshot","args":{"format":"jpeg","quality":60}}'
curl ... -d '{"action":"screenshot","args":{"selector":"@e123"}}'
```

A caller-supplied `path` is honored verbatim (parent dirs created, existing file overwritten) —
use a unique name to avoid clobbering. `save_as_pdf` follows the same rule.

## Prefer snapshot over CSS/JS selectors

`snapshot` returns interactive elements with **stable `@e` refs** based on semantic role/name.
Use them directly with `click`/`fill` — they survive CSS class hash changes that break
manually-written selectors.

Fall back to `evaluate` (JS) only when:

- The target has no `@e` ref in the snapshot
- You need attributes not in the snapshot (e.g., `href`)
- You need to dispatch complex event sequences, or scroll

## Evaluate tips

- Always use compact `JSON.stringify(data)` — never add `null, 2` formatting. Indentation and
  newlines can inflate the response several times over, causing truncation during transmission.
- `evaluate` calls share the page's JS realm — re-declaring the same `const`/`let` across two
  calls throws `SyntaxError`. Wrap in an IIFE for a fresh scope:
  `(() => { const x = ...; return x; })()`.

## Text input — use `fill`

`fill` handles native inputs and contenteditable. Pass selector (CSS or `@e` ref) + value:

| Target | What `fill` does | Returned `mode` |
|--------|------|------|
| `<input>` / `<textarea>` | Sets `.value` via native setter, fires `input`/`change`. | `"value"` |
| `[contenteditable]` (ProseMirror / TipTap / Lexical / Slate / Quill etc.) | Focuses, selects all existing content, calls `document.execCommand('insertText', ...)` which fires `beforeinput`/`input` with `inputType:'insertText'` and `data:value`. | `"contenteditable"` |
| Other element | Best-effort `.value` + events. | `"value"` |

`fill` is **clear-and-insert**: existing content is replaced. For "append to existing text", read
the current value via `evaluate`, concatenate, then `fill` with the result.

## Form submit / special keys

There's no separate "press Enter" tool. To submit a form, `click` the submit button directly (its
`@e` ref or selector). To dispatch a key event programmatically (e.g. Escape to close a modal):

```bash
{"action":"evaluate","args":{"code":"document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"}}
```

## Save the current page as PDF

`save_as_pdf` renders the current page to PDF and returns the file path. All args optional:

- `paper_format`: `letter` (default) \| `a4` \| `legal` \| `a3` \| `tabloid`
- `landscape`: `false` (default)
- `scale`: `1.0` (default), range `[0.1, 2.0]`
- `print_background`: `true` (default) — keep background colors
- `path`: caller-supplied output path; if absent, daemon picks a default under OS temp dir using
  the page title as the filename

`path` semantics match `screenshot`: written verbatim, parent dirs auto-created, existing files
overwritten.

## Known limitations

- **Sites that strictly check `event.isTrusted`** (some banking portals, captcha challenges)
  reject `fill` and `click` because both go through DOM-level synthetic events
  (`isTrusted=false`). This is a product boundary, not a bug.
- **Cross-origin iframes**: `fill`, `click`, `evaluate`, and `snapshot` operate on the top frame.
  If a target element lives in a same-page iframe from a different origin, navigate to the
  iframe's URL directly instead.

## Scope and limits

- **macOS-first** (Google Chrome). Linux/Windows is a documented follow-up.
- **One daemon per profile**, each on a deterministic hashed port with its own isolated state.
- **`:10086` is reserved** for the router — it is never assigned to a profile.
- **Localhost-only**: the extension connects only to a `127.0.0.1` daemon you run. No remote
  server is ever contacted, no analytics, no account.
- node engines `>=18`.
