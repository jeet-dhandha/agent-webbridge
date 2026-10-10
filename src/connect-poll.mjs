// connect-poll.mjs — zero-restart connect: decide quickly whether a profile's extension took the
// daemon URL we handed it through its popup. A build that understands the hint stores it as
// local_url within moments; an older build ignores it and never does. So we poll the stored URL
// for a short window and give up on profiles that never change, instead of waiting out the full
// daemon-connect timeout. Pure logic: every effect (read, sleep, clock) is injected.

export const STORED_URL_WINDOW_MS = 4000;
export const STORED_URL_POLL_MS = 250;

// Resolves true as soon as readUrl() returns `expected`, false once `windowMs` has elapsed without
// it. A read that returns null/undefined or throws counts as "not yet". Never sleeps past the window.
export async function waitForStoredUrl({
  readUrl,
  expected,
  sleep,
  now = () => Date.now(),
  windowMs = STORED_URL_WINDOW_MS,
  intervalMs = STORED_URL_POLL_MS,
}) {
  const deadline = now() + windowMs;
  for (;;) {
    let got = null;
    try { got = await readUrl(); } catch { got = null; }
    if (got === expected) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(intervalMs, left));
  }
}
