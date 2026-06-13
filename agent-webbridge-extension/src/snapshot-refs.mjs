// snapshot-refs.mjs — the `@e` ref scheme, kept PER TAB.
//
// Every tab gets its own registry of element refs so that snapshots taken in
// different tabs never collide. A snapshot (Accessibility.getFullAXTree walk)
// resets the tab's registry and mints a stable "@eN" ref for each interactive
// node; click/fill/etc. later resolve those refs back to a CDP backendDOMNodeId.
//
// Shape: refsByTab: Map<tabId, { seq:number, byRef:Map<"@eN",{backendDOMNodeId,role,name}> }>

const refsByTab = new Map(); // tabId -> { seq, byRef }

// Get (creating if missing) the per-tab registry entry.
function ensureEntry(tabId) {
  let entry = refsByTab.get(tabId);
  if (!entry) {
    entry = { seq: 0, byRef: new Map() };
    refsByTab.set(tabId, entry);
  }
  return entry;
}

// Clear a tab's refs and start a fresh numbering sequence. Called at the top of
// each snapshot so refs always reflect the latest accessibility tree.
export function resetRefs(tabId) {
  const entry = { seq: 0, byRef: new Map() };
  refsByTab.set(tabId, entry);
  return entry;
}

// Mint the next "@eN" ref for an interactive node and store its CDP coordinates.
export function mintRef(tabId, { backendDOMNodeId, role, name }) {
  const entry = ensureEntry(tabId);
  const ref = "@e" + (++entry.seq);
  entry.byRef.set(ref, { backendDOMNodeId, role, name });
  return ref;
}

// Resolve a previously minted ref back to its stored descriptor.
export function resolveRef(tabId, ref) {
  const entry = refsByTab.get(tabId);
  const found = entry && entry.byRef.get(ref);
  if (!found) {
    throw new Error("unknown ref " + ref + " — run snapshot first");
  }
  return found;
}

// Drop a tab's registry entirely (e.g. when the tab is removed).
export function pruneTab(tabId) {
  refsByTab.delete(tabId);
}
