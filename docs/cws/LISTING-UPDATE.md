# Listing update: remove the unverified "bot detection" claim

**Who does this:** the owner, by hand, in the Chrome Web Store Developer Dashboard (item
`kgnhhbkooeplfdkfnicgekdmegckcnpl`). Agents cannot edit the dashboard.

**Which copy is right:** the corrected line is in commit `79b2c88` ("docs: remove unverified speed and
bot-detection claims"). That commit is on `feat/zero-restart-connect`, `feat/v1.3.3-completion`,
`feat/home-slim-prompt` and `docs/agent-operating-rules`, but not on `main`. The branch this file was
written on still has the old line in `docs/cws/STORE-LISTING.md`. The replacement text below is taken
from the corrected version.

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

1. **npm package description** (`package.json` line 4). It still reads "100% local, no bot detection." The fix
   (commit `79b2c88`) goes live only with the next `npm publish`.
2. **Dev.to article** (body line 59, the comparison table). The live row is:
   `| **Bot Detection Bypass** | ❌ Frequently flagged | ⚠️ Varies | ✅ Authentic Chrome | ✅ **Authentic Chrome** |`
   Replace it with:
   `| **Browser identity** | ❌ Often challenged | ⚠️ Varies | ✅ Your own Chrome profile | ✅ **Your own Chrome profile** |`
   The corrected row is in `docs/devto-webbridge-launch.md` on the feature branches. The copy on this branch and on
   `main` still has the old row at line 68.
3. **GitHub Pages site** (served from `main` `/docs`). On `main` today, these unhedged lines are live:
   - `docs/index.html` line 1255: "bypassing headless bot detection entirely"
   - `docs/chrome-mcp-server/index.html` line 487: "No bot flags; real browser fingerprint"
   - `docs/real-chrome-vs-headless/index.html` line 365: "100% genuine browser fingerprint"

   The hedged versions are in commit `79b2c88`. They reach the Pages site when that commit is merged to `main`.
