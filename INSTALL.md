# Installing agent-webbridge

Two pieces: a **daemon + CLI** (from npm) and the **Chrome extension** (from the
[Chrome Web Store](https://chromewebstore.google.com/detail/agent-webbridge/kgnhhbkooeplfdkfnicgekdmegckcnpl)).
The whole thing is open-source (MIT), localhost-only, no account, no telemetry.

**Requirements:** macOS + Google Chrome, Node.js ≥ 18.

---

## Recommended: let the CLI do it

```bash
npm i -g agent-webbridge          # installs the daemon + the `awb` CLI
awb setup "Work"                  # or any profile name / email / "Profile 2"
```

`awb setup`:

1. Opens the **Agent WebBridge** Chrome Web Store listing in that profile.
2. **Polls** while you do the one step Chrome reserves for a human:
   - click **Add to Chrome**,
   - confirm **Add extension**.
3. As soon as it detects the install, it points the profile's extension at its daemon and brings
   the fleet up.

Check readiness any time (also what an orchestrating agent polls):

```bash
awb check --json        # per profile: loaded / enabled / daemonUp / connected + a nextStep hint
awb doctor              # read-only environment self-check
awb status              # fleet status — extensionConnected:true per profile when ready
```

That's it — start driving Chrome via `POST http://127.0.0.1:10086/command` (see the
[README](https://github.com/jeet-dhandha/agent-webbridge#readme)).

---

## Developer build: Load unpacked from source

To hack on the extension itself (or run a build before it's on the store), use the in-repo
source instead of the published listing:

```bash
npm i -g agent-webbridge
awb install-dev "Work"  # opens chrome://extensions + prints the folder to Load unpacked, then polls
```

Or do it by hand:

1. Open `chrome://extensions` in the Chrome profile you want to drive.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked** and select the `agent-webbridge-extension/` folder (or an unzipped
   `agent-webbridge-extension-<version>.zip` from a [release](https://github.com/jeet-dhandha/agent-webbridge/releases/latest)).
4. Confirm the **Agent WebBridge** card appears and is enabled. The dev build's id is
   `ifodkkbkmngjlkhiphcjmbceeolhpfeo` (stable, derived from the manifest key). The Web Store
   build has its own store-assigned id — the daemon recognizes both.
5. `awb connect "Work"` then `awb up "Work"` to wire it to its daemon and start the fleet.

---

## Troubleshooting

- **`awb setup` times out** → you haven't clicked **Add to Chrome** yet, or the store page didn't
  open. Re-run `awb setup "<profile>"`; it reopens the listing and keeps polling.
- **Extension installed but `connected: false`** → run `awb connect "<profile>"` then
  `awb up "<profile>"`. `awb connect` writes the daemon URL while Chrome is closed.
- **Developer build: "Load unpacked" button is missing** → Developer mode isn't on. Toggle it
  (top-right of `chrome://extensions`).
- **Anything else** → `awb doctor` lists every environment check with a one-line fix.

The extension talks **only** to a daemon you run on `127.0.0.1`; nothing leaves your machine.
