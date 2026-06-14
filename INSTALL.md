# Installing agent-webbridge

Two pieces: a **daemon + CLI** (from npm) and a **Chrome extension** (installed with Chrome's
built-in "Load unpacked"). There is **no Chrome Web Store listing** — and you don't need one.
The whole thing is open-source (MIT), localhost-only, no account, no telemetry.

**Requirements:** macOS + Google Chrome, Node.js ≥ 18.

---

## Recommended: let the CLI do it

```bash
npm i -g agent-webbridge          # installs the daemon + the `awb` CLI (`kwb` is an alias)
awb setup "Work"                  # or any profile name / email / "Profile 2"
```

`awb setup`:

1. Prints the **exact extension folder** to load and opens `chrome://extensions`.
2. **Polls** while you do the one step Chrome reserves for a human:
   - toggle **Developer mode** ON (top-right),
   - click **Load unpacked**,
   - select the printed folder.
3. As soon as it detects the load, it points the profile's extension at its daemon and brings
   the fleet up.

Check readiness any time (also what an orchestrating agent polls):

```bash
awb check --json        # per profile: developerMode / loaded / enabled / daemonUp / connected + a nextStep hint
awb doctor              # read-only environment self-check
awb status              # fleet status — extensionConnected:true per profile when ready
```

That's it — start driving Chrome via `POST http://127.0.0.1:10086/command` (see the
[README](https://github.com/jeet-dhandha/agent-webbridge#readme)).

---

## Manual: install from the release zip

If you'd rather not use npm for the extension, download
`agent-webbridge-extension-<version>.zip` from the
[latest release](https://github.com/jeet-dhandha/agent-webbridge/releases/latest) and:

1. **Unzip** it to a folder you'll keep (e.g. `~/agent-webbridge-extension`). Chrome runs the
   extension **from this folder**, so don't delete it after loading.
2. Open `chrome://extensions` in the Chrome profile you want to drive.
3. Toggle **Developer mode** ON (top-right).
4. Click **Load unpacked** and select the unzipped folder.
5. Confirm the **Agent WebBridge** card appears and is enabled. Its id should be
   `ifodkkbkmngjlkhiphcjmbceeolhpfeo` (stable, derived from the manifest key).

You still need the daemon + CLI for the rest:

```bash
npm i -g agent-webbridge
awb connect "Work"      # point the loaded extension at its daemon (zero clicks; quits Chrome to write)
awb up "Work"           # start the daemon + router, open the window, connect
awb status              # extensionConnected:true → ready
```

---

## Troubleshooting

- **"Load unpacked" button is missing** → Developer mode isn't on. Toggle it (top-right of
  `chrome://extensions`). `awb check` reports `developerMode: false` in this case.
- **`awb setup` times out** → you haven't loaded the folder yet, or you loaded the wrong one.
  Re-run `awb setup "<profile>"`; it reprints the exact path and keeps polling.
- **Extension loaded but `connected: false`** → run `awb connect "<profile>"` then
  `awb up "<profile>"`. `awb connect` writes the daemon URL while Chrome is closed.
- **Anything else** → `awb doctor` lists every environment check with a one-line fix.

The extension talks **only** to a daemon you run on `127.0.0.1`; nothing leaves your machine.
