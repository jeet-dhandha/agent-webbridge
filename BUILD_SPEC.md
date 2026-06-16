# agent-webbridge — BUILD SPEC (shared contract for parallel generation)

> **READ THIS FIRST.** You are one of several agents generating files **in parallel**. Other files you
> import **do not exist yet** — other agents are creating them right now. **Do NOT** try to run, lint,
> `node --check`, or test anything. **Do NOT** create files outside your assigned list. Match the exact
> export names, function signatures, and data shapes below so the pieces fit together. Tests run at the end,
> by the orchestrator. If a detail is unspecified, pick the simplest correct implementation that satisfies
> the signatures and shapes here.

## 0. Invariants (apply to every file)

- **Runtime:** Node v24 (daemon) / Chrome MV3 service worker (extension). ESM everywhere (`import`/`export`).
- **Daemon deps:** only `ws` (already installed). Extension: **no deps, no bundler** — plain ESM modules
  loaded by an MV3 module service worker (`"type":"module"`).
- **Style:** match the repo — small focused modules, top-of-file comment explaining the file, no TypeScript.
- **Extension id:** `ifodkkbkmngjlkhiphcjmbceeolhpfeo` (derived from our keypair; used in manifest `key`).
- **Manifest `key` (public SPKI base64, single line):**
  `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1EczzGdmplNSi1SY9K83kOKdcL5TjAPQNzXA1EVFTgnMrQEGWAJVVSQOcBMA8fusu1J7kjMaaUKqFypT2kodQrNTBJiai8pJeUq4E1kEfz86FMf0BtfVCLUj6gB22oNm1QbWN5A2PQV/wLDHsvvqR2kprA0eBemFcDxRLGW8omnr884XZyAyZoA7ABTLkKnWR8L/F3Ijwb0b1qjyL8XF94EonP/hywisuEytzlFoGCoih+quwg/TJTjmxi5ia+Lo2FpjtqFpGkdvJoToj5PCO3UkSqU1PWMJ0mFsEnYNw+X4I85S0zSPVYWGYr6JBqKJ3pPrixWy75Z7NkBQl+6vIwIDAQAB`

## 1. Two envelopes (load-bearing — get these EXACT)

### WS protocol (daemon ↔ extension), JSON text frames over `ws://127.0.0.1:<port>/ws`
- Extension→daemon on connect: `{type:"hello", payload:{extensionVersion:string, extensionId:string}}`
- Daemon→extension: `{type:"hello_ack"}`, `{type:"ping"}`
- Extension→daemon: `{type:"pong"}`
- Daemon→extension command: `{type:"tool_call", requestId:int, payload:{name:string, args:object}}`
  (daemon injects `args._session` = the session; `args._tabId`/`group_title` pass through from the caller)
- Extension→daemon result: `{type:"tool_result", responseToRequestId:int, payload:{data:<toolShape>}}`
  on success, or `{type:"tool_result", responseToRequestId:int, payload:{error:string}}` on failure.

**The extension always returns a uniform `{data}` or `{error}`.** All HTTP-envelope quirks live ONLY in the
daemon's `envelope.mjs`.

### HTTP envelope (daemon → caller), from `POST /command`
Produced by `envelope.mjs` from the tool's `{data}`/`{error}`:
- **error** → `{ok:false, error:string}` (HTTP 200).
- **`list_tabs`** → `{ok:true, success:true, tabs:[...]}` (spread `data` to top level; `data` is `{tabs:[...]}`).
- **`close_tab` / `close_session`** → `{ok:true, success:true, closed:<bool|int>}` (spread `data`).
- **`screenshot` / `save_as_pdf`** → `{ok:true, data:{format,path,sizeBytes,mimeType}}` (after disk write).
- **everything else** → `{ok:true, data:<toolShape>}`.

Rule of thumb: **always include `ok:true` on success**, AND spread the top-level quirk fields for
list_tabs/close_*. (The probe checks `json.ok`; yc_scan checks `res.success`/`res.tabs`. Both must pass.)

### Retryable error substrings (tools MUST throw Errors whose `.message` contains these where applicable)
`"Debugger is not attached"`, `"No tab with given id"`, `"already attached"`, `"fetch failed"`.

---

## 2. DAEMON files — `src/daemon/*` + `bin/agent-webbridge.mjs`

### `src/daemon/lifecycle.mjs`
```
export const START_TS = Date.now();
export function uptimeSeconds()        // floor((Date.now()-START_TS)/1000)
export function pidFilePath()          // path.join(os.homedir-or-process.env.HOME, ".agent-webbridge", "daemon.pid")
                                       // IMPORTANT: use process.env.HOME (fleet sets a per-profile HOME). Fallback os.homedir().
export function writePidFile()         // mkdir -p the dir, write String(process.pid)
export function removePidFile()        // unlink, ignore errors
export function getVersion()           // read ../../package.json version (resolve via import.meta.url); fallback "0.1.0"
```

### `src/daemon/registry.mjs`
```
export const registry = { connected:false, extensionId:null, extensionVersion:null };
export function setConnected({extensionId, extensionVersion})   // mutate registry
export function setDisconnected()                                // reset to nulls/false
export function statusFields()  // -> { extension_connected:registry.connected, extension_id:registry.extensionId||"", extension_version:registry.extensionVersion||"" }
```

### `src/daemon/diskwriter.mjs`
```
export async function writeCapture(action, data, args)
// data = { format?, data:<base64 string>, mimeType?, pageTitle?, requestedFileName?, dataLength? }
// args may include path (honored verbatim) and format/file_name.
// Behavior: decode base64; if args.path -> use it (mkdir -p parent, overwrite); else build a default path
//   under os.tmpdir(): `${pageTitle||requestedFileName||action}-${Date.now()}.${ext}` (ext from format/mimeType:
//   png|jpeg|jpg|pdf). Enforce 100MB cap for pdf (throw Error("PDF exceeds 100MB cap")).
// Returns: { format, path, sizeBytes, mimeType }
```

### `src/daemon/envelope.mjs`
```
export function shapeResponse(action, payload)
// payload = {data} | {error}. Implements §1 "HTTP envelope" exactly. Pure function. Returns the JSON object.
```

### `src/daemon/wshub.mjs`  (uses `ws` package: `import { WebSocketServer } from "ws";`)
```
export function createWsHub(httpServer)
// Attaches a WebSocketServer({ noServer:true }) and handles httpServer 'upgrade' for url path "/ws"
// (ignore other paths). Single extension slot: newest connection replaces older (terminate old).
// On socket message (JSON): 
//   hello   -> registry.setConnected(payload); socket.send(hello_ack)
//   pong    -> mark alive
//   tool_result -> resolve the pending entry keyed by responseToRequestId with payload ({data}|{error})
// On close/error -> if it's the current socket: registry.setDisconnected(); clear it.
// Ping keepalive: setInterval 20s send {type:"ping"}; if a socket misses 2 consecutive pongs -> terminate.
// Returns hub object:
//   hub.isConnected()                       // boolean (a live socket + registry.connected)
//   async hub.callTool(action, args, {session, timeoutMs=300000})
//        // if !isConnected() -> resolve { error: "fetch failed: extension not connected" }  (NOTE: resolve, not throw)
//        // else allocate monotonically increasing requestId; store {resolve,timer} in a pending Map;
//        //   send {type:"tool_call", requestId, payload:{name:action, args:{...args, _session:session}}}
//        //   on timeout -> resolve { error: "fetch failed: tool timeout" }
//        //   resolves with the extension's payload ({data}|{error}) — NEVER throws for transport errors.
//   hub.close()
```

### `src/daemon/server.mjs`
```
import { createWsHub } from "./wshub.mjs";
import { shapeResponse } from "./envelope.mjs";
import { writeCapture } from "./diskwriter.mjs";
import { registry, statusFields } from "./registry.mjs";
import { getVersion, uptimeSeconds } from "./lifecycle.mjs";

export function startServer({ host="127.0.0.1", port }) // returns { server, hub }
// http.createServer:
//   GET  /status   -> 200 JSON { running:true, port, version:getVersion(), ...statusFields(), uptime_seconds:uptimeSeconds() }
//   POST /shutdown -> 200 JSON {ok:true}; then hub.close(); server.close(); setTimeout(()=>process.exit(0),50)
//   POST /command  -> read JSON body {action,args,session};
//        const payload = await hub.callTool(action, args||{}, { session });
//        if (!payload.error && (action==="screenshot"||action==="save_as_pdf") && payload.data)
//            payload.data = await writeCapture(action, payload.data, args||{});
//        send 200 JSON shapeResponse(action, payload);
//        (wrap in try/catch -> 200 {ok:false,error:e.message})
//   else 404 {ok:false,error:"not found"}
// Create the hub with createWsHub(server) BEFORE/he listen; listen(port,host).
```

### `src/daemon/index.mjs`  (CLI entry — invoked by `bin/agent-webbridge.mjs`)
```
// Parse process.argv: subcommand = argv[2] in {start,stop,status}; flag --addr host:port.
// Default addr 127.0.0.1:10086 (used when no --addr, e.g. legacy/router idle-restore).
// start:
//   Self-background: if process.env.AWB_CHILD !== "1": spawn(process.execPath,[thisFile,...argv.slice(2)],
//     {detached:true, stdio:"ignore", env:{...process.env, AWB_CHILD:"1"}}).unref(); process.exit(0).
//   Child (AWB_CHILD==="1"): const {server}=startServer({host,port}); after 'listening' -> writePidFile();
//     handle SIGTERM/SIGINT -> removePidFile()+exit.
// stop:    POST http://addr/shutdown (best effort); also read pidFilePath() and process.kill if needed.
// status:  GET http://addr/status; print JSON to stdout; exit.
// Resolve thisFile via fileURLToPath(import.meta.url).
```

### `bin/agent-webbridge.mjs`
```
#!/usr/bin/env node
import "../src/daemon/index.mjs";
```
(Make it executable in spirit; the orchestrator will chmod. This is the binary `AWB_DAEMON_BIN` points at.)

---

## 3. EXTENSION files — `agent-webbridge-extension/*`

### `agent-webbridge-extension/manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Agent WebBridge",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "description": "Local automation bridge: lets an agent drive your real Chrome over a localhost connection.",
  "key": "<the public SPKI base64 from §0>",
  "permissions": ["debugger","tabs","tabGroups","storage","alarms"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "icons": { "16":"icon/16.png","32":"icon/32.png","48":"icon/48.png","128":"icon/128.png" },
  "default_locale": "en"
}
```

### `agent-webbridge-extension/_locales/en/messages.json`
Minimal: `{ "appName": {"message":"Agent WebBridge"}, "appDesc": {"message":"Local automation bridge."} }`
(manifest uses literal name/description, so this is just for completeness.)

### `agent-webbridge-extension/popup.html` + `popup.js`
Plain HTML + JS, no framework. On load, `popup.js` does
`chrome.runtime.sendMessage({type:"GET_STATUS"}, r=>render(r))` — **this message is what wakes the SW**
(do not remove). Show connection status + a Connect/Disconnect button (Connect →
`chrome.runtime.sendMessage({type:"CONNECT"})`, Disconnect → `{type:"DISCONNECT"}`). Filename MUST be
`popup.html` (the fleet's `wakeExtension` opens `chrome-extension://<id>/popup.html`).

### `agent-webbridge-extension/src/ws.mjs`
```
export class WSClient {
  constructor({ onToolCall })   // onToolCall: async (payload{name,args}) => ({data}|{error})
  async connect(url)            // new WebSocket(url); on open send hello {extensionVersion:chrome.runtime.getManifest().version, extensionId:chrome.runtime.id}
  send(obj)                     // JSON.stringify over the socket if open
  isConnected()
  disconnect()
  async reconnectIfNeeded()     // read storage.local "local_url" (value is JSON.stringify(wsUrl)); if set and not connected -> connect(url)
  // onmessage: ping->send pong; hello_ack->noop; tool_call->
  //   const payload = await onToolCall(msg.payload); send {type:"tool_result", responseToRequestId:msg.requestId, payload};
  // onclose/onerror: scheduleReconnect (setTimeout 5s -> reconnectIfNeeded)
}
```
Note: `local_url` is written by the fleet's `setLocalUrl` as `JSON.stringify(wsUrl)` — parse it.

### `agent-webbridge-extension/src/dbg.mjs`  (per-tab debugger attach Map — THE parallelism core)
```
const attached = new Map();   // tabId -> true
export function initDebugger()         // register chrome.debugger.onDetach + chrome.tabs.onRemoved to prune the map
export async function attach(tabId)    // if attached.has(tabId) return; chrome.debugger.attach({tabId},"1.3"); attached.set; 
                                       //   if attach throws containing "Another debugger"/"already attached", treat as attached (set map, return)
export async function detach(tabId)    // best-effort chrome.debugger.detach({tabId}); attached.delete
export function isAttached(tabId)
export async function send(tabId, method, params={})  // await attach(tabId) first; return chrome.debugger.sendCommand({tabId}, method, params)
                                       //   normalize errors: if message includes "not attached" -> throw Error("Debugger is not attached ("+tabId+")")
                                       //   if includes "No tab with given id" -> rethrow as-is (keep substring)
```
Every CDP call is keyed by an explicit `tabId`, so different tabs run concurrently — this IS the parallelism.

### `agent-webbridge-extension/src/dom.mjs`  (selector → CDP node resolution; used by click/fill/screenshot/upload)
```
import * as refs from "./snapshot-refs.mjs";
import { send } from "./dbg.mjs";
export async function resolveSelector(tabId, selector)
// if selector starts with "@e": const {backendDOMNodeId}=refs.resolveRef(tabId,selector);
//      const {object}=await send(tabId,"DOM.resolveNode",{backendNodeId:backendDOMNodeId}); return {objectId:object.objectId, backendNodeId:backendDOMNodeId};
// else (CSS): await send(tabId,"DOM.getDocument",{}); const {nodeId}=await send(tabId,"DOM.querySelector",{nodeId:doc.root.nodeId,selector});
//      if !nodeId throw Error("No node found for selector "+selector); resolveNode -> {objectId}; return {objectId, nodeId};
// (cache DOM.getDocument root per call; fine to fetch each time)
```

### `agent-webbridge-extension/src/snapshot-refs.mjs`  (the `@e` ref scheme — per tab)
```
const refsByTab = new Map();   // tabId -> { seq:0, byRef:Map<"@eN",{backendDOMNodeId,role,name}> }
export function resetRefs(tabId)                       // refsByTab.set(tabId,{seq:0,byRef:new Map()})
export function mintRef(tabId, {backendDOMNodeId, role, name})  // -> "@e"+(++entry.seq); store; return ref
export function resolveRef(tabId, ref)                 // -> entry or throw Error("unknown ref "+ref+" — run snapshot first")
export function pruneTab(tabId)                        // refsByTab.delete(tabId)  (call from dbg onRemoved if desired)
```

### `agent-webbridge-extension/src/groups.mjs`  (session → tab group)
```
const groupBySession = new Map();   // session -> groupId
export async function assignToSession(tabId, session, groupTitle)
// if !session return; find/create the tab group: chrome.tabs.group({tabIds:[tabId], groupId?}); 
//   chrome.tabGroups.update(groupId,{title:groupTitle||("agent:"+session), color: a stable color}); cache groupId. Return groupId.
export async function tabIdsInSession(session)   // query tabs whose groupId === groupBySession.get(session); return tabIds[]
export async function closeSession(session)      // remove all those tabs; return count (closed:int)
export async function groupTitleForTab(tabId)    // best-effort tabGroups.get(tab.groupId).title or ""
```

### `agent-webbridge-extension/background.js`  (dispatcher + entry — imports everything above + tools)
```
import { WSClient } from "./src/ws.mjs";
import { initDebugger, attach } from "./src/dbg.mjs";
import { startKeepalive, beginHeartbeat, endHeartbeat } from "./src/keepalive.mjs";
import navigate from "./src/tools/navigate.mjs";  // ...and all 13 tool modules
// const TOOLS = { navigate, find_tab, evaluate, snapshot, click, fill, network, upload, screenshot, save_as_pdf, list_tabs, close_tab, close_session };

let currentTab = null;                 // last navigated/selected tabId
const queues = new Map();              // queueKey -> tail Promise (per-tab serialization)

async function dispatch(payload) {     // payload = { name, args }   ; returns {data}|{error}
  const { name, args = {} } = payload;
  const tool = TOOLS[name];
  if (!tool) return { error: "unknown tool: " + name };
  // target tab + queue key:
  //   args._tabId present            -> tabId=args._tabId,  key="tab:"+tabId
  //   name==="navigate" && args.newTab-> tabId=null,         key=null  (fully concurrent — new tab)
  //   name in {list_tabs,close_session}-> tabId=null,        key="meta"
  //   else                            -> tabId=currentTab,   key="current"
  // ctx = { tabId, session:args._session, get currentTab(){...}, setCurrentTab(id){currentTab=id}, attach, chrome }
  // run with per-key serialization: chain on queues.get(key); beginHeartbeat()/endHeartbeat() around the run.
  // success -> { data: <tool return> } ; catch e -> { error: e.message }
}

function main(){ initDebugger(); const ws = new WSClient({ onToolCall: dispatch });
  startKeepalive(()=>ws.reconnectIfNeeded());
  chrome.runtime.onMessage.addListener((m,_s,reply)=>{ /* GET_STATUS->reply({connected:ws.isConnected()}); CONNECT->ws.reconnectIfNeeded(); DISCONNECT->ws.disconnect(); return true */ });
  ws.reconnectIfNeeded();
}
main();
```
**ctx object passed to every tool** (define it in dispatch and document here so tool agents rely on it):
```
ctx = {
  tabId,                 // number|null — the resolved target tab
  session,               // string|undefined
  setCurrentTab(id),     // update the dispatcher's currentTab
  attach,                // async attach(tabId) from dbg.mjs
  chrome,                // the global chrome (tools may use chrome.tabs.* etc.)
}
```

### `agent-webbridge-extension/src/keepalive.mjs`
```
export function startKeepalive(reconnectFn)  // chrome.alarms.create("awb-reconnect",{periodInMinutes:1}); onAlarm->reconnectFn()
let inflight=0, hb=null;
export function beginHeartbeat()  // inflight++; if !hb hb=setInterval(()=>chrome.runtime.getPlatformInfo(()=>{}),20000)
export function endHeartbeat()    // inflight--; if inflight<=0 { clearInterval(hb); hb=null }
```

---

## 4. TOOL modules — `agent-webbridge-extension/src/tools/<name>.mjs`

Each: `export default async function run(ctx, args)` → returns the **data object** below (or throws Error).
Use `import { send } from "../dbg.mjs";` for CDP and `import * as refs from "../snapshot-refs.mjs";`,
`import { resolveSelector } from "../dom.mjs";`, `import * as groups from "../groups.mjs";` as needed.
`ctx.tabId` is the target tab; for new-tab navigation create the tab then `ctx.setCurrentTab(id)`.

| tool | args | CDP / chrome calls | returns (the `data`) |
|------|------|--------------------|----------------------|
| `navigate` | `{url, newTab?, group_title?, _tabId?}` | newTab→`chrome.tabs.create({url})`; else `chrome.tabs.update(ctx.tabId,{url})` (or `Page.navigate`); wait `chrome.tabs.onUpdated` status `complete`; `attach(id)`; `groups.assignToSession`; `ctx.setCurrentTab(id)` | `{success:true, url, tabId}` |
| `find_tab` | `{url, active?}` | `chrome.tabs.query({url})` (filter active/lastFocused if `active`); pick first; `attach`; `ctx.setCurrentTab` | `{success:true, url, tabId}` |
| `evaluate` | `{code, _tabId?}` | `send(tabId,"Runtime.evaluate",{expression:code,returnByValue:true,awaitPromise:true,userGesture:true})`; on `exceptionDetails` throw its text | `{type:result.type, value:result.value}` |
| `snapshot` | `{}` | `send(tabId,"Accessibility.getFullAXTree",{})`; `refs.resetRefs(tabId)`; walk nodes, for interactive roles with `backendDOMNodeId` `refs.mintRef`; url/title via `Runtime.evaluate` | `{url, title, tree}` (tree: nested text or JSON of nodes w/ `ref:"@eN"`) |
| `click` | `{selector}` | `resolveSelector`; `send("Runtime.callFunctionOn",{objectId, functionDeclaration:"function(){this.scrollIntoView({block:'center'});this.click();}"})` | `{success:true, tag, text}` |
| `fill` | `{selector, value}` | `resolveSelector`; `Runtime.callFunctionOn` with the fill helper (native setter+events for input/textarea; `execCommand('insertText')` for `[contenteditable]`) | `{success:true, tag, mode:"value"\|"contenteditable"}` |
| `network` | `{cmd:"start"\|"stop"\|"list"\|"detail", filter?, requestId?}` | `Network.enable`+capture map per tab (requestWillBeSent/responseReceived/loadingFinished); detail→`Network.getResponseBody` | start:`{success:true}`; list:`{requests:[...]}`; detail:`{request,response,body}`; stop:`{success:true,count}` |
| `upload` | `{selector, files:string[]}` | `DOM.getDocument`+`DOM.querySelector`→nodeId; `DOM.setFileInputFiles({files,nodeId})` | `{success:true, fileCount, files}` |
| `screenshot` | `{format?="png", quality?, selector?, path?}` | optional `DOM.getBoxModel` clip; `Page.captureScreenshot({format,quality,clip?})` | `{format, data:<base64>, dataLength}` (daemon writes the file) |
| `save_as_pdf` | `{paper_format?, landscape?, scale?, print_background?, path?}` | `Page.printToPDF({...})` | `{data:<base64>, mimeType:"application/pdf", dataLength, pageTitle, requestedFileName}` |
| `list_tabs` | `{all?}` | `chrome.tabs.query({})` (+`groups.groupTitleForTab`) | `{success:true, tabs:[{tabId,url,title,active,groupTitle}]}` |
| `close_tab` | `{_tabId}` | `chrome.tabs.remove(ctx.tabId)` | `{success:true, closed:true}` |
| `close_session` | `{}` | `groups.closeSession(ctx.session)` | `{success:true, closed:<int>}` |

Notes for tool agents:
- Interactive AX roles for snapshot refs (mint a ref for these): `button, link, textbox, searchbox, combobox,
  checkbox, radio, switch, menuitem, menuitemcheckbox, menuitemradio, tab, option, slider, spinbutton,
  treeitem, listbox`. Skip nodes without `backendDOMNodeId`.
- Throw Errors whose messages include the §1 retryable substrings when the underlying CDP/Chrome error is
  about a missing/unattached tab.
- `screenshot.data`/`save_as_pdf.data` are base64 — **do not** write files in the extension; the daemon does.

---

## 5. File ownership (the orchestrator assigns each cluster to one agent)

- **D-core:** `src/daemon/lifecycle.mjs`, `src/daemon/registry.mjs`
- **D-pure:** `src/daemon/envelope.mjs`, `src/daemon/diskwriter.mjs`
- **D-ws:** `src/daemon/wshub.mjs`
- **D-http:** `src/daemon/server.mjs`, `src/daemon/index.mjs`, `bin/agent-webbridge.mjs`
- **X-transport:** `agent-webbridge-extension/src/ws.mjs`, `src/keepalive.mjs`
- **X-cdp:** `agent-webbridge-extension/src/dbg.mjs`, `src/dom.mjs`
- **X-state:** `agent-webbridge-extension/src/snapshot-refs.mjs`, `src/groups.mjs`
- **X-dispatch:** `agent-webbridge-extension/background.js`
- **T-nav:** `tools/navigate.mjs`, `find_tab.mjs`, `list_tabs.mjs`, `close_tab.mjs`, `close_session.mjs`
- **T-interact:** `tools/evaluate.mjs`, `click.mjs`, `fill.mjs`, `upload.mjs`
- **T-read:** `tools/snapshot.mjs`, `network.mjs`
- **T-capture:** `tools/screenshot.mjs`, `save_as_pdf.mjs`
- **X-meta:** `manifest.json`, `popup.html`, `popup.js`, `_locales/en/messages.json`

(Integration edits to existing `src/profiles.mjs`, `package.json`, `src/fleet.mjs`, and the `test/contract.mjs`
harness are done by the orchestrator AFTER generation — not by these agents.)
