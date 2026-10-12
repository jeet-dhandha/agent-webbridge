#!/usr/bin/env node
// chat-fleet.mjs — ask the same question(s) to many chat UIs at once, through your REAL logged-in
// Chrome, via agent-webbridge. Zero deps (Node >= 18). No API keys: it types into the web UIs.
//
//   node chat-fleet.mjs --login                          # open every site so you can sign in once
//   node chat-fleet.mjs --probe                          # per site: prompt box found? logged in?
//   node chat-fleet.mjs --add perplexity https://www.perplexity.ai/   # support one more site (saved locally)
//   node chat-fleet.mjs --list                           # sites this machine knows about
//   node chat-fleet.mjs -p "Explain CRDTs in 3 lines"    # ask all sites, write answers.jsonl
//   node chat-fleet.mjs --sites chatgpt,claude,gemini -f prompts.txt --profile Work
//
// Flags: --profile <name|email|dir>  --sites a,b,c  -p/--prompt "<text>" | -f/--file <one prompt per line>
//        --out answers.jsonl  --timeout 150 (s)  --fresh (new chat per prompt)  --keep (leave tabs open)
// Re-running skips (site, prompt) pairs already in --out, so an interrupted run resumes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROUTER = process.env.AWB_ROUTER || 'http://127.0.0.1:10086';

// ---- Site registry -------------------------------------------------------------------------
// Just a URL per site. The script finds the prompt box, send button and answer by looking at the
// page's structure, so a redesign does not need a code edit. Everything below is an optional HINT
// tried first and silently replaced by auto-discovery when it stops matching:
//   composer / send / answer : CSS hints (answer = the assistant's message bubble)       dismiss : text of a cookie/promo button to click
//   fg              : true = this site only renders streamed text in a visible tab, so it runs
//                     one-at-a-time in the foreground (after the parallel background batch)
export const SITES = {
  chatgpt:  { url: 'https://chatgpt.com/', send: 'button[data-testid="send-button"]' },
  claude:   { url: 'https://claude.ai/new', send: 'button[aria-label="Send message"]' },
  gemini:   { url: 'https://gemini.google.com/app', send: 'button[aria-label="Send message"]' },
  qwen:     { url: 'https://chat.qwen.ai/', answer: '.chat-response-message-right' },
  zai:      { url: 'https://chat.z.ai/',            fg: true },
  minimax:  { url: 'https://agent.minimax.io/',     dismiss: 'Try It Now|Got it|Close' },
  deepseek: { url: 'https://chat.deepseek.com/',    fg: true },
  duck:     { url: 'https://duck.ai/' },
  kimi:     { url: 'https://www.kimi.com/',         fg: true },
  grok:     { url: 'https://grok.com/',             fg: true, dismiss: 'Accept All Cookies' },
  arena:    { url: 'https://arena.ai/text/direct' },
  mistral:  { url: 'https://chat.mistral.ai/chat' },
  // add any chat UI: name: { url }  — nothing else is required
};

// ---- Your own sites (local file, never uploaded) -------------------------------------------
// `--add name url` writes here; it is merged over the built-ins at startup, so your workflow
// keeps working and growing without ever editing this script.
const SITES_FILE = process.env.AWB_CHAT_SITES || path.join(os.homedir(), '.awb', 'chat-sites.json');
const loadLocal = () => { try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); } catch { return {}; } };
Object.assign(SITES, loadLocal());

// ---- CLI -----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d, short) => { const i = argv.findIndex(a => a === `--${n}` || (short && a === `-${short}`)); return i < 0 ? d : (argv[i + 1]?.startsWith('-') || argv[i + 1] === undefined ? true : argv[i + 1]); };
const PROFILE = flag('profile', 'Default');
const SESSION = 'awb-chat';
const GROUP = 'awb-chat';
const OUT = flag('out', 'answers.jsonl');
const TIMEOUT_MS = Number(flag('timeout', 150)) * 1000;
const FRESH = !!flag('fresh', false);
const KEEP = !!flag('keep', false);
const FOREGROUND = !!flag('foreground', false); // for sites that don't render streamed text in a background tab (run those one at a time)
const names = (flag('sites', '') || Object.keys(SITES).join(',')).split(',').filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));

// ---- AWB transport (plain fetch, no client lib needed) ------------------------------------
async function cmd(action, args = {}, { tabId, timeout = 60000 } = {}) {
  const body = { action, args: tabId ? { ...args, _tabId: tabId } : args, session: SESSION, profile: PROFILE };
  const res = await fetch(`${ROUTER}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const j = await res.json();
  if (j.ok === false || j.success === false) throw new Error(`${action}: ${j.error || JSON.stringify(j).slice(0, 160)}`);
  return j.data ?? j;
}
// evaluate a function with JSON args inside the page; failures come back as data, never throw.
async function page(tabId, fn, arg = {}) {
  const code = `(async()=>{try{return await (${fn.toString()})(${JSON.stringify(arg)})}catch(e){return {__err:String(e&&e.message||e)}}})()`;
  const r = await cmd('evaluate', { code }, { tabId });
  const v = r?.value !== undefined ? r.value : r;
  if (v && v.__err) throw new Error(v.__err);
  return v;
}

// ---- In-page helpers (each runs inside the chat tab) --------------------------------------
const inPage = {
  // Wait for a prompt box, tag it data-awb-composer. Hint first; else the lowest, widest visible
  // textarea / contenteditable / role=textbox that is not a search box or inside nav/aside.
  ready: async ({ composer, dismiss }) => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 12 && getComputedStyle(e).visibility !== 'hidden'; };
    const pick = () => {
      document.querySelectorAll('[data-awb-composer]').forEach(e => e.removeAttribute('data-awb-composer'));
      let c = composer ? [...document.querySelectorAll(composer)].find(vis) : null, how = 'hint';
      if (!c) {
        how = 'auto';
        const cands = [...document.querySelectorAll('textarea,[contenteditable]:not([contenteditable=false]),[role=textbox],input[type=text]')]
          .filter(e => vis(e) && !e.closest('nav,aside,header,[role=navigation]') && !/search|find/i.test([e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.type].join(' ')));
        cands.sort((x, y) => { const a = x.getBoundingClientRect(), b = y.getBoundingClientRect(); return (b.bottom + b.width) - (a.bottom + a.width); });
        c = cands[0];
      }
      if (c) { c.setAttribute('data-awb-composer', '1'); return how; }
      return null;
    };
    for (let i = 0; i < 40; i++) {
      if (dismiss) for (const b of document.querySelectorAll('button,[role=button]')) if (vis(b) && new RegExp(`^(${dismiss})$`, 'i').test((b.innerText || '').trim())) b.click();
      const how = pick();
      if (how) return { ok: true, how, url: location.href };
      await new Promise(r => setTimeout(r, 500));
    }
    const t = document.body.innerText.toLowerCase();
    return { ok: false, why: /log in|sign in|sign up|continue with/.test(t) ? 'not-logged-in' : 'no-composer', url: location.href };
  },
  // Tag the send button data-awb-send: hint first, else the nearest enabled "send/submit/ask" control above the composer.
  findSend: ({ send }) => {
    document.querySelectorAll('[data-awb-send]').forEach(e => e.removeAttribute('data-awb-send'));
    const vis = e => { const r = e.getBoundingClientRect(); return r.width >= 16 && r.height >= 16; };
    const ok = e => e && vis(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
    const ae = document.activeElement, c = document.querySelector('[data-awb-composer]') || (ae && ae.matches('textarea,[contenteditable],[role=textbox]') ? ae : null);
    let b = send ? [...document.querySelectorAll(send)].find(ok) : null, how = 'hint';
    if (!b && c) {
      how = 'auto';
      for (let n = c.parentElement, i = 0; n && i < 8 && !b; n = n.parentElement, i++) {
        const cands = [...n.querySelectorAll('button,[role=button],div[aria-label],div[data-testid]')].filter(e => {
          const s = [e.getAttribute('aria-label'), e.getAttribute('data-testid'), e.id, e.getAttribute('type'), e.innerText].join(' ');
          return ok(e) && e !== c && !e.contains(c) && !c.contains(e) && /send|submit|ask|发送/i.test(s) && !/stop|voice|dictat|attach|search chats|upload/i.test(s);
        });
        if (cands.length) b = cands[cands.length - 1];
      }
    }
    if (!b) return { found: false };
    b.setAttribute('data-awb-send', '1');
    return { found: true, how, label: b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.id || b.tagName };
  },
  // Did the prompt leave the box? (true = still sitting in the composer, i.e. the click did nothing)
  stuck: ({ prompt }) => {
    const ae = document.activeElement, c = document.querySelector('[data-awb-composer]') || (ae && ae.matches('textarea,[contenteditable],[role=textbox]') ? ae : null);
    return !!c && (c.value || c.innerText || '').trim().startsWith(prompt.trim().slice(0, 20));
  },
  // Last-resort send: Enter on the composer (works where the site's handler ignores isTrusted).
  pressEnter: () => {
    const ae = document.activeElement, c = document.querySelector('[data-awb-composer]') || (ae && ae.matches('textarea,[contenteditable],[role=textbox]') ? ae : null); if (!c) return false;
    c.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) c.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  },
  // Read the answer structurally: new text blocks that come AFTER your prompt in the page, ignoring
  // buttons, nav/sidebar, forms and the composer. No per-site selector needed.
  snap: ({ prompt, answer }) => {
    const txt = e => (e.innerText || e.textContent || '').trim();
    const stop = [...document.querySelectorAll('button,[role=button]')].some(b => {
      const r = b.getBoundingClientRect(); if (r.width < 12) return false;
      const s = [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.innerText].join(' ');
      return /^\s*(stop|stop generating|stop streaming|stop response|停止)\b/i.test(s) || /stop-button|stop-generating/i.test(s);
    });
    const words = prompt.trim().split(/\s+/).slice(-8);
    const tailRe = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    // the echo of your prompt: the deepest element whose text contains the prompt tail, last in the page
    let echo = null;
    for (const e of document.querySelectorAll('body *')) {
      if (e.closest('textarea,[contenteditable],[role=textbox],nav,aside')) continue;
      if (tailRe.test(e.innerText || '') && ![...e.children].some(ch => tailRe.test(ch.innerText || ''))) echo = e;
    }
    const byText = () => { // fallback: page text after the last occurrence of the prompt tail
      let m, end = -1; const re = new RegExp(tailRe.source, 'g'), body = document.body.innerText;
      while ((m = re.exec(body))) end = m.index + m[0].length;
      return end >= 0 ? body.slice(end).trim() : '';
    };
    // a hint selector wins when it matches (after your prompt if we found it, anywhere otherwise)
    if (answer) {
      const els = [...document.querySelectorAll(answer)].filter(e => !echo || (echo.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
      const t = els.length ? txt(els[els.length - 1]) : '';
      if (t) return { text: t, stop, echo: !!echo };
    }
    if (!echo) return { text: byText(), stop, echo: false };
    const UI = /^(edit|copy|retry|share|regenerate|like|dislike|good response|bad response|more|read aloud|try again|new chat|upgrade|just now|today)$/i;
    const seen = new Set(), out = [];
    for (const e of document.querySelectorAll('p,li,pre,h1,h2,h3,h4,h5,h6,blockquote,td,div,span')) {
      if (!(echo.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) || echo.contains(e)) continue;
      if (e.closest('button,[role=button],textarea,[contenteditable],[role=textbox],nav,aside,[role=navigation],[aria-hidden=true]')) continue;
      if ([...e.children].some(ch => /^(P|LI|PRE|H\d|BLOCKQUOTE|TD|DIV)$/.test(ch.tagName) && txt(ch))) continue; // leaf blocks only
      const t = txt(e); if (!t || seen.has(t) || UI.test(t)) continue; seen.add(t); out.push(t);
    }
    return { text: out.join('\n') || byText(), stop, echo: true };
  },
  // For --probe: what does this tab look like right now?
  state: () => {
    const t = document.body.innerText.toLowerCase();
    return { url: location.href, loginWords: /log in|sign in|sign up/.test(t) };
  },
};

// ---- Ledger (resumable) --------------------------------------------------------------------
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { try { const r = JSON.parse(l); if (r.ok) done.add(`${r.site}\t${r.prompt}`); } catch {} }
const append = r => fs.appendFileSync(OUT, JSON.stringify(r) + '\n');

async function openTab(name) {
  const s = SITES[name];
  const nav = await cmd('navigate', { url: s.url, newTab: true, active: FOREGROUND || !!s.fg, group_title: GROUP });
  return nav.tabId ?? nav.tab?.id;
}

// Poll until the answer stops changing (and no stop button shows), then return it.
async function collect(tabId, arg, stableMs = 3500) {
  const t0 = Date.now(); let last = '', since = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(1500);
    const { text, stop } = await page(tabId, inPage.snap, arg);
    if (text !== last) { last = text; since = Date.now(); continue; }
    if (text && !stop && !/^(thinking\.*|thought process|searching.*|generating.*)$/i.test(text.trim()) && Date.now() - since >= stableMs) return { text: tidy(text), ms: Date.now() - t0 };
  }
  return { text: tidy(last), ms: Date.now() - t0, partial: true };
}
// Drop screen-reader labels some UIs put in front of the answer ("Claude responded:", "Duck.ai said", "Thinking completed").
const NOISE = /(can make mistakes|ai-generated|double-check|check important info|response complete|latest response|^copy$|^regenerate|^share$|^rate response$|^read aloud$|^more actions$|^edit message$)/i;
const tidy = t => { let l = t.split('\n'); const cut = l.findIndex((x, i) => i > 0 && NOISE.test(x.trim())); if (cut > 0) l = l.slice(0, cut); while (l.length > 1 && /^\s*(.{0,40}\b(said|responded):?|flash|fast|deepthink|search|thinking completed|thought for .*|thinking\.*)\s*$/i.test(l[0])) l.shift(); return l.join('\n').trim(); };

// Submit the typed prompt and PROVE it left the box. Escalates until it does:
//   1) plain click on the send button  2) real mouse click via CDP (isTrusted; needs the tab on
//   screen, so only one tab at a time)  3) Enter key in the box.   Returns how it worked, or null.
let screenLock = Promise.resolve();
const oneAtATime = fn => { const r = screenLock.then(fn, fn); screenLock = r.catch(() => {}); return r; };
async function submit(tabId, s, prompt) {
  const stuck = () => page(tabId, inPage.stuck, { prompt });
  let snd = await page(tabId, inPage.findSend, s);
  if (snd.found) { await cmd('click', { selector: '[data-awb-send="1"]' }, { tabId }).catch(() => {}); await sleep(1500); if (!(await stuck())) return 'click'; }
  snd = await page(tabId, inPage.findSend, s);
  if (snd.found) {
    try { await oneAtATime(async () => { await cmd('trusted_click', { selector: '[data-awb-send="1"]' }, { tabId }); await sleep(1500); }); if (!(await stuck())) return 'trusted-click'; } catch {}
  }
  await page(tabId, inPage.pressEnter); await sleep(1500);
  return (await stuck()) ? null : 'enter';
}

// ---- One site, all prompts, in its own tab -------------------------------------------------
async function runSite(name, prompts) {
  const s = SITES[name];
  const todo = prompts.filter(p => !done.has(`${name}\t${p}`));
  if (!todo.length) return;
  let tabId;
  try {
    tabId = await openTab(name);
    for (const [k, prompt] of todo.entries()) {
      if (k > 0 && FRESH) await cmd('navigate', { url: s.url }, { tabId });
      const rdy = await page(tabId, inPage.ready, s);
      if (!rdy.ok) { append({ site: name, prompt, ok: false, error: rdy.why, url: rdy.url }); console.log(`✗ ${name.padEnd(9)} ${rdy.why === 'not-logged-in' ? 'sign in once with --login, then re-run' : 'no prompt box found — run --probe ' + name}`); break; }
      if (s.composer && rdy.how === 'auto') console.log(`ℹ ${name}: its page layout changed — adapted automatically (no action needed)`);
      await cmd('fill', { selector: '[data-awb-composer="1"]', value: prompt }, { tabId });
      await jitter(400, 900);
      const how = await submit(tabId, s, prompt);
      if (!how) { append({ site: name, prompt, ok: false, error: 'could-not-send' }); console.log(`✗ ${name.padEnd(9)} could not submit the prompt — run --probe ${name}`); continue; }
      const out = await collect(tabId, { ...s, prompt });
      const walled = /sign up to continue|log in to continue|sign in to continue|create a free account/i.test(out.text);
      const rec = { site: name, prompt, ok: !!out.text && !out.partial && !walled, error: walled ? 'not-logged-in' : undefined, answer: out.text, ms: out.ms, partial: !!out.partial, ts: new Date().toISOString() };
      append(rec);
      console.log(`${rec.ok ? '✓' : '✗'} ${name.padEnd(9)} ${String(out.ms).padStart(6)}ms  ${out.text.replace(/\s+/g, ' ').slice(0, 90)}`);
      await jitter(1500, 3500); // be a polite human-speed client
    }
  } catch (e) {
    append({ site: name, prompt: prompts[0], ok: false, error: String(e.message).slice(0, 200) });
    console.log(`✗ ${name.padEnd(9)} ${e.message.slice(0, 110)}`);
  } finally {
    if (tabId && !KEEP) await cmd('close_tab', {}, { tabId }).catch(() => {});
  }
}

// ---- Modes ---------------------------------------------------------------------------------
async function login() {
  console.log(`Opening ${names.length} sites in profile "${PROFILE}". Sign in to each one once (your own account), then close nothing — just re-run without --login.`);
  for (const n of names) { await cmd('navigate', { url: SITES[n].url, newTab: true, active: true, group_title: GROUP }); await sleep(500); }
}
async function probe() {
  await Promise.all(names.map(async n => {
    let tabId;
    try {
      tabId = await openTab(n); await sleep(6000);
      const rdy = await page(tabId, inPage.ready, SITES[n]);
      const st = await page(tabId, inPage.state);
      console.log(`${rdy.ok ? '✓' : '✗'} ${n.padEnd(9)} ${rdy.ok ? `prompt box found (${rdy.how})` : rdy.why}${st.loginWords && rdy.ok ? '  — login/sign-up text on page, are you signed in?' : ''}  ${st.url.slice(0, 60)}`);
    } catch (e) { console.log(`✗ ${n.padEnd(9)} ${e.message.slice(0, 100)}`); }
    finally { if (tabId) await cmd('close_tab', {}, { tabId }).catch(() => {}); }
  }));
}

const addIdx = argv.indexOf('--add');
if (addIdx >= 0) {
  const [name, url] = [argv[addIdx + 1], argv[addIdx + 2]];
  if (!name || !/^https?:\/\//.test(url || '')) { console.error('usage: --add <name> <https://chat-site/> [--fg]'); process.exit(2); }
  const cur = loadLocal(); cur[name] = { url, ...(argv.includes('--fg') ? { fg: true } : {}) };
  fs.mkdirSync(path.dirname(SITES_FILE), { recursive: true }); fs.writeFileSync(SITES_FILE, JSON.stringify(cur, null, 2) + '\n');
  console.log(`✓ added "${name}" → ${url}  (saved in ${SITES_FILE}; try: --probe --sites ${name})`);
  process.exit(0);
}
if (flag('list', false)) { for (const [n, s] of Object.entries(SITES)) console.log(`${n.padEnd(10)} ${s.url}${s.fg ? '  (foreground)' : ''}`); process.exit(0); }

const bad = names.filter(n => !SITES[n]);
if (bad.length) { console.error(`unknown site(s): ${bad.join(', ')}. known: ${Object.keys(SITES).join(', ')}`); process.exit(2); }
if (flag('login', false)) await login();
else if (flag('probe', false)) await probe();
else {
  const p = flag('prompt', null, 'p'), f = flag('file', null, 'f');
  const prompts = typeof f === 'string' ? fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : typeof p === 'string' ? [p] : [];
  if (!prompts.length) { console.error('give -p "<prompt>" or -f prompts.txt (or --login / --probe)'); process.exit(2); }
  const bg = names.filter(n => !SITES[n].fg && !FOREGROUND), fg = names.filter(n => !bg.includes(n));
  await Promise.all(bg.map(n => runSite(n, prompts)));   // parallel: one background tab per site
  for (const n of fg) await runSite(n, prompts);          // sequential: needs the tab on screen
  const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`\n${rows.filter(r => r.ok).length} answers saved to ${OUT}`);
}
