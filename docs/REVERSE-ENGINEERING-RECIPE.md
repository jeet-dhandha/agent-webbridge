# Reverse-engineering & patch recipe (copy-paste, small-agent friendly)

Every `grep`/`strings`/patch command used to discover Kimi WebBridge's internals
and to patch the extension — literal and runnable. A small agent can follow this
top to bottom. **Every patch step ends with a verification command; run it.**

## 0. The two artifacts

| Artifact | Location | Editable? |
|---|---|---|
| Daemon | `~/.kimi-webbridge/bin/kimi-webbridge` | **No** — compiled, stripped Go binary. Inspect with `strings` only. |
| Extension | `~/Downloads/kimi-webbridge-extension/` (unpacked) | **Yes** — `background.js` is minified-but-valid JS. Patchable. |

> Only the **extension** can be changed without the source. Anything that needs
> daemon behavior (multi-slot, profile routing) cannot be patched here — see §4.

---

## 1. Discovery greps (what each reveals)

Run from `~/Downloads/kimi-webbridge-extension/`.

```bash
# WS endpoint + the per-profile override keys (how the extension picks its daemon)
grep -oE 've=.ws://127\.0\.0\.1:10086/ws.' background.js     # default daemon URL
grep -oE 'WS_URL:.ws_url.' background.js                      # chrome.storage.session key
grep -oiE '.{0,30}local_url.{0,60}' background.js | head      # chrome.storage.local override + connect order

# The command system: registry map, register fn, dispatch, and the unknown-tool throw
grep -oE 'var W=new Map;function G\(e\)\{W\.set\(e\.name,e\)\}' background.js   # the handler map W
grep -oE 'function ge\(\)\{ee\(\)(,G\(new [A-Za-z]+\))+\}' background.js        # where every handler is registered
grep -oE 'function _e\(e,t\)\{let n=W\.get\(e\);if\(!n\)throw Error\(.Unknown tool: ' background.js  # dispatch by action name

# All browser capabilities the extension actually uses
grep -oiE 'chrome\.(tabs|tabGroups|windows|storage|debugger|identity)\.[a-zA-Z]+' background.js | sort -u

# Why list_tabs is session-scoped (returns only the daemon's own tabs)
grep -oE 'name=.list_tabs.;async execute\([^)]*\)\{[^}]*\}' background.js | head -c 300
```

Daemon facts (binary — `strings` only):

```bash
B=~/.kimi-webbridge/bin/kimi-webbridge
strings "$B" | grep -iE 'already running|slot held by|replaced_session'   # singleton + single-slot model
strings "$B" | grep -oE 'https?://127\.0\.0\.1:10086/[a-z]+'              # hardcoded :10086 endpoints (probe/stop)
strings "$B" | grep -iE '__profile_set|__profile_unset|mLockProfile'      # latent profile hooks
```

What you learn: default daemon URL is `ws://127.0.0.1:10086/ws`, overridable per
profile via `chrome.storage.local.local_url`; actions are dispatched by name
through the map `W`, and **an unknown action name reaches the extension and is
thrown there** — which is the hook that lets us add an action with *no daemon
change* (§3). The daemon enforces a singleton (`already running`) and a single
slot (`slot held by %s`), both of which need daemon source to change (§4).

---

## 2. Confirm an anchor before patching

A patch is only safe if its anchor exists **exactly once**. Always check:

```bash
F=~/Downloads/kimi-webbridge-extension/background.js
grep -c 'G(new me)}' "$F"     # must print 1
```

---

## 3. PATCH (testable today): add a whole-profile `list_all_tabs` action

`list_tabs` only returns the daemon's session tabs. This adds a `list_all_tabs`
action that returns **every** open tab in the profile via `chrome.tabs.query`.
It works against the **stock daemon** because the daemon relays any unknown
action to the extension's dispatcher (§1).

**Apply** (idempotent-safe: it checks the anchor is unique first):

```bash
F=~/Downloads/kimi-webbridge-extension/background.js
cp "$F" "$F.bak"                 # always keep a backup
node -e '
const fs=require("fs"), f=process.argv[1];
let s=fs.readFileSync(f,"utf8");
const anchor="G(new me)}";
const inject=`G(new me),G(new(class{name="list_all_tabs";async execute(){let t=await chrome.tabs.query({});return{success:!0,tabs:t.map(e=>({tabId:e.id,url:e.url??"",title:e.title??"",windowId:e.windowId,active:e.active,groupId:e.groupId}))}}}))}`;
if((s.split(anchor).length-1)!==1){console.error("anchor missing or not unique — abort");process.exit(1);}
fs.writeFileSync(f, s.replace(anchor, inject));
console.log("patched");
' "$F"
```

**Verify the patch (do not skip):**

```bash
grep -c 'list_all_tabs' "$F"     # must print 1
node --check "$F" && echo "syntax OK"   # must print: syntax OK
```

> Verified in this repo: anchor is unique, replacement applies, and the patched
> file passes `node --check`.

**Load & live-test:**

```bash
# 1. Load the patched unpacked extension into a profile (cold start):
open -na "Google Chrome" --args --profile-directory="Profile 8" \
  --load-extension="$HOME/Downloads/kimi-webbridge-extension"
# 2. In that profile, point the extension popup at the daemon and Connect.
# 3. Call the new action through the normal daemon:
curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' \
  -d '{"action":"list_all_tabs","args":{},"session":"all-tabs"}'
# Expect: {"ok":true,"data":{"success":true,"tabs":[ ... every open tab ... ]}}
```

**Revert:** `mv "$F.bak" "$F"` and reload the extension.

---

## 4. What you CANNOT patch from the extension (needs daemon source)

These require changing the compiled daemon — see
[`UPSTREAM-NATIVE-MULTIPROFILE.md`](UPSTREAM-NATIVE-MULTIPROFILE.md):

- **Multiple simultaneous slots** (one daemon holding N profile connections) —
  enforced by the daemon (`slot held by %s`).
- **`profile` routing on `/command`** — the daemon dispatches the single slot.
- **Per-profile identity** — the daemon only sees one `extension_id`; the
  extension can *send* a `profile_token` (a one-line patch near the WS `open`
  handler), but nothing consumes it until the daemon is changed.

Until then, `kimi-webbridge-fleet` gets simultaneity by running **one stock
daemon per profile** + a router (no patching at all), which is why it's the
recommended path today.

---

## 5. Generic patch checklist (for any future extension hook)

1. `grep -oE '<minified anchor>' background.js` — find the hook.
2. `grep -c '<anchor>' background.js` — **must be 1** (unique).
3. `cp background.js background.js.bak`.
4. `node -e` string-replace on the exact anchor (never a regex that could match twice).
5. `node --check background.js` — must pass.
6. Reload the unpacked extension; exercise the change on the live surface.
7. Keep `.bak`; chrome/extension upgrades overwrite patches — re-apply after updates.
