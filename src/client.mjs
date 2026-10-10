// client.mjs — Universal Agent WebBridge Client (Node.js ESM)
// Zero external dependencies. Uses standard fetch (Node >= 18).

const DEFAULT_ROUTER = process.env.AWB_ROUTER || "http://127.0.0.1:10086";

export class WebBridgeClient {
  constructor(options = {}) {
    const raw = (options.router || DEFAULT_ROUTER).replace(/\/command\/?$/, "");
    this.router = raw;
    this.profile = options.profile || "Default";
    this.session = options.session || `session-${Date.now()}`;
    this.currentTabId = null;
  }

  async command(action, args = {}, timeoutMs = 60000) {
    const payload = {
      action,
      args: { ...args },
      session: this.session,
      profile: this.profile,
    };

    // Pin tabId if tracked and not explicitly overridden
    if (this.currentTabId && payload.args._tabId === undefined && action !== "close_session") {
      payload.args._tabId = this.currentTabId;
    }

    const res = await fetch(`${this.router}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    if (data.ok === false) {
      throw new Error(`WebBridge error on ${action}: ${data.error || JSON.stringify(data)}`);
    }

    // Auto-track tabId on navigation
    if (data.data?.tabId) {
      this.currentTabId = data.data.tabId;
    }

    return data.data;
  }

  async navigate(url, { newTab = false, groupTitle = null } = {}) {
    const args = { url, newTab };
    if (groupTitle) args.group_title = groupTitle;
    return await this.command("navigate", args);
  }

  async evaluate(code, timeoutMs = 30000) {
    const res = await this.command("evaluate", { code }, timeoutMs);
    return res?.value !== undefined ? res.value : res;
  }

  async click(selector) {
    return await this.command("click", { selector });
  }

  async trustedClick(selector, options = {}) {
    const args = { selector, ...options };
    return await this.command("trusted_click", args);
  }

  async fill(selector, value) {
    return await this.command("fill", { selector, value });
  }

  async snapshot() {
    return await this.command("snapshot", {});
  }

  async screenshot(optionsOrPath = null) {
    const args = typeof optionsOrPath === "string" ? { path: optionsOrPath } : (optionsOrPath || {});
    return await this.command("screenshot", args);
  }

  async upload(selector, files) {
    const fileList = Array.isArray(files) ? files : [files];
    return await this.command("upload", { selector, files: fileList });
  }

  async fileChooserIntercept(enabled = true) {
    return await this.command("file_chooser_intercept", { enabled });
  }

  async network(cmd, { filter = null, requestId = null } = {}) {
    const args = { cmd };
    if (filter) args.filter = filter;
    if (requestId) args.requestId = requestId;
    return await this.command("network", args);
  }

  async listTabs() {
    return await this.command("list_tabs", {});
  }

  async findTab(url, { active = true } = {}) {
    return await this.command("find_tab", { url, active });
  }

  async closeTab() {
    return await this.command("close_tab", {});
  }

  async closeSession() {
    return await this.command("close_session", {});
  }

  async saveAsPdf({ path = null, paperFormat = null } = {}) {
    const args = {};
    if (path) args.path = path;
    if (paperFormat) args.paper_format = paperFormat;
    return await this.command("save_as_pdf", args);
  }
}

export default WebBridgeClient;
