# Listing update: remove the unverified "bot detection" claim

**Who does this:** the owner, by hand, in the Chrome Web Store Developer Dashboard (item
`kgnhhbkooeplfdkfnicgekdmegckcnpl`). Agents cannot edit the dashboard.

**Which copy is right:** `docs/cws/STORE-LISTING.md` on this branch already has the corrected line
(commit `79b2c88`, "docs: remove unverified speed and bot-detection claims"). The replacement text below is
taken from it. The Web Store build is also old: it has no zero-restart connect, so a new upload
(see `docs/RELEASE-CHECKLIST.md` step 8) carries both the new code and the text change.

---

## Field 1: Detailed description (the only field that changes)

Find this bullet in the live description:

- **Old (live):**
  `• Real Browser Sessions: Drive your actual Chrome with existing cookies, active logins, and 2FA. No headless re-login walls or bot detection.`

  The text to replace is the last sentence: **"No headless re-login walls or bot detection."**

- **New (replacement):**
  `• Real Browser Sessions: Drive your actual Chrome with existing cookies, active logins, and 2FA. No headless re-login walls.`

  The replacement sentence is **"No headless re-login walls."**

Make no other edits to this field. The corrected `STORE-LISTING.md` differs from the old one only on this line.

## Other fields checked

- Item name: no bot claim.
- Summary (132 chars): no bot claim.
- Reviewer test instructions: no bot claim.
- Category, language, privacy and permission justifications: no change needed for this fix.

---

## Same claim in other places (not the Chrome Web Store)

These are not part of the store upload. Listed so none is missed.

1. **npm package description** (`package.json` line 4). The corrected text is on this branch. npm shows it
   only after `1.3.3` is published (owner step). `1.3.2` on npm still reads "no bot detection."
2. **Dev.to article** (body line 59, the comparison table). The live row is:
   `| **Bot Detection Bypass** | ❌ Frequently flagged | ⚠️ Varies | ✅ Authentic Chrome | ✅ **Authentic Chrome** |`
   Replace it with:
   `| **Browser identity** | ❌ Often challenged | ⚠️ Varies | ✅ Your own Chrome profile | ✅ **Your own Chrome profile** |`
   The corrected row is already in `docs/devto-webbridge-launch.md` on this branch (line 68).
3. **GitHub Pages site** (served from `main` `/docs`). The unhedged lines on `main` today are:
   - `docs/index.html` line 1255: "bypassing headless bot detection entirely"
   - `docs/chrome-mcp-server/index.html` line 487: "No bot flags; real browser fingerprint"
   - `docs/real-chrome-vs-headless/index.html` line 365: "100% genuine browser fingerprint"

   The hedged versions are on this branch. They reach the Pages site when its PR is merged to `main`.
