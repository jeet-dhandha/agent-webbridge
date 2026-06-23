# Chrome Web Store — submission checklist & decisions

Account: non-trader (declared). Dashboard:
https://chrome.google.com/webstore/devconsole/b759666c-bb65-4022-aad9-b7f36de35cb9

## The extension-id problem (decides the whole setup change)

**Verified (high confidence, two independent checks):** the Web Store does **not**
honor a developer-supplied manifest `key`. On a new-item upload it either rejects the
`key` field ("key field is not allowed in manifest") or ignores it, and **mints its own
keypair** — so the published id will **not** be `ifodkkbkmngjlkhiphcjmbceeolhpfeo`.
The store id is fixed at first upload and is then permanent. It is only knowable
*after* that first (even draft) upload.

The daemon detects the extension by id (`AWB_EXT_IDS` membership), so this matters.
Two paths:

- **Path A — keep `ifodk…` on the store (needs the original private key).** Only
  possible if you still have the `key.pem` whose public half is the one in the current
  manifest. Put that `key.pem` at the **zip root** on the *first* upload (and remove the
  public `key` field from the store manifest); the store then adopts your keypair and the
  published id == `ifodk…`. **No code change needed** — setup just deep-links to the
  listing. *(No `key.pem` exists in this repo; only you know if it's saved elsewhere.)*

- **Path B — adopt the store-assigned id (no private key).** Strip the `key` field, upload
  a draft, read the assigned **Item ID** from the dashboard, then add it to the daemon's
  `AWB_EXT_IDS`. Small code change (below). This is the documented, normal path.

## Code change for Path B (small, already-seamed)

Audited — the `AWB_EXT_IDS` array is the single seam:

1. `src/profiles.mjs` — add `AWB_EXT_ID_STORE = "<store id>"`, include it in
   `AWB_EXT_IDS`, and change `isKimiExt` from `===` to `AWB_EXT_IDS.includes(e.id)`.
   Everything downstream (`awb check`, the `awb setup` install poll, `awbExtId`) already
   flows through this.
2. `src/storage.mjs` — already loops `AWB_EXT_IDS` for read (line ~172) and write
   (~238); no change needed (the connect/up local_url write finds the store build too).
3. `src/daemon/wshub.mjs` — connected path already accepts any non-empty extension id;
   no change.
4. **`awb setup` (`bin/awb.mjs` `cmdSetupInteractive`)** — for store installs, open the
   CWS listing URL instead of `chrome://extensions`, drop the Developer-mode / Load-unpacked
   instructions, and **reuse the existing detection poll** (it already matches once the
   store id is in `AWB_EXT_IDS`). Add a `CWS_LISTING_URL` constant.
5. Store build only: **remove the `key` field** from `manifest.json` before zipping
   (keep the dev/unpacked build's `key` for the Load-unpacked path).

Keep the Load-unpacked path as the guaranteed fallback regardless.

## Approval risk: UNCERTAIN (plan for in-depth review)

`debugger` + `<all_urls>` + a localhost remote-control bridge is the highest-scrutiny
category → expect manual, in-depth review (days–weeks). Top rejection risks:

1. **"Non-functional / can't reproduce"** — the extension is inert without the daemon. →
   Mitigated by the reviewer test instructions in STORE-LISTING.md.
2. **Single-purpose / "naked bridge"** — minimal user-facing UI. → Strengthen the popup
   (clear consent text, a visible "driving" indicator, a Disconnect kill-switch).
3. **Remote-code misread** of the `evaluate` tool. → Privacy tab: "No remote code," with
   the CDP-vs-hosted-code distinction ready to explain.
4. **Broad-host suspicion.** → Lead every surface (listing, privacy policy, reviewer
   notes) with the on-device / `127.0.0.1` / nothing-leaves-your-machine framing; link the
   public MIT repo so reviewers can read the code.

## Required before you can submit

- [ ] Decide Path A vs B (the private-key question).
- [ ] Build the **store zip** with the `key` field removed (and `key.pem` at root if Path A).
- [ ] Host the **privacy policy** at a public HTTPS URL (the `gist-post` skill can do this).
- [ ] **Screenshots** 1280×800 (≥1) — see STORE-LISTING.md.
- [ ] Privacy tab: single purpose, per-permission justifications, remote-code = No, data
      disclosures + 3 certifications — all drafted in PERMISSION-JUSTIFICATIONS.md.
- [ ] Listing: short + detailed description, category Developer Tools — in STORE-LISTING.md.
- [ ] Reviewer test instructions — in STORE-LISTING.md.

## Submission itself

The actual "Submit for review" is an outward-facing, account-bound action — it will be
done by you (or by driving your logged-in browser only on your explicit go), never
automatically. Everything above is prepared so it's a fill-and-submit.
