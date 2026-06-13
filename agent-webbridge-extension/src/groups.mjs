// groups.mjs — session → Chrome tab group mapping.
//
// Each agent session is mirrored onto a real Chrome tab group titled
// "agent:<session>" so a human can see (and the daemon can manage) all tabs a
// session owns. We cache session -> groupId so repeated navigations in the same
// session land in the same group, and use the group membership to enumerate /
// close every tab a session created.

const groupBySession = new Map(); // session -> groupId

// Stable, pleasant color for agent groups. Tab group colors are an enum of
// named strings; "blue" is always valid.
const GROUP_COLOR = "blue";

// Put a tab into its session's group, creating the group on first use and
// (re)labelling it. Returns the groupId (or undefined when there is no session).
export async function assignToSession(tabId, session, groupTitle) {
  if (!session) return undefined;

  let groupId = groupBySession.get(session);

  // If we think we already have a group, fold the new tab into it. If that
  // group no longer exists (user closed every tab in it), fall back to a fresh
  // group below.
  if (groupId !== undefined) {
    try {
      groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch (e) {
      groupId = undefined;
      groupBySession.delete(session);
    }
  }

  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    groupBySession.set(session, groupId);
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
  const groupId = groupBySession.get(session);
  if (groupId === undefined) return [];
  try {
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.map((t) => t.id);
  } catch (e) {
    return [];
  }
}

// Close every tab belonging to a session; returns how many were closed.
export async function closeSession(session) {
  const tabIds = await tabIdsInSession(session);
  if (tabIds.length) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch (e) {
      // some tabs may already be gone; still report what we intended to close
    }
  }
  groupBySession.delete(session);
  return tabIds.length;
}

// Best-effort title of the group a tab belongs to ("" when ungrouped/unknown).
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
