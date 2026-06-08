# Publishing & distribution

`kimi-webbridge-fleet` ships through three channels. **This GitHub repo is always the source
of truth** — npm and the Claude Code plugin both build from it, so every release flows from a
single `git push`.

## 1. npm — the CLI (`kwb` / `npx kimi-webbridge-fleet`)

```bash
npm login                        # one-time; opens the browser
npm pack --dry-run               # confirm tarball contents first
npm publish --access public      # 0.0.1 is unscoped → public by default
npx kimi-webbridge-fleet profiles  # smoke-test the published package
```

The tarball is defined by `files[]` in `package.json` (`bin/`, `src/`, `skills/`,
`.claude-plugin/`, plus the docs).

## 2. Claude Code plugin — direct install (works the moment this repo is pushed)

This repo is its own single-plugin marketplace: `.claude-plugin/marketplace.json` (named `kwb`)
+ `.claude-plugin/plugin.json`, with the skill at `skills/kimi-webbridge-fleet/SKILL.md`. No
third party required:

```bash
/plugin marketplace add jeet-dhandha/kimi-webbridge-fleet
/plugin install kimi-webbridge-fleet@kwb
```

> **Smoke-test this before announcing** (pre-mortem T3 — don't ship unverified install steps):
> after pushing, run the two commands above in a clean Claude Code session and confirm the skill
> loads as `/kimi-webbridge-fleet:kimi-webbridge-fleet`.

## 3. Third-party skill marketplaces — discovery / reach

> **Principle: don't carpet-bomb.** Submitting one browser-automation skill to every "skills
> marketplace" on the internet is a spam pattern — most either auto-crawl (so a submission is
> noise) or are theme-curated and will reject an off-topic entry. Below is every site from the
> launch shortlist, triaged by what it actually *is*. Spend effort only on Tier 1–2.

### Already covered — no submission step

- **Self-marketplace + npm** (§1, §2) — the real install path; LIVE on `git push`.
- **skills.sh** (Vercel / `vercel-labs/skills`) — installs via `npx skills add <owner/repo>` from
  *any* public repo, so it **already works against this repo today**; there is no registry to submit
  to (listing on the site is crawl/editorial). Verified: their repo has no CONTRIBUTING/registry
  submission flow — just the `npx skills` tool.
- **Index / auto-crawler sites** — see the dedicated table below; most auto-index, but a couple
  have an optional submit form worth using.

### Manual web/account submit — the only places needing active effort

No GitHub-PR path — these are dashboard/web-form submissions, often with a review or security scan.
This is what the **GCP_2 Chrome profile** is for (drive the real logins via Kimi WebBridge). Pick
the credible ones; skip the long tail.

| Site | Mechanism | Notes |
| --- | --- | --- |
| **Agensi** (agensi.io) | Dashboard submit + automated security scan; Stripe payouts | Curation/scan = credibility; good first manual listing |
| **LobeHub** (lobehub.com/skills) | Publish SKILL.md bundle via account | Large catalog; also crawls GitHub, so may appear on its own |
| **MCP Market** (mcpmarket.com) | "Publish Skill" tool (maps dirs, versions, git push) | Tooling-assisted publish |
| **Pawgrammer** (skills.pawgrammer.com) | Community submit | Plugin-marketplace style |
| **Qoder** (qoder.com/marketplace) | Account submit | Qoder-IDE audience; lower fit |
| **Cyrus** (atcyrus.com/skills) | Account submit | Cyrus-agent audience; lower fit |
| **goose** (goose-docs.ai/skills) | "Submit Skill" web flow | goose-agent audience; SKILL.md is portable |

### Index / auto-crawler sites — mostly passive, two have a fast-track form

These discover public `SKILL.md` repos by crawling, so the baseline requirement is just "repo is
public and pushed." A couple expose an optional submit form to jump the queue — use those.

| Site | Action | Notes |
| --- | --- | --- |
| **skillsllm.com** | **Submit form** at `/submit` | Active — submit the repo to fast-track indexing |
| **claudeskills.info** | Check in-browser | Bot-walls server fetches (403); look for a submit link via GCP_2 |
| **agent-skills.cc** | Check in-browser | Bot-walls server fetches (403); look for a submit link via GCP_2 |
| **skillsmp.com** | Passive | FAQ confirms auto-index of public repos; no submit form |
| **awesomeskill.ai** | Passive | Auto-indexes GitHub `SKILL.md`; no visible submit form |

### Skip — off-theme, wrong ecosystem, or not a marketplace

- **netresearch/claude-code-marketplace** — looked like a catalog-of-references, but on inspection
  all **40** entries are `netresearch/*`-owned, there's no `CONTRIBUTING.md`, and the theme is
  TYPO3/PHP/Go/enterprise. It's a **single-vendor curated catalog**, not a community marketplace —
  a cold third-party PR adding a macOS browser-automation skill will almost certainly be closed.
  *If* you want to try anyway, open an **issue** first ("do you accept community skills?") rather
  than a surprise PR. (Their schema entries use only `name` / `description` / `source` / `category`
  — no `author`/`homepage`/`license`.)
- **huggingface/skills** — curated to the *HF ecosystem* (hf-cli, datasets, trainers). A browser-
  automation skill is off-theme; a PR would almost certainly be declined. Don't.
- **phuryn/pm-skills** — *product-management* skills only. Wrong category.
- **Mycroft** (openconversational.ai) — *voice-assistant* skills, a different "skill" standard
  entirely (not SKILL.md). Not applicable.
- **alirezarezvani/claude-skills** — secondary *vendored* mirror (copies the skill into their
  monorepo → you lose source-of-truth, every update needs a PR). Optional, much later, only if the
  reach is worth the maintenance. Position as the multi-profile, real-login alternative to their
  headless "Playwright Pro".
- Article/listicle links (KDnuggets, Reddit threads, the Agensi blog) are coverage, not
  marketplaces — nothing to submit.

## Release checklist

1. `npm pack --dry-run` — confirm tarball contents.
2. `git push` — makes the plugin install path (#2) live.
3. Smoke-test `/plugin marketplace add jeet-dhandha/kimi-webbridge-fleet` + install (gates the posts).
4. `npm login && npm publish --access public`; smoke-test `npx kimi-webbridge-fleet profiles`.
5. Launch posts (see `docs/LAUNCH-POSTS.md`): r/LocalLLaMA + r/ClaudeAI, then HN. **Only after #3.**
6. Optional reach: manual web/account submits via the GCP_2 profile (Agensi first). Auto-crawlers
   and skills.sh need no action. netresearch/HF are not viable targets (see §3 Skip).
