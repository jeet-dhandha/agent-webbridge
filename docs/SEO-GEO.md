# SEO / GEO / AI-agent discoverability playbook

Goal: own the **"kimi webbridge multi-profile / multi-login / multi-account"** query cluster
outright, rank as the **top third-party result** for *kimi webbridge*, and be the **citable
answer** when an LLM is asked "can Kimi WebBridge run multiple accounts at once?".

Honest ceiling: we will **not** outrank kimi.com, the Chrome Web Store, or Edge Add-ons for the
bare head term *kimi webbridge* — that's first-party + store authority. We compete for the
qualified long-tails (where competition is ~zero) and for AI answer-engine citations.

## Done (in-repo)

- [x] `package.json` — description leads with "Kimi WebBridge"; keywords add multi-login,
      multi-account, multiple-accounts, google-accounts, multi-chrome-profile, moonshot-ai, web-automation.
- [x] `README.md` — keyword-rich H1; FAQ section with each heading phrased as an exact search query,
      answer-first sentences (featured-snippet + GEO friendly).
- [x] `docs/index.html` — GitHub Pages landing with a custom `<title>`, meta description, OpenGraph,
      and JSON-LD (`SoftwareApplication` + `FAQPage`).
- [x] `docs/llms.txt` — llmstxt.org-format summary so LLM agents/crawlers get a clean, declarative
      description + Q&A to cite.
- [x] `docs/sitemap.xml`, `docs/robots.txt`, `docs/.nojekyll` — clean indexing for Google Search Console.

## Live repo metadata (one-time, run with confirmation)

```bash
# About description (= og:description = Google snippet)
gh repo edit jeet-dhandha/kimi-webbridge-fleet \
  --description "Kimi WebBridge with multiple Chrome profiles & logins at once — drive several Google accounts simultaneously, not one at a time. Fixes the single-slot / one-login limit: one daemon per profile + a router on :10086." \
  --homepage "https://jeet-dhandha.github.io/kimi-webbridge-fleet/"

# Topics (GitHub search + Google both index these)
gh repo edit jeet-dhandha/kimi-webbridge-fleet \
  --add-topic kimi-webbridge --add-topic webbridge --add-topic moonshot-ai \
  --add-topic multi-profile --add-topic multi-account --add-topic multi-login \
  --add-topic multiple-accounts --add-topic google-accounts --add-topic web-automation \
  --add-topic chrome-extension
```

## Enable GitHub Pages (one-time, repo Settings)

Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / folder `/docs` → Save.
Published at `https://jeet-dhandha.github.io/kimi-webbridge-fleet/`. Then set that as the repo
homepage (the `--homepage` flag above already does it).

## Google Search Console (one-time + monitoring)

1. Add property `https://jeet-dhandha.github.io/kimi-webbridge-fleet/` (URL-prefix). Verify via the
   HTML-tag method — drop the `google-site-verification` `<meta>` into `docs/index.html` `<head>`.
2. Submit `sitemap.xml` under Sitemaps.
3. URL Inspection → Request indexing for the landing page.
4. Watch the Performance report for which of the long-tail queries you're actually impressing on,
   and add/tune FAQ headings to match the real wording people type.

## Off-repo (where the long-tail traffic + backlinks live)

- [ ] **GitHub Discussions** — enable Discussions, open a Q&A titled
      "Using Kimi WebBridge with multiple Chrome profiles / logins at once" with the answer + repo link.
      These get indexed and answer the query directly.
- [ ] **dev.to / Hashnode post** — literal title = the query, e.g.
      "How to run Kimi WebBridge with multiple Chrome profiles (multi-account) at once".
      Fast-indexing domains + a backlink. Cross-post the same content (canonical → your Pages URL).
- [ ] **Reddit / Kimi Discord** — answer existing "can I run two accounts?" threads with a genuine
      explanation + link. Highest-converting, lowest-volume.
- [ ] **Awesome-lists** — PR into `awesome-ai-agents`, `awesome-browser-automation`,
      `awesome-claude-code` (LLMs are trained on / retrieve these → compounding GEO).
- [ ] **npm** — already keyworded; npm package pages rank in Google for the long-tails.

## GEO / AI-agent SEO (Claude, ChatGPT, Perplexity, Google AI Overviews)

The mechanism is different from blue-link SEO: answer engines cite **declarative, structured,
well-sourced** content. Levers, in order:

1. **Answer-first phrasing** — every FAQ answer's *first sentence* is the citable claim. (Done.)
2. **`llms.txt`** — served at site root once Pages is on. (Done.)
3. **JSON-LD `FAQPage`** — machine-readable Q&A pairs. (Done.)
4. **Be the only source** — the multi-profile question currently has no authoritative answer
   anywhere; structured content here becomes the default citation. This is the single biggest lever.
5. **Corroboration** — the more independent places (dev.to, Reddit, awesome-lists, GitHub
   Discussions) state the same fact, the more confidently an LLM will assert + cite it.
6. **Claude Code / skill indexers** — `SKILL.md` + `.claude-plugin/marketplace.json` are already
   crawled by third-party skill marketplaces; keep their `description` fields keyword-honest.
