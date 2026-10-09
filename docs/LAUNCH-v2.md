# Launch pack v2 (supersedes LAUNCH-POSTS.md, which is framed around Kimi WebBridge)

Nothing here is posted. Every outward step waits for an explicit yes. Order matters: the gates come first.

## 0. Gates (do not launch until all are true)

- [ ] `npm test` green on the CI matrix, **including windows-latest**.
- [ ] `awb mcp` verified end to end against a connected Chrome profile, in Claude Code, on macOS and (if you can) Windows.
- [ ] Published to npm as 1.3.0 so `npx -y agent-webbridge mcp` works from a clean machine.
- [ ] A **real** screen recording exists (Claude Code on the left, two Chrome profiles acting on the right). `demo.gif` is an illustration, so do not present it as a recording.
- [ ] Plugin install smoke-tested on a clean machine (gate carried over from LAUNCH-POSTS.md).
- [ ] 10 recipes seeded in `awb-recipes` and 10 `good first recipe` issues open (list in section 6).

## 1. Be findable (low effort, lasting)

**Repo description:** `Let Claude Code, Cursor and any MCP client drive your real, logged-in Chrome. Multiple profiles, parallel tabs, 100% local. macOS + Windows.`
**Topics:** `mcp`, `mcp-server`, `claude-code`, `model-context-protocol`, `browser-automation`, `chrome-extension`, `ai-agents`, `cursor`, `playwright-alternative`, `hacktoberfest`

**Submissions (one PR or form each; read each list's CONTRIBUTING first):**

| Where | Entry |
|---|---|
| Official MCP registry | publish `server.json` (needs `mcpName` in package.json, already set) with the registry's publisher CLI |
| punkpeye/awesome-mcp-servers | `- [jeet-dhandha/agent-webbridge](https://github.com/jeet-dhandha/agent-webbridge) 📇 🏠 🍎 🪟 - Drive your real, logged-in Chrome (multiple profiles, parallel tabs) from any MCP client. Local only.` (confirm the emoji legend and category in their README first) |
| Smithery / Glama / mcp.so | their submit forms; same description |
| awesome-claude-skills, awesome-agent-skills | the bundled skill, under browser automation |

## 2. Answer, don't announce (the main engine)

Find threads, write a useful answer, disclose that you built the tool, link only where the venue allows.

**Where to look** (about 2 relevant HN threads a week; Reddit is busier):
- Reddit search: `"playwright" cloudflare blocked agent`, `claude code browser logged in`, `browserbase alternative`, `mcp browser server`, `puppeteer 2fa`
- Algolia HN search for the same phrases, sorted by date

**Answer shape (what to include):** the specific problem they described, the approach (drive the browser they are already signed in to), one honest limit (macOS and Windows, Chrome only, needs the extension), and the link last. Skip any thread where the tool does not actually solve their problem.

## 3. Reddit post (r/mcp, r/ClaudeAI, r/LocalLLaMA; read each sub's self-promo rule first)

**Title:** `I made an MCP server that drives your real logged-in Chrome (multiple profiles, parallel tabs, nothing leaves localhost)`

**Body:**
```
Headless Playwright keeps getting blocked by Cloudflare or loses my login, and cloud browsers want a monthly fee and my cookies. So I built agent-webbridge: a small Node daemon plus an MV3 Chrome extension that lets Claude Code / Cursor drive the Chrome I already use.

- one daemon per Chrome profile, so several accounts at once; tabs in one profile run in parallel (the extension attaches the debugger per tab)
- MCP server is zero-dependency: npx -y agent-webbridge mcp
- everything is on 127.0.0.1, no account, no telemetry, MIT
- macOS and Windows (the Windows side is newer; CI runs it, but tell me what breaks)

The part that was annoying: an MV3 service worker only reads its config when it starts, and this extension had no startup listener, so writing the daemon URL into its storage on disk did nothing until the worker was woken. Opening the extension's own popup page as a tab wakes it. Happy to go into that.

Repo: https://github.com/jeet-dhandha/agent-webbridge
Looking for: sites where this breaks. I'm collecting working "recipes" for logged-in sites in a separate repo so fixes are one small PR: https://github.com/jeet-dhandha/awb-recipes
```
Attach the real recording. Do not post the same text to several subs on the same day.

## 4. X thread (4 posts)

1. `Headless browsers get blocked. Cloud browsers cost money and hold your cookies. I made an MCP server that lets Claude Code drive the Chrome you're already signed in to. [recording]`
2. `Multiple profiles at once, tabs in parallel, nothing leaves localhost. npx -y agent-webbridge mcp`
3. `Sites change their markup constantly, so I started awb-recipes: tiny, dated recipes for logged-in sites. Verify one in 15 minutes and open a PR.`
4. `macOS + Windows, MIT. Tell me what breaks. github.com/jeet-dhandha/agent-webbridge`

## 5. Long-form article (dev.to, Hashnode, Medium via your crosspost modules)

Working title: **Why my agents drive my real Chrome instead of headless Playwright**
Outline: (1) the failure modes you hit: login loss, Cloudflare, one-profile bridges; (2) the architecture: router, daemon per profile, extension with a debugger attach per tab; (3) the MV3 service-worker bug and the popup-wake fix; (4) the fleet lessons: poisoned tabs, a fast-failing worker draining a queue, the shared egress IP; (5) what it cannot do and when to use something else. Canonical link: the GitHub repo.

## 6. `good first recipe` issues to open in awb-recipes

Verify (each needs a site account): github-gist-create, github-trending, npm-most-depended, linkedin-feed-posts, google-search-results.
New (one issue each): Gmail unread count, GitHub notifications, Stripe dashboard recent payments, Notion page text, Google Calendar today's events, Amazon order history, Reddit inbox, Product Hunt launches, YouTube Studio comments, Google Search Console performance.

## 7. Individual outreach to authors of related browser-agent tools (3 to 5, no bulk mail)

```
Hi <name>, I use <their tool> and like <one specific thing>. I maintain agent-webbridge, which drives a user's real logged-in Chrome over MCP. I started a small repo of dated, per-site recipes (awb-recipes). If any of your site-specific workarounds would fit as a recipe, a PR would be very welcome, and I'm glad to link <their tool> from the README. No pressure either way.
```
Only contact people whose projects genuinely overlap. Do not ask for stars.

## 8. Hacker News

The account `jeetdhandha` has karma 1 and its last three comments (Aug 9 to 11) were killed. The submit path is closed until a human at HN lifts it.
1. Email **hn@ycombinator.com** (draft below). Do **not** create a second account or post link-bearing comments from this one.
2. Only after the account is healthy: Show HN on a Tuesday to Thursday morning US Eastern, with the recording and the MV3 story in the first comment.

Draft appeal:
```
Subject: Account jeetdhandha: comments being killed

Hi, my account jeetdhandha (created June 2026, karma 1) has had its recent comments killed within minutes, including a short comment with no links in an "Ask HN: What are you working on?" thread. I'm a developer building open-source browser tooling and I'd like to participate properly. Could you take a look at whether the account is rate-limited or flagged, and tell me what I should change? I won't post further until I hear back. Thank you.
```

## 9. Measure (check weekly, drop a channel after two flat tries)

GitHub: traffic referrers and the daily star delta. npm: `api.npmjs.org/downloads/point/last-week/agent-webbridge`. Contributors: unique authors with merged PRs on awb-recipes (the target is 20 within 12 months). Baseline on 2026-10-10: 9 stars, 224 downloads a month, 0 external contributors.
