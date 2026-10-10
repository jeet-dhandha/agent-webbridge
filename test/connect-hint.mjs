// connect-hint.mjs — zero-restart connect: the URL the extension accepts through its popup, and
// the popup URL the CLI builds. No browser needed; every chrome.* effect is faked.
import { isLoopbackWsUrl, isOwnPopupSender, applyConnectUrl } from "../agent-webbridge-extension/src/connect_url.mjs";
import { connectHintUrl } from "../src/extension.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); ok ? pass++ : fail++; };

const EXT = "ifodkkbkmngjlkhiphcjmbceeolhpfeo";
const POPUP = `chrome-extension://${EXT}/popup.html`;

// --- URL validation: loopback only
for (const u of ["ws://127.0.0.1:13222/ws", "ws://127.0.0.1:10086/ws", "ws://127.0.0.1:1024/ws"]) check(`accepts ${u}`, isLoopbackWsUrl(u));
for (const u of ["ws://evil.example:9/ws", "ws://127.0.0.1.evil.com:13222/ws", "ws://localhost:13222/ws", "wss://127.0.0.1:13222/ws",
  "ws://127.0.0.1:13222/other", "ws://127.0.0.1:13222/ws?x=1", "ws://127.0.0.1:80/ws", "ws://127.0.0.1:99999/ws", "ws://user@127.0.0.1:13222/ws",
  "ws://127.0.0.1/ws", "http://127.0.0.1:13222/ws", "", null, undefined, 13222]) check(`rejects ${JSON.stringify(u)}`, !isLoopbackWsUrl(u));

// --- sender check: only our own popup page
check("own popup page is accepted", isOwnPopupSender({ id: EXT, url: `${POPUP}#connect=x` }, EXT, POPUP));
check("other extension id is rejected", !isOwnPopupSender({ id: "other", url: POPUP }, EXT, POPUP));
check("a web page is rejected", !isOwnPopupSender({ id: EXT, url: "https://evil.example/popup.html" }, EXT, POPUP));
check("missing sender is rejected", !isOwnPopupSender(undefined, EXT, POPUP));

// --- applyConnectUrl with fakes
function harness(over = {}) {
  const calls = { saved: [], connected: [], closed: [] };
  const args = {
    url: "ws://127.0.0.1:13222/ws", extensionId: EXT, popupUrl: POPUP,
    sender: { id: EXT, url: `${POPUP}#connect=x`, tab: { id: 42 } },
    saveLocalUrl: async (v) => { calls.saved.push(v); },
    connect: async (u) => { calls.connected.push(u); },
    closeTab: async (id) => { calls.closed.push(id); },
    ...over,
  };
  return { args, calls };
}
{
  const { args, calls } = harness();
  const r = await applyConnectUrl(args);
  check("valid URL from own popup: ok", r.ok === true);
  check("stored as a JSON string (the format the fleet writes)", calls.saved[0] === JSON.stringify("ws://127.0.0.1:13222/ws"));
  check("connects to the URL", calls.connected[0] === "ws://127.0.0.1:13222/ws");
  check("closes the popup tab it was opened in", calls.closed[0] === 42);
}
{
  const { args, calls } = harness({ url: "ws://evil.example:9/ws" });
  const r = await applyConnectUrl(args);
  check("non-loopback URL: rejected, nothing stored or connected", r.ok === false && !calls.saved.length && !calls.connected.length && !calls.closed.length);
}
{
  const { args, calls } = harness({ sender: { id: "other", url: POPUP } });
  const r = await applyConnectUrl(args);
  check("foreign sender: rejected, nothing stored or connected", r.ok === false && !calls.saved.length && !calls.connected.length);
}
{
  const { args, calls } = harness({ connect: async () => { throw new Error("boom"); } });
  const r = await applyConnectUrl(args);
  check("connect failure is reported and the tab is left open", r.ok === false && /boom/.test(r.error) && !calls.closed.length);
}
{
  const { args, calls } = harness({ sender: { id: EXT, url: POPUP } });
  const r = await applyConnectUrl(args);
  check("no tab to close (toolbar popup) is fine", r.ok === true && !calls.closed.length);
}

// --- CLI side: the popup URL carries the encoded daemon URL in the hash
const hint = connectHintUrl(EXT, "ws://127.0.0.1:13222/ws");
check("hint URL targets the extension popup", hint.startsWith(`${POPUP}#connect=`));
check("hint URL round-trips the daemon URL", decodeURIComponent(hint.split("#connect=")[1]) === "ws://127.0.0.1:13222/ws");

// --- wiring: popup forwards the hint, background routes SET_URL through applyConnectUrl, popup stays private
const popupJs = fs.readFileSync(new URL("../agent-webbridge-extension/popup.js", import.meta.url), "utf8");
const bgJs = fs.readFileSync(new URL("../agent-webbridge-extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../agent-webbridge-extension/manifest.json", import.meta.url), "utf8"));
check("popup.js forwards #connect= as SET_URL", /#connect=/.test(popupJs) && /type: "SET_URL"/.test(popupJs));
check("background.js handles SET_URL via applyConnectUrl", /type === "SET_URL"/.test(bgJs) && /applyConnectUrl\(/.test(bgJs));
check("popup.html is not web-accessible (web pages cannot open it)", !manifest.web_accessible_resources);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
