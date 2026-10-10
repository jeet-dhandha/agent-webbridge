# Release checklist

Ordered steps for cutting an `agent-webbridge` release. Derived from `package.json`, `server.json`,
`agent-webbridge-extension/manifest.json`, `CHANGELOG.md`, `.github/workflows/release.yml`,
`.github/workflows/test.yml` and `scripts/pack-extension.mjs`.

`docs/PUBLISHING.md` is gitignored and still describes the old `kimi-webbridge-fleet` / `kwb` naming.
Do not follow it.

Steps marked **[OWNER]** need the owner's accounts, tokens or browser login. An agent must not do them.

---

## Current state (read 2026-10-10)

| Item | Value | Where it was read |
| --- | --- | --- |
| `package.json` version (main) | `1.3.2` | `package.json` |
| Extension manifest version (main) | `1.3.2` (keeps `key`) | `agent-webbridge-extension/manifest.json` |
| `server.json` top-level `version` | `1.3.1` (stale) | `server.json` |
| `server.json` `packages[0].version` | `1.3.1` (stale) | `server.json` |
| Latest CHANGELOG entry | `[1.3.2] — 2026-10-10` | `CHANGELOG.md` |
| `npm view agent-webbridge version` | `1.3.2` (published 2026-10-10T13:33:57Z) | npm registry |
| MCP registry entry `io.github.jeet-dhandha/agent-webbridge` | lists `1.3.0` and `1.3.1`; `1.3.2` absent | public GET on registry.modelcontextprotocol.io |
| Git tags / GitHub Releases | latest tag and release `v1.3.1`; no `v1.3.2` | `git tag`, `gh release list` |
| Branch `feat/zero-restart-connect` (not merged to main) | `1.3.3` in `package.json`, manifest and CHANGELOG | `git show` |

What this means:

- `1.3.2` is already on npm but has no git tag, no GitHub Release and no MCP registry entry.
- `server.json` is two versions behind npm and must be fixed in the next release commit.
- `npm` still shows the description "no bot detection" (`package.json` line 4 on main). The corrected
  copy is in commit `79b2c88`, which is only on feature branches so far (see `docs/cws/LISTING-UPDATE.md`).
- Decision for the owner: the next release is either `1.3.3` from `feat/zero-restart-connect`
  (recommended, it already carries the corrected copy and the 1.3.3 CHANGELOG entry) or a fresh
  patch number. Merge the chosen branch into `main` before step 2.

---

## 0. Choose the release commit

1. **[OWNER]** Decide the version and merge the release branch into `main` through a PR.
   Never commit straight to `main`.
2. Check the working tree is clean and the release commit is the one you intend to ship:
   `git status` and `git log --oneline -5`.

## 1. Tests and live gates (before any version bump)

1. `npm ci` (or `npm install`).
2. `npm test`. This runs `test/contract.mjs`, `test/platform.mjs`, `test/guard.mjs` and `test/mcp.mjs`.
   It is browser-free. CI runs the same on ubuntu, macOS and Windows with Node 18 and 22
   (`.github/workflows/test.yml`, on push to `main` and on PRs).
3. Live gates. Required by `AGENTS.md` for any change to the daemon, extension, fleet or parallelism path:
   - `AWB_CHROME_BIN="<Chrome for Testing binary>" node scratch/live_m1.mjs` must report 7/7.
   - `AWB_CHROME_BIN="<Chrome for Testing binary>" node scratch/live_m2.mjs` must report 19/19.
   - `scratch/` is gitignored and exists only in the owner's main checkout.
   - **[OWNER]** Run these. They start an isolated Chrome for Testing with its own profile dir.
     Do not point them at the daily Chrome.
4. `npm pack --dry-run`. Confirm the tarball has `bin/`, `src/`, `agent-webbridge-extension/`, `skills/`
   and the docs listed in `package.json` `files`. Confirm nothing from `dist/`, `scratch/` or `node_modules/` is in it.

## 2. Bump versions and changelog (one commit on the release branch)

1. `package.json`: set `"version"` to `X.Y.Z`.
2. `agent-webbridge-extension/manifest.json`: set `"version"` to `X.Y.Z`. Keep the `"key"` field in the
   repo manifest. It pins the dev extension ID `ifodkkbkmngjlkhiphcjmbceeolhpfeo`. Only the `--store`
   build removes it.
3. `server.json`: set the top-level `"version"` AND `packages[0].version` to `X.Y.Z`. Both must match.
4. `CHANGELOG.md`: add a `## [X.Y.Z] — YYYY-MM-DD` section above the previous entry.
5. Check for leftovers: `grep -n "1\.3\.[0-9]" package.json server.json agent-webbridge-extension/manifest.json`.
   Every hit should be `X.Y.Z`.
6. Commit as `release: vX.Y.Z` and open a PR to `main`. **[OWNER]** merges it.

## 3. Build the artifacts (local, nothing published)

1. `node scripts/pack-extension.mjs` writes `dist/agent-webbridge-extension-X.Y.Z.zip`. This is the dev
   build (keeps `key`) that CI attaches on tag, for "Load unpacked".
2. `node scripts/pack-extension.mjs --store` writes `dist/agent-webbridge-extension-X.Y.Z-store.zip`.
   This is the Chrome Web Store build, with `key` removed.
3. The script warns on stderr if the manifest version differs from `package.json`. The output should not contain that warning.
4. Check the store zip: `unzip -p dist/agent-webbridge-extension-X.Y.Z-store.zip manifest.json` must not contain `"key"`.
5. `dist/` is gitignored. Do not commit the zips.

## 4. npm publish [OWNER]

1. **[OWNER]** Publish from the repo root on the merged release commit:
   `npm publish --access public`.
   Use a granular automation token that bypasses 2FA, or pass a one-time OTP at publish time.
   Set the token only in your shell environment or via `npm login` on your own machine.
   Never paste a token into a file, a chat, a commit or a PR.
2. If the GitHub secret `NPM_TOKEN` is set, the tag push in step 7 runs the same publish in
   `release.yml`. That step fails with "version already published" after the GitHub Release is created.
   The Release itself is fine. Remove the secret before tagging if you want a green run.

## 5. Verify npm (read-only, anyone)

1. `npm view agent-webbridge version` must print `X.Y.Z`.
2. `npm view agent-webbridge@X.Y.Z description` must not contain "no bot detection" (true once 1.3.3 is published).

## 6. MCP registry publish [OWNER]

The registry checks that the npm package at the version in `server.json` carries the matching `mcpName`
(`io.github.jeet-dhandha/agent-webbridge`, already in `package.json`). That is why step 4 must come first.

1. **[OWNER]** `mcp-publisher login github`. This is a GitHub device-flow login: you open the URL it prints
   and enter the code. The login must be the `jeet-dhandha` account, which owns the `io.github.jeet-dhandha/*` namespace.
2. From the repo root on the release commit, with the updated `server.json`: **[OWNER]** `mcp-publisher publish`.
   Run `mcp-publisher --help` first to confirm the subcommand syntax. This checklist did not verify it.
3. Verify (public GET):
   `curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.jeet-dhandha/agent-webbridge"`.
   The output must contain `"version":"X.Y.Z"` with `"isLatest":true`.

## 7. Git tag and GitHub Release [OWNER]

1. **[OWNER]** `git checkout main && git pull`, then:
   `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin vX.Y.Z`.
2. The tag push runs `.github/workflows/release.yml`. It runs `node test/contract.mjs`, builds the dev zip,
   then `gh release create vX.Y.Z dist/agent-webbridge-extension-*.zip INSTALL.md --generate-notes`, then
   `npm publish` if `NPM_TOKEN` is set. Do not also create the Release by hand unless CI fails.
3. Store zip on the Release: **recommended not to attach it.** The workflow attaches only the dev zip.
   The store zip has no `key`, so a user who loads it unpacked gets a random extension ID. The daemon accepts only
   `kgnhhbkooeplfdkfnicgekdmegckcnpl` (store) and `ifodkkbkmngjlkhiphcjmbceeolhpfeo` (dev), per `src/profiles.mjs` lines 22-24,
   so that user would likely not connect. Keep the store zip for the dashboard upload only.
4. If you do upload it by hand, the glob `dist/agent-webbridge-extension-*.zip` in the workflow matches
   `-store.zip` too. Move the store zip out of `dist/` before running `gh release create` locally.

## 8. Chrome Web Store dashboard [OWNER, manual]

The store zip is needed here because the store mints its own key for the item.
Its manifest has no `key` field.

1. **[OWNER]** Open the Chrome Web Store Developer Dashboard (item `kgnhhbkooeplfdkfnicgekdmegckcnpl`).
2. Upload `dist/agent-webbridge-extension-X.Y.Z-store.zip`. Do not upload the dev zip. The store rejects a
   manifest `key` that differs from its own ("key field value in the manifest doesn't match the current item").
3. The uploaded version must be higher than the version now live in the store. The live store version was not
   verifiable from this checklist.
4. **[OWNER]** Apply the listing text change in `docs/cws/LISTING-UPDATE.md` (one line, Detailed description).
5. Check `docs/cws/PERMISSION-JUSTIFICATIONS.md`. If the manifest `permissions` or `host_permissions` changed
   since the last store-approved version, update the justifications before submitting.
6. **[OWNER]** Submit for review. Reviewer test instructions are in `docs/cws/STORE-LISTING.md`.

## 9. Verify after release

1. `npm view agent-webbridge version` prints `X.Y.Z` (see step 5).
2. The MCP registry shows `X.Y.Z` as latest (see step 6).
3. `gh release view vX.Y.Z --repo jeet-dhandha/agent-webbridge` lists the expected assets.
4. **[OWNER]** The Chrome Web Store dashboard shows the new version as pending review or published.
5. The GitHub Pages site https://jeet-dhandha.github.io/agent-webbridge/ serves the `main` branch, `/docs`.
   Docs changes go live only after they reach `main`. The unhedged bot-detection wording on `main` is live now.
6. Glama: https://glama.ai/mcp/servers/jeet-dhandha/agent-webbridge returned HTTP 404 when checked on
   2026-10-10. The open PR punkpeye/awesome-mcp-servers #16069 is waiting on Glama evaluation.
7. **[OWNER]** The dev.to article still has the "Bot Detection Bypass" row. See `docs/cws/LISTING-UPDATE.md`.

---

## Owner-only steps (summary)

- Choose the version and merge the release PR (step 0).
- Run the live gates on your machine (step 1.3).
- npm publish with your token or OTP (step 4).
- `mcp-publisher login github` device flow and `mcp-publisher publish` (step 6).
- Push the tag and decide on attaching the store zip (step 7).
- Chrome Web Store upload, listing edit and submit (step 8).
- dev.to article edit and any CWS review follow-up (step 9).

## Not verified when this file was written

- The exact `mcp-publisher` subcommand syntax.
- The live Chrome Web Store version and review state.
- Whether a store-built zip loaded unpacked connects to the daemon. This is inferred from `src/profiles.mjs`, not tested.
- The live gates and `npm test` were not run for this file.
