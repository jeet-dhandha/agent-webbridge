// fill.mjs — the `fill` tool: type a value into a resolved element. For native
// <input>/<textarea> it uses the prototype value setter then dispatches input +
// change events so frameworks (React etc.) observe the change. For
// [contenteditable] hosts it focuses and uses execCommand('insertText').
//
// Returns: { success:true, tag, mode:"value"|"contenteditable" }.

import { resolveSelector } from "../dom.mjs";
import { send } from "../dbg.mjs";

const FILL_FN =
  "function(value){" +
  "var tag=(this.tagName||'').toLowerCase();" +
  "if(this.isContentEditable){" +
  "this.focus();" +
  "var sel=window.getSelection();sel.removeAllRanges();" +
  "var range=document.createRange();range.selectNodeContents(this);sel.addRange(range);" +
  "document.execCommand('insertText',false,value);" +
  "return {tag:tag,mode:'contenteditable'};" +
  "}" +
  "var proto=(tag==='textarea')?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;" +
  "var desc=Object.getOwnPropertyDescriptor(proto,'value');" +
  "this.focus();" +
  "if(desc&&desc.set){desc.set.call(this,value);}else{this.value=value;}" +
  "this.dispatchEvent(new Event('input',{bubbles:true}));" +
  "this.dispatchEvent(new Event('change',{bubbles:true}));" +
  "return {tag:tag,mode:'value'};" +
  "}";

export default async function run(ctx, args = {}) {
  const tabId = ctx.tabId;
  const selector = args.selector;
  const value = args.value == null ? "" : String(args.value);

  const { objectId } = await resolveSelector(tabId, selector);

  const { result, exceptionDetails } = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: FILL_FN,
    arguments: [{ value }],
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (exceptionDetails) {
    const ex = exceptionDetails.exception;
    const message =
      (ex && (ex.description || ex.value)) ||
      exceptionDetails.text ||
      "fill failed";
    throw new Error(String(message));
  }

  const out = (result && result.value) || {};
  return { success: true, tag: out.tag || "", mode: out.mode || "value" };
}
