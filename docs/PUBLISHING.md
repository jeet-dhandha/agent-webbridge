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

### netresearch/claude-code-marketplace (catalog-of-references — keeps THIS repo as source)

Open a PR adding one entry to their `.claude-plugin/marketplace.json` `plugins` array. The plugin
code stays here; their catalog just points at it, so every push ships immediately with no
per-release PR:

```json
{
  "name": "kimi-webbridge-fleet",
  "source": { "source": "github", "repo": "jeet-dhandha/kimi-webbridge-fleet" },
  "description": "Drive multiple real Chrome profiles with their live Google logins simultaneously through Kimi WebBridge — multi-account browser automation in the user's actual Chrome (not headless like Playwright/Firecrawl).",
  "author": { "name": "jeet-dhandha" },
  "homepage": "https://github.com/jeet-dhandha/kimi-webbridge-fleet",
  "license": "MIT",
  "category": "automation"
}
```

### alirezarezvani/claude-skills (secondary mirror — vendored, more reach)

Vendors a copy of the skill into their monorepo (you lose source-of-truth control; updates need a
PR each time). Add as a secondary listing once #2 is verified. Position it as the multi-profile,
real-login alternative to their existing headless "Playwright Pro".

### Auto-crawlers (awesomeskill.ai, claudeskills.info, agent-skills.cc, skillsllm.com)

No submission step — they index public repos that contain a `SKILL.md`. They should pick this up
once the plugin structure is pushed; nothing to do.

## Release checklist

1. `npm pack --dry-run` — confirm tarball contents.
2. `git push` — makes the plugin install path (#2) live.
3. Smoke-test `/plugin marketplace add jeet-dhandha/kimi-webbridge-fleet` + install.
4. `npm login && npm publish --access public`; smoke-test `npx kimi-webbridge-fleet profiles`.
5. Open the netresearch PR (#3).
6. Launch posts: r/LocalLLaMA + r/ClaudeAI, then HN.
