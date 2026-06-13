// snapshot.mjs — accessibility-tree snapshot of the target tab.
//
// Walks Accessibility.getFullAXTree over CDP, rebuilds the parent/child node
// hierarchy, and for every interactive role that carries a backendDOMNodeId it
// mints a stable "@eN" ref (via snapshot-refs.mjs) so later click/fill calls can
// address the element. Refs are reset at the top so they always reflect the
// latest tree. Returns { url, title, tree } per BUILD_SPEC §4.

import { send } from "../dbg.mjs";
import * as refs from "../snapshot-refs.mjs";

// AX roles that represent something a user can interact with. Only these get a
// minted ref (and only when they expose a backendDOMNodeId).
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "treeitem",
  "listbox",
]);

// Pull a plain string out of a CDP AXValue ({ type, value }) | undefined.
function axValue(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.value === "string") return v.value;
  if (v.value != null) return String(v.value);
  return "";
}

// Read the live page url + title without depending on tab metadata.
async function readUrlTitle(tabId) {
  try {
    const res = await send(tabId, "Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
      awaitPromise: true,
    });
    const raw = res && res.result ? res.result.value : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      return { url: parsed.url || "", title: parsed.title || "" };
    }
  } catch {
    // fall through to empty defaults
  }
  return { url: "", title: "" };
}

// Turn the flat AX node list into a single rooted tree of lightweight nodes,
// minting refs for interactive elements along the way.
function buildTree(tabId, axNodes) {
  const byId = new Map();
  for (const n of axNodes) byId.set(n.nodeId, n);

  // Convert one AX node into our compact shape (without children yet).
  const convert = (n) => {
    const role = axValue(n.role);
    const name = axValue(n.name);
    const node = { role, name };

    if (
      INTERACTIVE_ROLES.has(role) &&
      typeof n.backendDOMNodeId === "number"
    ) {
      node.ref = refs.mintRef(tabId, {
        backendDOMNodeId: n.backendDOMNodeId,
        role,
        name,
      });
    }

    const value = axValue(n.value);
    if (value) node.value = value;

    return node;
  };

  // Recursively attach children, guarding against cycles / missing ids.
  const seen = new Set();
  const expand = (n) => {
    if (!n || seen.has(n.nodeId)) return null;
    seen.add(n.nodeId);
    const node = convert(n);
    const childIds = Array.isArray(n.childIds) ? n.childIds : [];
    const children = [];
    for (const cid of childIds) {
      const child = byId.get(cid);
      if (!child) continue;
      const built = expand(child);
      if (built) children.push(built);
    }
    if (children.length) node.children = children;
    return node;
  };

  // The root is the node with no parentId (fallback: first node).
  let root = axNodes.find((n) => n.parentId == null) || axNodes[0];
  if (!root) return null;
  return expand(root);
}

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  if (tabId == null) throw new Error("snapshot requires a target tab");

  const result = await send(tabId, "Accessibility.getFullAXTree", {});
  const axNodes = (result && result.nodes) || [];

  // Reset the tab's ref registry before walking so old refs never leak.
  refs.resetRefs(tabId);

  const tree = buildTree(tabId, axNodes);
  const { url, title } = await readUrlTitle(tabId);

  return { url, title, tree };
}
