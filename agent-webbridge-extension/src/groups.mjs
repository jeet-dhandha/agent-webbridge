// groups.mjs — session → Chrome tab group mapping.
//
// Each agent session is mirrored onto a real Chrome tab group titled
// "agent:<session>" (or a caller-supplied group_title) so a human can see — and
// the daemon can manage — every tab a session owns. We map session -> groupId so
// repeated navigations in the same session land in the same group, and so we can
// enumerate / close every tab a session created.
//
// PERSISTENCE (why this isn't just a Map): the MV3 service worker is terminated
// after ~30s idle, which wipes ALL module-level state. If this map only lived in
// memory, a woken service worker would start empty and then (a) create a
// DUPLICATE same-named group on the next navigate in an existing session, and
// (b) be unable to enumerate/close that session's tabs (close_session returns 0,
// find_tab can't locate the session's tab). So the map is mirrored into
// chrome.storage.session, which survives SW suspension within a browser session
// and is cleared on browser restart — exactly the lifetime of the Chrome tab
// groups it points at. (storage.local would be wrong: it would persist stale
// groupIds across browser restarts, when the real groups are gone/renumbered.)
// Title-based reconstruction is deliberately NOT used: chrome.tabGroups.query
// can't filter by title and custom group_titles can collide across sessions.
//
// SERIALIZATION: every mutation of a session's group (assign AND close) runs on a
// per-session chain (sessionChain). The dispatch layer runs navigate with no
// queue key (fully concurrent) and close_session on a separate "meta" queue, so
// without this chain a navigate and a close — or two navigates — in the same
// session would race: two could each create a group, or a close could snapshot
// the group, a navigate could fold a new tab in, and the close would then orphan
// that tab and drop the mapping (reintroducing the duplicate-group bug). The
// chain forces those ops to run one at a time per session. Writes to storage are
// AWAITED on every mutation path so the value is durable while the tool call is
// still in-flight (the keepalive heartbeat keeps the SW alive until then).

const STORAGE_KEY = "groupBySession";

// Stable, pleasant color for agent groups. Tab group colors are an enum of
// named strings; "blue" is always valid.
const GROUP_COLOR = "blue";

// Hot in-memory cache. Source of truth is chrome.storage.session; this is
// hydrated from it once per service-worker lifetime (see ensureHydrated).
const groupBySession = new Map(); // session -> groupId
let hydrated = null; // dedupes the one-time load

// Per-session serialization for ALL group mutations (assign + close). Ephemeral
// by design — only in-flight calls within one SW lifetime need ordering.
const sessionChain = new Map(); // session -> Promise

// Serialize writes so interleaved set()s can't lose updates: each write flushes
// the FULL current map, and the last write in the chain reflects the final state.
let persistChain = Promise.resolve();

async function ensureHydrated() {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const stored = await chrome.storage.session.get(STORAGE_KEY);
        const obj = stored && stored[STORAGE_KEY];
        if (obj && typeof obj === "object") {
          for (const [session, groupId] of Object.entries(obj)) {
            if (typeof groupId === "number") groupBySession.set(session, groupId);
          }
        }
      } catch (e) {
        // storage.session unavailable — degrade to in-memory only (still correct
        // within a single SW lifetime).
      }
    })();
  }
  return hydrated;
}

function persist() {
  persistChain = persistChain.then(async () => {
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: Object.fromEntries(groupBySession) });
    } catch (e) {
      // best-effort: a failed write only costs SW-suspension durability.
    }
  });
  return persistChain;
}

// Run `fn` serialized after any in-flight assign/close for this session. Keeps a
// non-rejecting tail so the next caller can await it and a rejected op never
// stalls or poisons the chain; self-prunes when it's the last link.
function runInSession(session, fn) {
  const prev = sessionChain.get(session) || Promise.resolve();
  const run = prev.then(fn, fn); // run even if the previous op rejected
  const tail = run.catch(() => {});
  sessionChain.set(session, tail);
  tail.then(() => {
    if (sessionChain.get(session) === tail) sessionChain.delete(session);
  });
  return run;
}

// Put a tab into its session's group, creating the group on first use and
// (re)labelling it. Returns the groupId (or undefined when there is no session).
export async function assignToSession(tabId, session, groupTitle) {
  if (!session) return undefined;
  return runInSession(session, () => assignLocked(tabId, session, groupTitle));
}

async function assignLocked(tabId, session, groupTitle) {
  await ensureHydrated();

  let groupId = groupBySession.get(session);

  // If we think we already have a group, fold the new tab into it. If that group
  // no longer exists (user closed every tab in it), fall back to a fresh group.
  if (groupId !== undefined) {
    try {
      groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch (e) {
      groupId = undefined;
      groupBySession.delete(session);
      await persist(); // durably drop the stale mapping before continuing
    }
  }

  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    groupBySession.set(session, groupId);
    await persist(); // durable BEFORE we return, while the SW is still kept alive
  }

  // Label + color the group. Best-effort: titling must not break navigation.
  try {
    await chrome.tabGroups.update(groupId, {
      title: groupTitle || "agent:" + session,
      color: GROUP_COLOR,
    });
  } catch (e) {
    // ignore — group may have been torn down between calls
  }

  return groupId;
}

// All tabIds currently living in a session's group.
export async function tabIdsInSession(session) {
  await ensureHydrated();
  const groupId = groupBySession.get(session);
  if (groupId === undefined) return [];
  try {
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.map((t) => t.id);
  } catch (e) {
    return [];
  }
}

// Close every tab belonging to a session; returns how many were closed. Runs on
// the per-session chain so it cannot interleave with a concurrent assign for the
// same session (which would otherwise orphan a freshly-added tab).
export async function closeSession(session) {
  if (!session) return 0;
  return runInSession(session, () => closeLocked(session));
}

async function closeLocked(session) {
  const tabIds = await tabIdsInSession(session);
  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch (e) {
      // some tabs may already be gone; still report what we intended to close
    }
  }
  if (groupBySession.delete(session)) await persist();
  return tabIds.length;
}

// Best-effort title of the group a tab belongs to ("" when ungrouped/unknown).
// Reads Chrome directly, so it needs no persisted state.
export async function groupTitleForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.groupId === undefined || tab.groupId < 0) return "";
    const group = await chrome.tabGroups.get(tab.groupId);
    return (group && group.title) || "";
  } catch (e) {
    return "";
  }
}
