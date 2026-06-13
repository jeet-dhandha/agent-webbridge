// close_session.mjs — close every tab belonging to the caller's session group.
// Delegates to groups.closeSession, which removes the session's tabs and returns
// the number closed. Returns { success:true, closed:<int> } per §4.

import * as groups from "../groups.mjs";

export default async function run(ctx, _args = {}) {
  const closed = await groups.closeSession(ctx.session);
  return { success: true, closed: typeof closed === "number" ? closed : 0 };
}
