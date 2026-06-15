// file_chooser_intercept.mjs — toggle native file-chooser dialog interception.
//
// With interception ON, anything that opens a file picker on the page (a user-style
// click on an <input type=file>, or the page calling input.click()) does NOT pop the
// OS file dialog (Finder / Explorer). Instead the chooser is suppressed and files are
// supplied programmatically via the `upload` tool (DOM.setFileInputFiles).
//
// Why this exists: some sites auto-open the file picker when their media UI mounts
// (e.g. LinkedIn's post "Add media" editor). Even though `upload` sets the file
// directly, that auto-triggered native dialog would otherwise pop a Finder window and
// just sit there. Enable interception BEFORE the action that triggers the picker, run
// the upload, then disable it to restore normal behavior on the tab.
//
// Returns: { success:true, enabled }.

import { send } from "../dbg.mjs";

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const enabled = !!args.enabled;
  // setInterceptFileChooserDialog needs the Page domain enabled.
  try { await send(tabId, "Page.enable", {}); } catch {}
  await send(tabId, "Page.setInterceptFileChooserDialog", { enabled });
  return { success: true, enabled };
}
