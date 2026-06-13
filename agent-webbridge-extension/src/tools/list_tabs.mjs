// list_tabs.mjs — enumerate open tabs with their session group titles.
// Queries every tab and decorates each with its tab-group title (best-effort).
// Returns { success:true, tabs:[{tabId,url,title,active,groupTitle}] } per §4.

import * as groups from "../groups.mjs";

export default async function run(ctx, _args = {}) {
  const { chrome } = ctx;

  const tabs = await chrome.tabs.query({});

  const out = [];
  for (const tab of tabs) {
    let groupTitle = "";
    try {
      groupTitle = await groups.groupTitleForTab(tab.id);
    } catch {
      groupTitle = "";
    }
    out.push({
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: !!tab.active,
      groupTitle: groupTitle || "",
    });
  }

  return { success: true, tabs: out };
}
