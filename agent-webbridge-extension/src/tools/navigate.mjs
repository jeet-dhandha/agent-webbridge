// navigate.mjs — open or redirect a tab to a URL and wait for load.
// Creates a new tab (args.newTab) or updates the current/target tab, waits for
// chrome.tabs.onUpdated status "complete", attaches the debugger, assigns the
// tab to the caller's session group, and records it as the dispatcher's current tab.
// Returns { success:true, url, tabId } per BUILD_SPEC §4.

import * as groups from "../groups.mjs";

// Wait until the given tab reaches status "complete" (or resolve immediately if
// it already is). Times out after a generous window so navigation never hangs.
function waitForComplete(chrome, tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {}
      clearTimeout(timer);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };

    const timer = setTimeout(finish, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Already complete? Resolve right away.
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime?.lastError) return; // wait for the event instead
        if (tab && tab.status === "complete") finish();
      });
    } catch {}
  });
}

export default async function run(ctx, args = {}) {
  const { chrome } = ctx;
  const { url, newTab, group_title } = args;

  if (!url) throw new Error("navigate requires a url");

  let tabId;

  if (newTab) {
    const tab = await chrome.tabs.create({ url });
    tabId = tab.id;
  } else {
    tabId = ctx.tabId;
    if (tabId == null) {
      // No current tab to reuse — fall back to creating one.
      const tab = await chrome.tabs.create({ url });
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url });
    }
  }

  await waitForComplete(chrome, tabId);

  await ctx.attach(tabId);
  await groups.assignToSession(tabId, ctx.session, group_title);
  ctx.setCurrentTab(tabId);

  return { success: true, url, tabId };
}
