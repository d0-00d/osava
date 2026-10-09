// A plain launch of the real window, judged by what a person would see: no reload, no help.
// Attaches before the page loads (final-test.ps1 starts the app with the debugging port open).
//
//   node qa-launch.mjs <screenshot-dir>
//
// Exits 0 only if every check passes.
import { Page, sleep } from "./cdp.mjs";

const CDP = "http://127.0.0.1:9223";
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";

let targets = [];
for (let i = 0; i < 300; i++) {
  try { targets = await (await fetch(`${CDP}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch { /* not up yet */ }
  await sleep(50);
}
const target = targets.find((x) => x.type === "page");
if (!target) { console.log("FAIL  the app never exposed a window"); process.exit(2); }

const page = new Page(target.webSocketDebuggerUrl);
await page.init();
const failed = [], hosts = new Map();
page.ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Network.requestWillBeSent") { try { const h = new URL(d.params.request.url).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); } catch { /* data: URLs */ } }
  if (d.method === "Network.loadingFailed") failed.push(`${page.requests.get(d.params.requestId)?.url ?? d.params.requestId} ${d.params.errorText}`);
});

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const nav = () => page.eval(`[...document.querySelectorAll('.nav-item')].map(b => b.textContent.trim()).join(' | ') || '(shell not shown)'`);
const api = (p) => page.eval(`fetch('http://localhost:4000${p}').then(r => r.json())`);
const content = () => page.eval(`document.querySelector('.content')?.innerText ?? ''`);

await page.waitFor(`!!document.querySelector('.splash-btn')`, "the splash button", 40000);
console.log(at(), "splash finished");
await page.click(`document.querySelector('.splash-btn')`);
await page.waitFor(`!!document.querySelector('.sidebar')`, "the app shell", 30000);

// From Launch until System Health has its answer it must never say that nothing is installed. The first
// request goes out as the page loads, and a backend that is not listening yet refuses it. So watch from the
// moment the shell appears, while the facts are fetched.
let claimedNone = false, watching = true;
const watcher = (async () => {
  while (watching) {
    if (/No antivirus product detected|No firewall product detected/.test(await content())) claimedNone = true;
    await sleep(60);
  }
})();
const [inst, hist, sys] = await Promise.all([api("/api/install-status"), api("/api/av/history"), api("/api/system-status")]);
const mayClaimNone = sys.antivirus.length === 0 || sys.firewall.length === 0;   // then "none detected" would be true
await page.waitFor(`!document.querySelector('.pixel-transition')`, "the transition to finish", 20000);
await page.waitFor(`!document.body.innerText.includes('Checking protection status')`, "System Health to load", 25000);
await sleep(1500);
watching = false; await watcher;

const want = ["System Health", "Security Hub", ...(inst.installed ? ["AV Console"] : []), "Behaviour", ...(hist.length ? ["Threats", "Scan History"] : [])];
const got = (await nav()).split(" | ");
check("the sidebar has every tab this PC has data for", JSON.stringify(got) === JSON.stringify(want), `got [${got.join(" | ")}], expected [${want.join(" | ")}]`);
check("System Health never claimed that nothing is installed", mayClaimNone || !claimedNone, mayClaimNone ? "this PC reports none, so that claim is allowed" : "");

// Judge the page itself, not wherever the tab happens to be (a person may have clicked around in the window).
await page.openTab("System Health");
await page.waitFor(`document.querySelector('.osv-title')?.textContent === 'System Health' && !document.body.innerText.includes('Checking protection status')`, "System Health to load", 25000);
const shown = await content();
const missing = sys.antivirus.map((a) => a.displayName).filter((n) => !shown.includes(n));
check("System Health shows the antivirus products Security Center reports", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : sys.antivirus.map((a) => a.displayName).join(", ") || "none registered");

check("no request failed", failed.length === 0, failed.join("; "));
check("no console errors", page.console.length === 0, page.console.join(" || "));
check("the window talks to nothing but itself and the backend", [...hosts.keys()].every((h) => h === "tauri.localhost" || h === "localhost:4000"), JSON.stringify([...hosts]));
if (process.argv[2]) await page.shot(process.argv[2], "launch");
console.log(results.every(Boolean) ? "ALL PASS" : "SOME FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
