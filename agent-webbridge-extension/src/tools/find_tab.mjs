// find_tab.mjs — locate an already-open tab by URL and make it the current tab.
// Queries chrome.tabs for the URL (honoring args.active to prefer the focused
// tab), picks the first match, attaches the debugger, and records it as the
// dispatcher's current tab. Returns { success:true, url, tabId } per §4.

export default async function run(ctx, args = {}) {
  const { chrome } = ctx;
  const { url, active } = args;

  if (!url) throw new Error("find_tab requires a url");

  const query = { url };
  if (active) {
    query.active = true;
    query.lastFocusedWindow = true;
  }

  let tabs = await chrome.tabs.query(query);

  // If an active-scoped query found nothing, fall back to any matching tab.
  if ((!tabs || tabs.length === 0) && active) {
    tabs = await chrome.tabs.query({ url });
  }

  const tab = tabs && tabs[0];
  if (!tab) throw new Error("No tab with given id (no tab found for url " + url + ")");

  const tabId = tab.id;

  await ctx.attach(tabId);
  ctx.setCurrentTab(tabId);

  return { success: true, url: tab.url || url, tabId };
}
