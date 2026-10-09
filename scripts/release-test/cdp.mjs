// A minimal Chrome DevTools Protocol client, enough to drive the real OSAVA window.
// WebView2 exposes the protocol when it is started with --remote-debugging-port (final-test.ps1 does that).
// Needs Node 22+: it uses the global WebSocket.
import fs from "node:fs";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Page {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.n = 0;
    this.pending = new Map();
    this.console = [];       // console errors and warnings, and uncaught exceptions
    this.requests = new Map();
    this.failures = [];      // "<url> <reason>" for every request that failed
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        const { res, rej } = this.pending.get(d.id);
        this.pending.delete(d.id);
        d.error ? rej(new Error(d.error.message)) : res(d.result);
      } else if (d.method === "Runtime.consoleAPICalled") {
        const t = d.params.type;
        if (t === "error" || t === "warning") this.console.push(`[${t}] ` + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0]);
      } else if (d.method === "Runtime.exceptionThrown") {
        this.console.push("[exception] " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
      } else if (d.method === "Network.requestWillBeSent") {
        this.requests.set(d.params.requestId, { url: d.params.request.url });
      } else if (d.method === "Network.responseReceived") {
        const r = this.requests.get(d.params.requestId) ?? {};
        this.requests.set(d.params.requestId, { ...r, url: d.params.response.url, status: d.params.response.status });
      } else if (d.method === "Network.loadingFailed") {
        const r = this.requests.get(d.params.requestId);
        this.failures.push(`${r?.url ?? d.params.requestId} ${d.params.errorText}${d.params.blockedReason ? " (" + d.params.blockedReason + ")" : ""}`);
      }
    };
  }
  async init() { await this.ready; for (const d of ["Page", "Runtime", "Network"]) await this.send(`${d}.enable`); }
  send(method, params = {}) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expression, what, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await this.eval(expression)) return; } catch { /* page still loading */ }
      await sleep(150);
    }
    throw new Error("timed out waiting for " + what);
  }
  async shot(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${dir}/${name}.png`, Buffer.from(data, "base64"));
  }
  click(selectorExpr) { return this.eval(`(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`); }
  async openTab(label) {
    const ok = await this.click(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`);
    if (!ok) throw new Error("no nav item " + label);
  }
}
