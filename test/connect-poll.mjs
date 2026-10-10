// connect-poll.mjs — waitForStoredUrl: the stored-URL poll that lets connectViaPopup give up early on
// extension builds that predate zero-restart connect. Fake clock and fake sleep: no timers, no browser.
import { waitForStoredUrl, eitherSignalUrl, STORED_URL_WINDOW_MS, STORED_URL_POLL_MS } from "../src/connect-poll.mjs";

let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); ok ? pass++ : fail++; };

const WANT = "ws://127.0.0.1:13222/ws";

// Fake clock: sleep() advances time and records each sleep, so window overshoot is observable.
function fakeClock() {
  const c = { t: 0, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}
// readUrl that yields the scripted values in order (the last one repeats). Entries that are Error
// instances are thrown instead of returned. Counts reads.
function scripted(values) {
  const r = { reads: 0 };
  r.fn = async () => {
    const v = values[Math.min(r.reads, values.length - 1)];
    r.reads++;
    if (v instanceof Error) throw v;
    return v;
  };
  return r;
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// --- constants: the window and interval are named, with the agreed values
check("window constant is 6 s", STORED_URL_WINDOW_MS === 6000);
check("poll interval constant is ~250 ms", STORED_URL_POLL_MS === 250);

// --- returns true as soon as the URL matches
{
  const c = fakeClock(); const r = scripted([WANT]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now });
  check("match on the first read: true", ok === true);
  check("match on the first read: no sleep, one read", r.reads === 1 && c.slept.length === 0);
}

// --- returns true if it matches on a later poll
{
  const c = fakeClock(); const r = scripted([null, "ws://127.0.0.1:10086/ws", WANT]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now });
  check("match on a later poll: true", ok === true);
  check("match on a later poll: stopped reading at the match", r.reads === 3);
  check("match on a later poll: slept one interval between reads", c.slept.length === 2 && c.slept.every((ms) => ms === STORED_URL_POLL_MS));
}

// --- returns false after the window when it never matches
{
  const c = fakeClock(); const r = scripted(["ws://127.0.0.1:10086/ws"]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now });
  check("never matches: false", ok === false);
  check("never matches: waits the full window (6000 ms)", sum(c.slept) === STORED_URL_WINDOW_MS);
  check("never matches: reads at 0, 250, ..., 6000 (25 reads)", r.reads === 25);
}

// --- a match that only lands after the window is not seen
{
  const c = fakeClock(); const values = Array(40).fill(null); values.push(WANT);
  const r = scripted(values);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now });
  check("late match (after the window): false", ok === false && sum(c.slept) <= STORED_URL_WINDOW_MS);
}

// --- tolerates null / undefined / other values
{
  const c = fakeClock(); const r = scripted([null, undefined, null, WANT]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now });
  check("null and undefined reads are treated as not yet: true on the later match", ok === true);
}
{
  const c = fakeClock(); const r = scripted([null, undefined]);
  let threw = false, ok;
  try { ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now }); } catch { threw = true; }
  check("only null/undefined reads: false, no throw", !threw && ok === false);
}

// --- tolerates readUrl throwing
{
  const c = fakeClock(); const r = scripted([new Error("EACCES"), new Error("ENOENT"), WANT]);
  let threw = false, ok;
  try { ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now }); } catch { threw = true; }
  check("throwing reads are tolerated: true on the later match", !threw && ok === true);
}
{
  const c = fakeClock(); const r = scripted([new Error("boom")]);
  let threw = false, ok;
  try { ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now }); } catch { threw = true; }
  check("always throwing: false after the window, no throw", !threw && ok === false && sum(c.slept) === STORED_URL_WINDOW_MS);
}

// --- a synchronous readUrl (readLocalUrl is sync) works too
{
  const c = fakeClock();
  const ok = await waitForStoredUrl({ readUrl: () => WANT, expected: WANT, sleep: c.sleep, now: c.now });
  check("synchronous readUrl: true", ok === true);
}

// --- exact match only: a different ws URL (e.g. the stock :10086 one) does not count
{
  const c = fakeClock(); const r = scripted([WANT + "?x=1", "ws://127.0.0.1:13222/ws/"]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now, windowMs: 500, intervalMs: 250 });
  check("near-miss URLs do not match: false", ok === false);
}

// --- does not sleep past the window (window not a multiple of the interval)
{
  const c = fakeClock(); const r = scripted([null]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now, windowMs: 1000, intervalMs: 300 });
  check("window 1000 / interval 300: false", ok === false);
  check("window 1000 / interval 300: sleeps 300,300,300,100 and stops at the window", JSON.stringify(c.slept) === "[300,300,300,100]" && c.t === 1000);
}
{
  // Zero window: one read, no sleep at all.
  const c = fakeClock(); const r = scripted([null]);
  const ok = await waitForStoredUrl({ readUrl: r.fn, expected: WANT, sleep: c.sleep, now: c.now, windowMs: 0 });
  check("zero window: one read, no sleep, false", ok === false && r.reads === 1 && c.slept.length === 0);
}

// --- eitherSignalUrl: the daemon seeing the extension connect counts even if the stored-URL read misses
{
  const E = "ws://127.0.0.1:13222/ws";
  const a = await eitherSignalUrl({ readStored: () => null, isConnected: async () => true, expected: E })();
  check("either-signal: daemon connected wins when the stored read misses (LevelDB flush)", a === E);
  const b = await eitherSignalUrl({ readStored: () => E, isConnected: async () => false, expected: E })();
  check("either-signal: stored URL alone is enough", b === E);
  const c = await eitherSignalUrl({ readStored: () => "ws://127.0.0.1:13994/ws", isConnected: async () => false, expected: E })();
  check("either-signal: neither signal -> returns the (stale) stored value, not expected", c !== E);
  const d = await eitherSignalUrl({ readStored: () => E, isConnected: async () => { throw new Error("unreachable"); }, expected: E })();
  check("either-signal: an unreachable daemon falls back to the stored URL", d === E);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
