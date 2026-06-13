# Publishing Agent WebBridge

This is the exact, in-order playbook the maintainer follows to ship a release. Agent
WebBridge has **two distribution surfaces** that move independently:

1. **npm** — the Node daemon + CLI (`agent-webbridge`, command `awb`, alias `kwb`).
2. **Chrome Web Store** — the clean-room MV3 extension (`agent-webbridge-extension/`).

The GitHub repo is the source of truth; both surfaces build from it. Do the npm release
first (it's instant), then the Chrome Web Store submission (it goes through manual review
and can take days to weeks).

> **Two version fields.** `package.json` `version` drives the npm release and the zip
> file name. `agent-webbridge-extension/manifest.json` `version` is what the Chrome Web
> Store reads for the extension. **Bump both** for a user-facing release so they don't
> drift — `scripts/pack-extension.mjs` prints a warning if they disagree.

---

## A. npm — the daemon + CLI

### A.1 Bump and verify the version

```bash
# pick one; bumps package.json version (and commits + tags if the tree is clean)
npm version patch     # or: minor / major / 1.0.1
```

Confirm the tarball is exactly what you intend to ship — its contents are governed by
`files[]` in `package.json` (`bin/`, `src/`, `agent-webbridge-extension/`, `skills/`,
`.claude-plugin/`, and the docs):

```bash
npm pack --dry-run     # lists every file that would be published — read it
```

Sanity-check the runtime install before publishing:

```bash
node --version         # must satisfy "engines": { "node": ">=18" }
npm test               # daemon contract test (expected: 11/11 PASS)
```

### A.2 Publish

You need to be logged in to npm as a user with publish rights to `agent-webbridge`:

```bash
npm whoami             # if this errors, run: npm login   (opens the browser)
npm publish            # publishes the version in package.json
```

`agent-webbridge` is an unscoped package, so it's public by default. After it lands,
smoke-test the published artifact in a throwaway shell:

```bash
npm i -g agent-webbridge
awb status             # CLI resolves; `kwb status` works too (alias)
```

---

## B. Chrome Web Store — the extension

The extension is reviewed **manually** because it requests the `debugger` permission and
`<all_urls>` host access. Expect the review to take **days to weeks**, not minutes. Plan
the npm release and any announcement around that lag.

### B.1 Pack the upload zip

```bash
node scripts/pack-extension.mjs
```

This reads the version from `package.json`, zips `agent-webbridge-extension/` into
`dist/agent-webbridge-extension-<version>.zip` (manifest at the archive root), excludes
dev-only junk (`.orig` backups, `.DS_Store`, logs), and prints the absolute path of the
zip. That printed path is the file you upload. (`dist/` is a build output — don't commit
it.)

### B.2 Create a Chrome Web Store developer account (one-time)

1. Go to the **Chrome Web Store Developer Dashboard**
   (`https://chrome.google.com/webstore/devconsole`).
2. Sign in with the Google account that will own the listing.
3. Pay the **one-time US$5 developer registration fee** and accept the developer
   agreement. This is required once per developer account, not per extension.

### B.3 Upload and fill the listing

1. In the dashboard, click **Add new item** and upload the zip from **B.1**.
2. Fill the **store listing** fields from [`LISTING.md`](./LISTING.md) — name, summary,
   detailed description, category, language, and the screenshots / promo images it
   specifies.
3. Under **Privacy practices**, paste the per-permission justifications from
   [`PERMISSIONS.md`](./PERMISSIONS.md). Every requested permission needs a reason:
   `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, and the `<all_urls>` host
   access. Declare the data-use answers truthfully — Agent WebBridge collects nothing,
   contacts no remote server, and connects only to a daemon on `127.0.0.1` (see
   [`PRIVACY.md`](./PRIVACY.md)).
4. Set the **Privacy policy URL** to a hosted copy of [`PRIVACY.md`](./PRIVACY.md). The
   repo already serves a docs site via GitHub Pages (`docs/`), so host the rendered
   privacy policy there and paste that public URL.

### B.4 Submit for review

1. Choose visibility (**Public**) and the distribution regions.
2. Click **Submit for review**.
3. Because of `debugger` + `<all_urls>`, the item enters **manual review**. You'll get an
   email when it's approved, rejected (with reasons to address and resubmit), or needs
   more info. Don't announce the CWS install path until it's actually published.

---

## C. After CWS publishes — the extension ID

Agent WebBridge ships a fixed `"key"` in `manifest.json`. The Chrome Web Store derives the
**published extension ID from that key**, so as long as the **same `"key"` is kept**, the
published ID equals our dev ID:

```
ifodkkbkmngjlkhiphcjmbceeolhpfeo
```

This is why "Load unpacked" during development and the published store build resolve to the
**same** ID — the daemon, docs, and any pinning can rely on it.

> **Do not rotate the `"key"`.** Replacing or removing it changes the derived ID, which
> breaks every reference to `ifodkkbkmngjlkhiphcjmbceeolhpfeo` (docs, install instructions,
> anything keyed on the extension ID). Keep the key stable across all releases.

After approval, confirm the assigned ID in the dashboard matches the value above. If it
doesn't, the wrong key (or no key) was packed — fix `manifest.json` and resubmit.

---

## Release checklist

1. Bump `package.json` **and** `manifest.json` versions (keep them equal).
2. `npm pack --dry-run` — confirm tarball contents.
3. `npm test` — daemon contract test passes.
4. `npm login` (if needed) → `npm publish`; smoke-test `npm i -g agent-webbridge && awb status`.
5. `node scripts/pack-extension.mjs` — produce `dist/agent-webbridge-extension-<version>.zip`.
6. Upload to the Chrome Web Store; fill listing (`LISTING.md`), permission justifications
   (`PERMISSIONS.md`), privacy policy URL (hosted `PRIVACY.md`); **Submit for review**.
7. After approval, verify the published ID is `ifodkkbkmngjlkhiphcjmbceeolhpfeo`.
