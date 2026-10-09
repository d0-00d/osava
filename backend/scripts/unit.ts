// Unit tests for the behaviour integration. They need no Windows, no Sysmon
// and no real model: the log is a script, the model is a fake HTTP server that
// answers like llama-server's /completion.
//
//   npm run unit
//
// What they pin down is the part of the integration that is OSAVA's own --
// bookmarking, single-flight scans, the monitor's state machine, the "needs
// review" rule, the origin guard -- not the model's judgement (selftest and
// eval-llama cover that) and not the PowerShell reader (see reader.ts).
import "./unit-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { classify, reviewReason } from "../src/services/behaviour/classifier";
import { CONTRACT } from "../src/services/behaviour/contract";
import { createMonitor, MAX_FAILURES, type MonitorDeps } from "../src/services/behaviour/monitor";
import { PAGE, scanOnce, type ScanSummary, type Source } from "../src/services/behaviour/pipeline";
import { LogAccessDenied, LogMissing, type LogRecord } from "../src/services/behaviour/reader";
import { ModelUnavailable } from "../src/services/behaviour/runtime";
import { readState } from "../src/services/behaviour/store";
import { ALLOWED_ORIGINS, localOnly } from "../src/routes/localOnly";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}
const resetState = () => fs.rmSync(process.env["OSAVA_STATE_FILE"]!, { force: true });

// ── a fake llama-server ────────────────────────────────────────────────────

type Decision = { token: string; p: number } | "fail";
let decide: (event: string) => Decision = () => ({ token: "none", p: 0.95 });
let delayMs = 0;
let calls: string[] = [];   // the event text of every /completion request

const fake = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const { prompt } = JSON.parse(data) as { prompt: string };
    const event = prompt.slice(prompt.lastIndexOf("EventID:"));
    calls.push(event);
    if (delayMs) await sleep(delayMs);
    const d = decide(event);
    if (d === "fail") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    const rest = (1 - d.p) / (CONTRACT.severity.scale.length - 1);
    const top = CONTRACT.severity.scale.map((s) => ({ token: s, logprob: Math.log(s === d.token ? d.p : rest) }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: d.token, completion_probabilities: [{ top_logprobs: top }] }));
  });
});
test.before(() => new Promise<void>((r) => fake.listen(Number(process.env["OSAVA_LLM_PORT"]), "127.0.0.1", r)));
test.after(() => { fake.close(); });
test.beforeEach(() => { resetState(); calls = []; delayMs = 0; decide = () => ({ token: "none", p: 0.95 }); });

// ── scripted log ───────────────────────────────────────────────────────────

const rec = (recordId: number, eid: number, data: Record<string, string>): LogRecord =>
  ({ recordId, eid, data, time: new Date(Date.UTC(2026, 9, 1, 0, 0, recordId)).toISOString() });

const SYSTEM = "NT AUTHORITY\\SYSTEM";
const svchost = (id: number) => rec(id, 1, {
  Image: "C:\\Windows\\System32\\svchost.exe", CommandLine: "C:\\Windows\\system32\\svchost.exe -k netsvcs -p -s Schedule",
  ParentImage: "C:\\Windows\\System32\\services.exe", ParentCommandLine: "C:\\Windows\\system32\\services.exe", User: SYSTEM });
const wordShell = (id: number, user = "CORP\\alice") => rec(id, 1, {
  Image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", CommandLine: "powershell.exe -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AA==",
  ParentImage: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE", ParentCommandLine: "WINWORD.EXE /n", User: user });
const whoami = (id: number) => rec(id, 1, {
  Image: "C:\\Windows\\System32\\cmd.exe", CommandLine: "cmd.exe /c whoami",
  ParentImage: "C:\\Windows\\explorer.exe", ParentCommandLine: "C:\\Windows\\Explorer.EXE", User: "CORP\\bob" });
const tool = (id: number, name: string) => rec(id, 1, {
  Image: `C:\\Tools\\${name}.exe`, CommandLine: `C:\\Tools\\${name}.exe`,
  ParentImage: "C:\\Windows\\explorer.exe", ParentCommandLine: "C:\\Windows\\Explorer.EXE", User: "CORP\\bob" });
const dns = (id: number) => rec(id, 22, { Image: "C:\\Windows\\System32\\svchost.exe", QueryName: "example.com" });

/** Behaves like `Get-WinEvent -Oldest -MaxEvents max -FilterXPath 'EventRecordID > after'`. */
const logOf = (recs: LogRecord[]): Source => async (after, max) =>
  recs.filter((r) => r.recordId > after).sort((a, b) => a.recordId - b.recordId).slice(0, max);

const bySev = (event: string): Decision =>
  event.includes("-enc ") ? { token: "high", p: 0.92 } :
  event.includes("whoami") ? { token: "medium", p: 0.6 } :
  { token: "none", p: 0.95 };

// ── pipeline ───────────────────────────────────────────────────────────────

test("a backlog larger than one page drains in order and no event is skipped", async () => {
  decide = bySev;
  const recs: LogRecord[] = [];
  for (let i = 1; i <= 1200; i++) {
    recs.push(i % 50 === 0 ? dns(i) : [svchost, svchost, wordShell, whoami][i % 4]!(i));
  }
  const src = logOf(recs);
  const outOfDomain = recs.filter((r) => r.eid === 22).length;

  const s1 = await scanOnce(25, src);
  assert.equal(s1.read, PAGE);
  assert.equal(s1.more, true, "a full page means more is waiting");
  assert.equal(s1.bookmark, 500);
  assert.equal(s1.classified, 3, "svchost, powershell-from-Word and whoami");

  const s2 = await scanOnce(25, src);
  assert.equal(s2.bookmark, 1000);
  assert.equal(s2.classified, 0);

  const s3 = await scanOnce(25, src);
  assert.equal(s3.read, 200);
  assert.equal(s3.more, false);
  assert.equal(s3.bookmark, 1200);

  const st = await readState();
  assert.equal(st.outOfDomain, outOfDomain);
  const total = Object.values(st.verdicts).reduce((n, v) => n + v.count, 0);
  assert.equal(total, 1200 - outOfDomain, "every in-domain event counted exactly once");
  assert.equal(calls.length, 3, "the model is asked once per behaviour, not once per event");
  const sevs = Object.values(st.verdicts).map((v) => v.severity).sort();
  assert.deepEqual(sevs, ["high", "medium", "none"]);
  const high = Object.values(st.verdicts).find((v) => v.severity === "high")!;
  assert.equal(high.needsReview, true);
  assert.equal(high.failedOpen, false);
});

test("when the per-scan budget runs out the bookmark stops at the first undecided event", async () => {
  const recs = ["a", "b", "c", "d", "e"].map((n, i) => tool(i + 1, n));
  const src = logOf(recs);

  const s1 = await scanOnce(2, src);
  assert.deepEqual([s1.classified, s1.deferred, s1.more, s1.bookmark], [2, true, true, 2]);
  const s2 = await scanOnce(2, src);
  assert.deepEqual([s2.classified, s2.deferred, s2.bookmark], [2, true, 4]);
  const s3 = await scanOnce(2, src);
  assert.deepEqual([s3.classified, s3.deferred, s3.more, s3.bookmark], [1, false, false, 5]);
  assert.equal(Object.keys((await readState()).verdicts).length, 5);
});

test("a model failure mid-scan saves what was decided and resumes at the failing event", async () => {
  const recs = ["a", "b", "c", "d"].map((n, i) => tool(i + 1, n));
  const src = logOf(recs);
  decide = (ev) => (ev.includes("\\c.exe") ? "fail" : { token: "none", p: 0.95 });

  await assert.rejects(scanOnce(25, src), /llama-server 500/);
  let st = await readState();
  assert.equal(Object.keys(st.verdicts).length, 2, "a and b were kept");
  assert.equal(st.bookmark, 2, "and the bookmark sits just before the event that failed");

  decide = () => ({ token: "none", p: 0.95 });
  calls = [];
  const s = await scanOnce(25, src);
  assert.equal(s.classified, 2);
  assert.equal(calls.length, 2, "a and b were not decided a second time");
  st = await readState();
  assert.equal(Object.keys(st.verdicts).length, 4);
  assert.equal(st.bookmark, 4);
});

test("a verdict made by a different model is judged again, keeping its history", async () => {
  const src = logOf([wordShell(1), wordShell(2, "CORP\\carol")]);
  decide = bySev;
  await scanOnce(25, logOf([wordShell(1)]));
  const before = Object.values((await readState()).verdicts)[0]!;
  assert.equal(before.count, 1);

  const original = CONTRACT.model.gguf_sha256;
  assert.ok(original, "the contract is bound to a model");
  CONTRACT.model.gguf_sha256 = "f".repeat(64);
  try {
    calls = [];
    await scanOnce(25, src);   // record 1 is behind the bookmark; record 2 is the same behaviour
    assert.equal(calls.length, 1, "the new model was asked");
    const after = Object.values((await readState()).verdicts)[0]!;
    assert.equal(after.modelSha256, "f".repeat(64));
    assert.equal(after.count, 2);
    assert.equal(after.firstSeen, before.firstSeen);
    assert.equal(after.sample.includes("carol"), true, "the sample is the event the new model actually saw");
  } finally {
    CONTRACT.model.gguf_sha256 = original;
  }
});

test("two scans started together are one scan", async () => {
  delayMs = 30;
  const recs = [svchost(1), wordShell(2), whoami(3)];
  const src = logOf(recs);
  const a = scanOnce(25, src);
  const b = scanOnce(25, src);
  assert.equal(a, b, "the second caller is handed the scan already running");
  await a;
  assert.equal(calls.length, 3);
  assert.equal((await readState()).bookmark, 3);
  // and it is not stuck: the next call starts a new scan
  const c = scanOnce(25, src);
  assert.notEqual(c, a);
  await c;
});

test("an unusable first token fails open to medium and is put in front of a person", async () => {
  // a model answering with a non-severity token and no severity alternatives
  const odd = http.createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ content: "banana", completion_probabilities: [{ top_logprobs: [{ token: "banana", logprob: -0.1 }] }] })); });
  await new Promise<void>((r) => odd.listen(18090, "127.0.0.1", r));
  try {
    const v = await classify("EventID: 1\nEventType: Process Create\nImage: C:\\x.exe", { baseUrl: "http://127.0.0.1:18090" });
    assert.equal(v.failedOpen, true);
    assert.equal(v.severity, "medium");
    assert.equal(v.needsReview, true);
    assert.equal(reviewReason(v), "no_answer");
  } finally {
    odd.close();
  }
});

// ── needs review ───────────────────────────────────────────────────────────

test("reviewReason: the one definition of 'needs review'", () => {
  assert.equal(reviewReason({ failedOpen: true, severity: "medium", margin: 1 }), "no_answer");
  assert.equal(reviewReason({ failedOpen: false, severity: "high", margin: 0.99 }), "not_benign");
  assert.equal(reviewReason({ failedOpen: false, severity: "medium", margin: 0.99 }), "not_benign");
  assert.equal(reviewReason({ failedOpen: false, severity: "none", margin: 0.1 }), "close_call");
  assert.equal(reviewReason({ failedOpen: false, severity: "low", margin: 0.19 }), "close_call");
  assert.equal(reviewReason({ failedOpen: false, severity: "none", margin: 0.2 }), null);
  assert.equal(reviewReason({ failedOpen: false, severity: "none", margin: 0.9 }), null);
  // 5-way input from an older contract still buckets as malicious
  assert.equal(reviewReason({ failedOpen: false, severity: "critical", margin: 0.9 }), "not_benign");
});

// ── monitor ────────────────────────────────────────────────────────────────

const summary = (over: Partial<ScanSummary> = {}): ScanSummary =>
  ({ read: 0, outOfDomain: 0, known: 0, classified: 0, deferred: false, more: false, bookmark: 0, ...over });
const FAST = { minIntervalMs: 5, catchUpMs: 5, retryBaseMs: 5 };

function deps(over: Partial<MonitorDeps> = {}) {
  const log: string[] = [];
  const d: MonitorDeps = {
    probeLog: async () => { log.push("probe"); },
    startModel: async () => { log.push("start"); },
    stopModel: () => { log.push("stopModel"); },
    scan: async () => { log.push("scan"); return summary(); },
    ...over,
  };
  return { d, log };
}

test("monitor: probe, start the model, scan, then keep scanning until stopped", async () => {
  const { d, log } = deps();
  const m = createMonitor(d, FAST);
  m.start(10);
  await until(() => m.state().scans >= 3);
  assert.equal(m.state().phase === "waiting" || m.state().phase === "scanning" || m.state().phase === "starting", true);
  assert.equal(log.filter((x) => x === "probe").length, 1, "the log is probed once per start, not per scan");
  m.stop();
  const n = m.state().scans;
  assert.equal(m.state().phase, "off");
  assert.equal(log.at(-1), "stopModel");
  await sleep(40);
  assert.equal(m.state().scans, n, "no scan after stop");
});

test("monitor: a full page is followed up at once, not after a whole interval", async () => {
  let n = 0;
  const { d } = deps({ scan: async () => summary({ more: ++n < 4 }) });
  const m = createMonitor(d, FAST);
  const t0 = Date.now();
  m.start(60_000);                       // an interval that would fail the test if waited out
  await until(() => m.state().scans >= 4, 1500);
  assert.ok(Date.now() - t0 < 1500);
  m.stop();
});

test("monitor: a log that cannot be read switches monitoring off at once and never loads the model", async () => {
  let probes = 0;
  const { d, log } = deps({ probeLog: async () => { probes++; throw new LogAccessDenied("no access"); } });
  const m = createMonitor(d, FAST);
  m.start();
  await until(() => m.state().phase === "off");
  await sleep(40);                       // long enough for a (wrong) retry to show up
  const e = m.state().error!;
  assert.deepEqual([e.code, e.fatal], ["LOG_ACCESS_DENIED", true]);
  assert.equal(probes, 1, "waiting for the user to fix something is not retried");
  assert.equal(log.includes("start"), false);
  assert.equal(log.includes("scan"), false);
});

test("monitor: a missing log and a wrong model are fatal too, each with its own code", async () => {
  for (const [err, code] of [[new LogMissing("x"), "LOG_MISSING"], [new ModelUnavailable("x"), "MODEL_UNAVAILABLE"]] as const) {
    let attempts = 0;
    const { d, log } = deps({
      probeLog: async () => { if (err instanceof LogMissing) { attempts++; throw err; } },
      startModel: async () => { if (err instanceof ModelUnavailable) { attempts++; throw err; } },
    });
    const m = createMonitor(d, FAST);
    m.start();
    await until(() => m.state().phase === "off");
    await sleep(40);
    assert.equal(m.state().error!.code, code);
    assert.equal(m.state().error!.fatal, true);
    assert.equal(attempts, 1, `${code} is not retried`);
    assert.equal(log.includes("scan"), false);
  }
});

test("monitor: transient failures are retried, and a good scan clears them", async () => {
  let n = 0;
  const { d } = deps({ scan: async () => { if (++n <= 2) throw new Error("fetch failed"); return summary(); } });
  const m = createMonitor(d, FAST);
  m.start(50);
  await until(() => m.state().scans >= 1);
  assert.equal(m.state().phase === "off", false);
  assert.equal(m.state().failures, 0);
  assert.equal(m.state().error, null);
  m.stop();
});

test(`monitor: ${MAX_FAILURES} failures in a row switch it off, visibly`, async () => {
  let attempts = 0;
  const { d, log } = deps({ scan: async () => { attempts++; throw new Error("fetch failed"); } });
  const m = createMonitor(d, FAST);
  m.start(50);
  await until(() => m.state().phase === "off");
  const e = m.state().error!;
  assert.deepEqual([e.code, e.fatal, m.state().failures], ["ERROR", true, MAX_FAILURES]);
  assert.equal(attempts, MAX_FAILURES);
  assert.equal(log.at(-1), "stopModel", "the model is released when monitoring gives up");
});

test("monitor: stopping mid-scan leaves no error behind and does not schedule another", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { d, log } = deps({ scan: async () => { log.push("scan"); await gate; throw new Error("fetch failed (the model was stopped)"); } });
  const m = createMonitor(d, FAST);
  m.start();
  await until(() => m.state().phase === "scanning");
  m.stop();
  release();
  await sleep(40);
  assert.equal(m.state().phase, "off");
  assert.equal(m.state().error, null, "the error caused by stopping is not reported");
  assert.equal(log.filter((x) => x === "scan").length, 1);
});

test("monitor: start is idempotent and works again after a stop", async () => {
  const { d, log } = deps();
  const m = createMonitor(d, FAST);
  m.start(10);
  m.start(10);
  await until(() => m.state().scans >= 1);
  assert.equal(log.filter((x) => x === "probe").length, 1);
  m.stop();
  m.start(10);
  await until(() => m.state().scans >= 2 || log.filter((x) => x === "probe").length === 2);
  assert.equal(log.filter((x) => x === "probe").length, 2);
  m.stop();
});

// ── origin guard ───────────────────────────────────────────────────────────

function guard(headers: Record<string, string | undefined>) {
  let status = 0, body: unknown, nexted = false, removed = "";
  const res = {
    removeHeader: (h: string) => { removed = h; },
    status(c: number) { status = c; return this; },
    json(b: unknown) { body = b; return this; },
  };
  localOnly({ headers } as never, res as never, () => { nexted = true; });
  return { status, body, nexted, removed };
}

test("origin guard: OSAVA's own window passes, every other page is refused", () => {
  for (const origin of ALLOWED_ORIGINS) assert.equal(guard({ host: "localhost:4000", origin }).nexted, true, origin);
  assert.equal(guard({ host: "127.0.0.1:4000" }).nexted, true, "no Origin = not a browser page (curl, node)");
  assert.equal(guard({ host: "[::1]:4000" }).nexted, true);

  for (const origin of ["https://evil.example", "http://localhost:3000", "http://tauri.localhost.evil.example", "null", "file://"]) {
    const g = guard({ host: "localhost:4000", origin });
    assert.deepEqual([g.nexted, g.status], [false, 403], origin);
    assert.equal(g.removed, "Access-Control-Allow-Origin", "a refused page may not read even the refusal");
  }
});

test("origin guard: a DNS-rebound or LAN Host is refused", () => {
  for (const host of ["evil.example:4000", "evil.example", "192.168.1.20:4000", "localhost:4001", "localhost", ""]) {
    assert.equal(guard({ host }).nexted, false, `host ${JSON.stringify(host)}`);
  }
  assert.equal(guard({}).nexted, false, "no Host header at all");
});
