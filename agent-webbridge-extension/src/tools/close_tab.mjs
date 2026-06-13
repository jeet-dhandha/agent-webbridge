// close_tab.mjs — close a single tab (the resolved target tab).
// The dispatcher passes args._tabId through, which it resolves into ctx.tabId.
// Returns { success:true, closed:true } per §4.

export default async function run(ctx, _args = {}) {
  const { chrome } = ctx;
  const tabId = ctx.tabId;

  if (tabId == null) throw new Error("No tab with given id (close_tab requires a tab)");

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg.includes("No tab with given id")) throw e;
    throw new Error("No tab with given id (" + tabId + "): " + msg);
  }

  return { success: true, closed: true };
}
