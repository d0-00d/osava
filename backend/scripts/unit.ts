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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classify, reviewReason } from "../src/services/behaviour/classifier";
import { CONTRACT } from "../src/services/behaviour/contractSpec";
import { createMonitor, MAX_FAILURES, type MonitorDeps } from "../src/services/behaviour/monitor";
import { PAGE, scanOnce, type ScanSummary, type Source } from "../src/services/behaviour/pipeline";
import { LogAccessDenied, LogMissing, SCRIPT, SECURITY_EVENT_IDS, SECURITY_LOG, SYSMON_LOG, type LogRecord } from "../src/services/behaviour/reader";
import { ModelUnavailable } from "../src/services/behaviour/runtime";
import { readState, writeState } from "../src/services/behaviour/store";
import { ALLOWED_ORIGINS, localOnly } from "../src/routes/localOnly";
import { download, DownloadError } from "../src/services/behaviour/download";
import { cancelInstall, installDone, installState, startInstall } from "../src/services/behaviour/installer";
import { LLM_DIR, MODEL_PATH, installModel, missingVcRuntime, modelVerified, vcRuntimeMessage } from "../src/services/behaviour/runtime";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pidAlive, watchParent } from "../src/parentWatch";

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


// ── logons from the Security log ───────────────────────────────────────────

const logon = (id: number, over: Record<string, string> = {}, eid = 4624) => rec(id, eid, {
  TargetUserName: "alice", TargetDomainName: "CORP", LogonType: "3", AuthenticationPackageName: "NTLM",
  IpAddress: "10.0.0.7", IpPort: "52114", WorkstationName: "KALI", ...over });
const failedLogon = (id: number, over: Record<string, string> = {}) => logon(id, over, 4625);
const NO_LOGONS_NEEDED = logOf([]);

/** Records what each channel was asked for, so a test can see which bookmark went where. */
function spied(sysmon: LogRecord[], security: LogRecord[]) {
  const asked = { sysmon: [] as number[], security: [] as number[] };
  const sources = {
    sysmon: async (after: number, max: number) => { asked.sysmon.push(after); return logOf(sysmon)(after, max); },
    security: async (after: number, max: number) => { asked.security.push(after); return logOf(security)(after, max); },
  };
  return { asked, sources };
}

test("logons are bookmarked apart from Sysmon, because RecordIds are numbered per channel", async () => {
  // Security RecordIds are far larger than Sysmon's here, as they are on a real machine.
  const { asked, sources } = spied([svchost(3), wordShell(4)], [logon(9001), logon(9002, { LogonType: "10" })]);
  decide = bySev;
  const s1 = await scanOnce(25, sources);
  assert.equal(s1.securityBookmark, 9002);
  assert.equal(s1.bookmark, 4);
  assert.equal(s1.classified, 4, "two logon behaviours and two process behaviours");
  const st = await readState();
  assert.deepEqual([st.securityBookmark, st.bookmark], [9002, 4]);

  const s2 = await scanOnce(25, sources);
  assert.equal(s2.read, 0, "nothing new in either channel; neither bookmark was mistaken for the other");
  assert.deepEqual(asked.security, [0, 9002]);
  assert.deepEqual(asked.sysmon, [0, 4]);
});

test("logons are judged first and share the per-scan budget with Sysmon", async () => {
  const { sources } = spied([wordShell(1)], [logon(10)]);
  const s1 = await scanOnce(1, sources);
  assert.equal(s1.classified, 1);
  assert.ok(calls[0]!.includes("EventID: 4624"), "the logon took the one slot");
  assert.deepEqual([s1.deferred, s1.more, s1.bookmark], [true, true, 0], "the process waits for the next scan, unskipped");
  const s2 = await scanOnce(1, sources);
  assert.deepEqual([s2.classified, s2.bookmark], [1, 1]);
  assert.ok(calls[1]!.includes("EventID: 1\n"), "and is judged then");
});

test("when logons spend the whole budget, Sysmon waits for the next scan and says so", async () => {
  const { asked, sources } = spied([wordShell(1)], [logon(10), logon(11, { LogonType: "10" })]);
  const s1 = await scanOnce(1, sources);
  assert.deepEqual([s1.classified, s1.deferred, s1.more], [1, true, true]);
  assert.equal(s1.securityBookmark, 10, "the second logon was not skipped; the bookmark stops before it");
  assert.deepEqual(asked.sysmon, [], "Sysmon was not even read");
  const s2 = await scanOnce(25, sources);
  assert.equal(s2.securityBookmark, 11);
  assert.equal(s2.bookmark, 1);
  assert.equal(s2.classified, 2, "the second logon, then the process");
});

test("a Security log that refuses this account is reported, and Sysmon is still scanned", async () => {
  decide = bySev;
  const sources = {
    sysmon: logOf([wordShell(1), whoami(2)]),
    security: async () => { throw new LogAccessDenied("denied"); },
  };
  const s = await scanOnce(25, sources);
  assert.equal(s.securityUnreadable, true);
  assert.equal(s.classified, 2);
  assert.equal(s.bookmark, 2);
  assert.equal((await readState()).bookmark, 2, "and what was decided was saved");
});

test("any other failure reading logons fails the scan; it is not quietly skipped", async () => {
  const { asked, sources } = spied([wordShell(1)], []);
  const broken = { ...sources, security: async () => { throw new Error("powershell.exe could not be started"); } };
  await assert.rejects(scanOnce(25, broken), /could not be started/);
  assert.deepEqual(asked.sysmon, [], "and Sysmon was not read behind its back");
  assert.equal((await readState()).bookmark, 0);
});

test("a state file from before logons were read still loads, and logons start from the beginning", async () => {
  await writeState({ bookmark: 7, verdicts: {}, outOfDomain: 0 });
  const { asked, sources } = spied([], [logon(40)]);
  const s = await scanOnce(25, sources);
  assert.deepEqual(asked.security, [0]);
  assert.deepEqual(asked.sysmon, [7]);
  assert.equal(s.securityBookmark, 40);
  assert.equal(s.bookmark, 7);
});

test("a full page of logons means more is waiting even when the budget is not spent", async () => {
  const many = Array.from({ length: PAGE }, (_, i) => logon(i + 1));
  const s = await scanOnce(25, { sysmon: NO_LOGONS_NEEDED, security: logOf(many) });
  assert.equal(s.more, true);
  assert.equal(s.securityBookmark, PAGE);
  assert.equal(s.classified, 1, "five hundred identical logons are one behaviour");
  assert.equal(s.known, PAGE - 1);
});

test("a failed logon is a different behaviour from a successful one", async () => {
  const s = await scanOnce(25, { sysmon: NO_LOGONS_NEEDED, security: logOf([logon(1), failedLogon(2)]) });
  assert.equal(s.classified, 2);
  assert.ok(calls.some((c) => c.includes("EventType: Failed Logon")));
});

test("the log query filters logons in the query, reads oldest first, and leaves Sysmon unfiltered", () => {
  const sec = SCRIPT(SECURITY_LOG, 77, 500, SECURITY_EVENT_IDS);
  assert.match(sec, /-LogName 'Security'/);
  assert.match(sec, /-Oldest/, "without it a backlog would come back newest-first and be skipped");
  assert.match(sec, /\(EventID=4624 or EventID=4625\) and EventRecordID > 77/);
  const sys = SCRIPT(SYSMON_LOG, 5, 500, []);
  assert.doesNotMatch(sys, /EventID=/);
  assert.match(sys, /EventRecordID > 5/);
  // an exported capture is read with the same filter, which is how the reader is replayed against real logs
  assert.match(SCRIPT("C:\\caps\\o'brien.evtx", 0, 10, SECURITY_EVENT_IDS), /-Path 'C:\\caps\\o''brien\.evtx'/);
});

// ── monitor ────────────────────────────────────────────────────────────────

const summary = (over: Partial<ScanSummary> = {}): ScanSummary =>
  ({
    read: 0, outOfDomain: 0, known: 0, classified: 0, deferred: false, more: false,
    bookmark: 0, securityBookmark: 0, securityUnreadable: false, ...over,
  });
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

// ── module resolution ──────────────────────────────────────────────────────

test("no module shares its basename with a data file (ts-node-dev would load the .json)", () => {
  // require("./x") tries .json before the .ts that ts-node registers. contract.ts next to contract.json made
  // CONTRACT undefined under `npm run dev`, while tsc, esbuild and pkg -- and so every other test -- were fine.
  // Runs from backend/ (npm run unit), so "src" is the source tree.
  const files = fs.readdirSync("src", { recursive: true }).map((f) => String(f).replace(/\\/g, "/"));
  const stems = (ext: RegExp) => new Set(files.filter((f) => ext.test(f)).map((f) => f.replace(ext, "")));
  const json = stems(/\.json$/);
  const clash = [...stems(/\.tsx?$/)].filter((s) => json.has(s));
  assert.deepEqual(clash, [], `these modules share a name with a .json file: ${clash.join(", ")}`);
});


// ── download ───────────────────────────────────────────────────────────────

type Action =
  | { kind: "ok" }
  | { kind: "ignoreRange" }
  | { kind: "drop"; after: number }       // send `after` bytes, then close the connection cleanly (FIN)
  | { kind: "reset"; after: number }      // send `after` bytes, then reset it (RST): the client may lose what it had not read
  | { kind: "stall"; after: number }
  | { kind: "status"; code: number; headers?: Record<string, string> };

/** A file server that misbehaves on request: plan(n, from) says what to do with the n-th request. */
async function serve(body: Buffer, plan: (n: number, from: number | null) => Action) {
  const requests: { range: string | null }[] = [];
  const srv = http.createServer((req, res) => {
    const n = requests.length;
    const range = req.headers.range ?? null;
    requests.push({ range });
    const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
    const from = m ? Number(m[1]) : null;
    const a = plan(n, from);
    if (a.kind === "status") { res.writeHead(a.code, a.headers ?? {}); res.end(); return; }
    const honour = a.kind !== "ignoreRange" && from !== null && from > 0;
    const slice = honour ? body.subarray(from!) : body;
    if (honour) res.writeHead(206, { "Content-Range": `bytes ${from}-${body.length - 1}/${body.length}`, "Content-Length": String(slice.length) });
    else res.writeHead(200, { "Content-Length": String(slice.length) });
    if (a.kind === "drop" || a.kind === "reset" || a.kind === "stall") {
      res.write(slice.subarray(0, a.after));
      if (a.kind === "drop") setTimeout(() => res.socket?.end(), 20);
      if (a.kind === "reset") setTimeout(() => res.socket?.destroy(), 20);
      return;                                     // "stall": say nothing more and keep the socket open
    }
    res.end(slice);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/file.bin`, requests,
    close: () => { srv.closeAllConnections(); srv.close(); },
  };
}

const PAYLOAD = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff));
const FAST_DL = { stallMs: 150, retryMs: 5 };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "osava-dl-"));

test("download: fetches a file and reports progress up to the full size", async () => {
  const s = await serve(PAYLOAD, () => ({ kind: "ok" }));
  const dest = path.join(tmpdir(), "a.bin");
  const seen: [number, number | null][] = [];
  try {
    await download(s.url, dest, { ...FAST_DL, onProgress: (r, t) => seen.push([r, t]) });
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.equal(fs.existsSync(`${dest}.part`), false, "the partial file is renamed away");
    assert.deepEqual(seen.at(-1), [PAYLOAD.length, PAYLOAD.length]);
    assert.ok(seen.every(([r], i) => i === 0 || r >= seen[i - 1]![0]), "progress never goes backwards");
  } finally { s.close(); }
});

test("download: a dropped connection resumes from the partial file with a Range request", async () => {
  const s = await serve(PAYLOAD, (n) => (n === 0 ? { kind: "drop", after: 100_000 } : { kind: "ok" }));
  const dest = path.join(tmpdir(), "b.bin");
  try {
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD, "the stitched file is byte-identical");
    assert.equal(s.requests.length, 2);
    const from = Number(/^bytes=(\d+)-$/.exec(s.requests[1]!.range ?? "")?.[1]);
    assert.ok(from > 0 && from < PAYLOAD.length, `the retry asked for the rest, not everything (${s.requests[1]!.range})`);
  } finally { s.close(); }
});

test("download: an abrupt reset, which may lose what had not been read yet, still ends in a correct file", async () => {
  const s = await serve(PAYLOAD, (n) => (n === 0 ? { kind: "reset", after: 100_000 } : { kind: "ok" }));
  const dest = path.join(tmpdir(), "b2.bin");
  try {
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.equal(s.requests.length, 2, "one retry");
    // Whether the retry could resume depends on how much the reset let through; either way it is whole.
    const r = s.requests[1]!.range;
    assert.ok(r === null || /^bytes=\d+-$/.test(r), `unexpected Range header ${r}`);
  } finally { s.close(); }
});

test("download: a server that ignores Range makes it start over, and it still finishes correctly", async () => {
  const s = await serve(PAYLOAD, (n) => (n === 0 ? { kind: "drop", after: 50_000 } : { kind: "ignoreRange" }));
  const dest = path.join(tmpdir(), "c.bin");
  try {
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD, "no half-file glued onto a full one");
  } finally { s.close(); }
});

test("download: a stalled connection is abandoned and resumed instead of hanging", async () => {
  const s = await serve(PAYLOAD, (n) => (n === 0 ? { kind: "stall", after: 60_000 } : { kind: "ok" }));
  const dest = path.join(tmpdir(), "d.bin");
  const t0 = Date.now();
  try {
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.ok(Date.now() - t0 < 5_000, "it did not wait out the stall");
  } finally { s.close(); }
});

test("download: a 404 is final, a 503 is retried", async () => {
  const gone = await serve(PAYLOAD, () => ({ kind: "status", code: 404 }));
  try {
    await assert.rejects(download(gone.url, path.join(tmpdir(), "e.bin"), FAST_DL),
      (e: unknown) => e instanceof DownloadError && e.kind === "HTTP" && e.status === 404);
    assert.equal(gone.requests.length, 1, "no point asking again");
  } finally { gone.close(); }

  const flaky = await serve(PAYLOAD, (n) => (n < 2 ? { kind: "status", code: 503 } : { kind: "ok" }));
  const dest = path.join(tmpdir(), "f.bin");
  try {
    await download(flaky.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.equal(flaky.requests.length, 3);
  } finally { flaky.close(); }
});

test("download: gives up after repeated failures that make no progress", async () => {
  const s = await serve(PAYLOAD, () => ({ kind: "status", code: 500 }));
  try {
    await assert.rejects(download(s.url, path.join(tmpdir(), "g.bin"), { ...FAST_DL, attempts: 3 }),
      (e: unknown) => e instanceof DownloadError && e.kind === "HTTP" ? false : e instanceof DownloadError && e.kind === "NETWORK");
    assert.equal(s.requests.length, 3);
  } finally { s.close(); }
});

test("download: refuses a drive without room, before a byte is written", async () => {
  const s = await serve(PAYLOAD, () => ({ kind: "ok" }));
  const dest = path.join(tmpdir(), "h.bin");
  try {
    await assert.rejects(download(s.url, dest, { ...FAST_DL, freeBytes: async () => 1_000 }),
      (e: unknown) => e instanceof DownloadError && e.kind === "NO_SPACE" && /free disk space/.test(e.message));
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.equal(s.requests.length, 1, "no retry loop on a full disk");
  } finally { s.close(); }
});

test("download: cancelling keeps the partial file, and the next call resumes it", async () => {
  const s = await serve(PAYLOAD, () => ({ kind: "ok" }));
  const dest = path.join(tmpdir(), "i.bin");
  const ctl = new AbortController();
  try {
    await assert.rejects(download(s.url, dest, { ...FAST_DL, signal: ctl.signal, onProgress: (r) => { if (r > 10_000) ctl.abort(); } }),
      (e: unknown) => e instanceof DownloadError && e.kind === "CANCELLED");
    const kept = fs.statSync(`${dest}.part`).size;
    assert.ok(kept > 0 && kept < PAYLOAD.length, "something was kept, but not everything");
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.equal(s.requests.at(-1)!.range, `bytes=${kept}-`, "the second call resumed exactly where the first stopped");
  } finally { s.close(); }
});

test("download: a partial file that is already whole is accepted without fetching it again", async () => {
  const s = await serve(PAYLOAD, () => ({ kind: "status", code: 416, headers: { "Content-Range": `bytes */${PAYLOAD.length}` } }));
  const dest = path.join(tmpdir(), "j.bin");
  fs.writeFileSync(`${dest}.part`, PAYLOAD);
  try {
    await download(s.url, dest, FAST_DL);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
    assert.equal(s.requests.length, 1);
  } finally { s.close(); }
});


// ── installing the model ───────────────────────────────────────────────────

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Point the contract at a small stand-in "model" served locally, run `fn`, and put the contract back. */
async function withFakeModel(body: Buffer, served: Buffer, fn: (s: Awaited<ReturnType<typeof serve>>) => Promise<void>) {
  const s = await serve(served, () => ({ kind: "ok" }));
  const m = CONTRACT.model;
  const saved = { ...m };
  fs.rmSync(LLM_DIR, { recursive: true, force: true });
  m.gguf_sha256 = sha(body); m.gguf_bytes = body.length; m.url = s.url;
  try { await fn(s); } finally { Object.assign(m, saved); if (saved.url === undefined) delete m.url; s.close(); }
}

test("installModel: downloads, verifies, remembers, and is instant the second time", async () => {
  await withFakeModel(PAYLOAD, PAYLOAD, async (s) => {
    const labels = new Set<string>(); let last: [number, number | null] = [0, null];
    assert.equal(await modelVerified(), false, "nothing there yet");
    const how = await installModel({ report: (l, d, t) => { labels.add(l); if (l.startsWith("Downloading")) last = [d, t]; } });
    assert.equal(how, "download");
    assert.deepEqual(fs.readFileSync(MODEL_PATH), PAYLOAD);
    assert.deepEqual(last, [PAYLOAD.length, PAYLOAD.length]);
    assert.ok(labels.has("Downloading the model") && labels.has("Checking the model file"));
    assert.equal(await modelVerified(), true);

    const before = s.requests.length;
    assert.equal(await installModel(), "present");
    assert.equal(s.requests.length, before, "a verified file is not fetched, or even re-hashed, again");
  });
});

test("installModel: a file copied in by hand is present but unverified until Install checks it", async () => {
  await withFakeModel(PAYLOAD, PAYLOAD, async (s) => {
    fs.mkdirSync(LLM_DIR, { recursive: true });
    fs.writeFileSync(MODEL_PATH, PAYLOAD);
    assert.equal(fs.existsSync(MODEL_PATH), true);
    assert.equal(await modelVerified(), false, "present is not the same as verified");
    assert.equal(await installModel(), "present");
    assert.equal(await modelVerified(), true);
    assert.equal(s.requests.length, 0, "the right file was already there; nothing was downloaded");
  });
});

test("installModel: a corrupted or swapped file is replaced, not trusted", async () => {
  await withFakeModel(PAYLOAD, PAYLOAD, async () => {
    assert.equal(await installModel(), "download");
    // same size, different bytes, new mtime: exactly what a bad copy looks like
    const bad = Buffer.from(PAYLOAD); bad[1000] = ~(PAYLOAD[1000] ?? 0) & 0xff;
    fs.writeFileSync(MODEL_PATH, bad);
    fs.utimesSync(MODEL_PATH, new Date(), new Date(Date.now() + 5_000));
    assert.equal(await modelVerified(), false, "the record is keyed on size and mtime, so the swap is noticed");
    assert.equal(await installModel(), "download", "and it is fetched again");
    assert.deepEqual(fs.readFileSync(MODEL_PATH), PAYLOAD);
  });
});

test("installModel: a download that is not the expected file is deleted and reported", async () => {
  const wrong = Buffer.from(PAYLOAD); wrong[5] = ~(PAYLOAD[5] ?? 0) & 0xff;
  await withFakeModel(PAYLOAD, wrong, async () => {
    await assert.rejects(installModel(), /did not match its checksum and was deleted/);
    assert.equal(fs.existsSync(MODEL_PATH), false);
    assert.equal(await modelVerified(), false);
  });
});

test("installModel: with no file and no URL it says exactly what to do", async () => {
  await withFakeModel(PAYLOAD, PAYLOAD, async () => {
    delete CONTRACT.model.url;
    await assert.rejects(installModel(), (e: unknown) => e instanceof ModelUnavailable && /Put osava-smollm-q4\.gguf/.test(e.message) && e.message.includes(LLM_DIR));
  });
});

// ── the install job ────────────────────────────────────────────────────────

test("install job: runs both steps in order, reports progress, and ends done", async () => {
  const order: string[] = [];
  startInstall({
    server: async (h) => { order.push("server"); h.report?.("Downloading llama.cpp", 10, 100); assert.equal(installState().phase, "running"); assert.equal(installState().label, "Downloading llama.cpp"); },
    model: async (h) => { order.push("model"); h.report?.("Downloading the model", 50, 100); assert.equal(installState().received, 50); },
  });
  await installDone();
  assert.deepEqual(order, ["server", "model"]);
  assert.deepEqual([installState().phase, installState().error], ["done", null]);
});

test("install job: pressing Install again while it runs joins it instead of starting a second", async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const steps = { server: async () => { calls++; await gate; }, model: async () => {} };
  startInstall(steps);
  startInstall(steps);
  startInstall(steps);
  release();
  await installDone();
  assert.equal(calls, 1);
});

test("install job: a failure is kept, with a code the UI can act on", async () => {
  startInstall({ server: async () => {}, model: async () => { throw new ModelUnavailable("not installed"); } });
  await installDone();
  assert.deepEqual(installState().error, { code: "MODEL_UNAVAILABLE", message: "not installed" });
  assert.equal(installState().phase, "error");
  startInstall({ server: async () => { throw new DownloadError("NO_SPACE", "Not enough free disk space"); }, model: async () => {} });
  await installDone();
  assert.equal(installState().error?.code, "NO_SPACE");
});

test("install job: stopping it is not a failure, and says what happens next", async () => {
  startInstall({
    server: (h) => new Promise((_, reject) => h.signal?.addEventListener("abort", () => reject(new DownloadError("CANCELLED", "Cancelled.")))),
    model: async () => {},
  });
  assert.equal(installState().phase, "running");
  cancelInstall();
  await installDone();
  assert.equal(installState().phase, "idle");
  assert.equal(installState().error, null);
  assert.match(installState().label, /Stopped.*continues from there/);
  // and it can be started again
  startInstall({ server: async () => {}, model: async () => {} });
  await installDone();
  assert.equal(installState().phase, "done");
});


// ── the Visual C++ runtime that llama.cpp needs ────────────────────────────

test("missingVcRuntime: names exactly the DLLs a clean Windows would lack, and the message says what to do", () => {
  const dir = tmpdir();
  assert.deepEqual(missingVcRuntime(dir).sort(), ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
  fs.writeFileSync(path.join(dir, "vcruntime140.dll"), "");
  fs.writeFileSync(path.join(dir, "msvcp140.dll"), "");
  assert.deepEqual(missingVcRuntime(dir), ["vcruntime140_1.dll"]);
  fs.writeFileSync(path.join(dir, "vcruntime140_1.dll"), "");
  assert.deepEqual(missingVcRuntime(dir), []);
  const msg = vcRuntimeMessage(["vcruntime140.dll"]);
  assert.match(msg, /Visual C\+\+ Redistributable \(x64\)/);
  assert.match(msg, /https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
  assert.match(msg, /press Install model again/);
});


// ── leaving when the window is gone ────────────────────────────────────────

test("parent watch: a running process is alive, a finished one is not (a real child, not a stub)", async () => {
  assert.equal(pidAlive(process.pid), true);
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((r) => child.once("exit", r));
  assert.equal(pidAlive(pid), false);
});

test("parent watch: calls back once when the process goes, and not before", async () => {
  let up = true, gone = 0;
  watchParent(1234, () => gone++, { intervalMs: 5, alive: () => up });
  await sleep(40);
  assert.equal(gone, 0, "left while its parent was still there");
  up = false;
  await until(() => gone > 0);
  await sleep(40);
  assert.equal(gone, 1, "must fire exactly once");
});

test("parent watch: stopping it means it never calls back", async () => {
  let gone = 0;
  const stop = watchParent(1234, () => gone++, { intervalMs: 5, alive: () => false });
  stop();
  await sleep(40);
  assert.equal(gone, 0);
});

test("parent watch: a process we may not signal still counts as alive (EPERM is not ESRCH)", () => {
  const real = process.kill;
  try {
    process.kill = (() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }) as typeof process.kill;
    assert.equal(pidAlive(4242), true);
    process.kill = (() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }) as typeof process.kill;
    assert.equal(pidAlive(4242), false);
  } finally { process.kill = real; }
});
