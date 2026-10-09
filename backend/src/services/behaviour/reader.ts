// ─────────────────────────────────────────────────────────────
// Read new Sysmon records from the Windows event log.
//
// Reading Microsoft-Windows-Sysmon/Operational needs administrator rights OR
// membership of BUILTIN\Event Log Readers (S-1-5-32-573) -- the channel's
// ACL grants that group read. OSAVA's backend runs unelevated, so the
// elevated Sysmon install step adds the user to that group instead of running
// the whole backend as admin. The group takes effect at next sign-in.
// ─────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawEvent } from "./convert";

const execFileAsync = promisify(execFile);
export const SYSMON_LOG = "Microsoft-Windows-Sysmon/Operational";

export interface LogRecord extends RawEvent {
  recordId: number;
  time: string;
}

/** The log exists but this account may not read it (yet). */
export class LogAccessDenied extends Error {}
/** There is no such log: Sysmon is not installed, or its service never ran. */
export class LogMissing extends Error {}

// EventData goes into an [ordered] dictionary on purpose: the converter keeps
// the FIRST occurrence of each field, exactly as training did, so field order
// from the log must survive the trip. A plain @{} hashtable scrambles it.
//
// -Oldest is load-bearing. Get-WinEvent walks a live log newest-first and
// applies -MaxEvents to that order, so without it a backlog larger than `max`
// comes back as the NEWEST `max` records; the pipeline then moves its bookmark
// to the newest of them and every older pending record is skipped for good.
// Oldest-first makes a backlog drain in order, `max` records per scan.
//
// The three expected failures are told apart by exception type / error id,
// not by message text, so they hold on a Windows that is not in English. Each
// was observed, not assumed: no events = NoMatchingEventsFound, no such log =
// NoMatchingLogsFound (both plain System.Exception), no access =
// System.UnauthorizedAccessException.
//
// `log` is a channel name, or the path of an exported .evtx: the same reader can
// then be replayed against a capture, which is how it is checked against the
// Python that built the training data without needing the live log.
const SCRIPT = (log: string, after: number, max: number) => {
  const q = log.replace(/'/g, "''");
  const source = /\.evtx$/i.test(log) ? `-Path '${q}'` : `-LogName '${q}'`;
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $ev = Get-WinEvent ${source} -Oldest -MaxEvents ${max} -FilterXPath '*[System[EventRecordID > ${after}]]'
} catch [Exception] {
  if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound' -or $_.Exception.Message -match 'No events were found') { '[]'; exit 0 }
  if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.Message -match 'unauthorized') { 'ACCESS_DENIED'; exit 0 }
  if ($_.FullyQualifiedErrorId -match 'NoMatchingLogsFound') { 'LOG_MISSING'; exit 0 }
  throw
}
$out = foreach ($e in $ev) {
  $x = [xml]$e.ToXml()
  $d = [ordered]@{}
  foreach ($n in $x.Event.EventData.Data) { if ($n.Name) { $d[$n.Name] = $n.'#text' } }
  [pscustomobject]@{ recordId = $e.RecordId; eid = $e.Id; time = $e.TimeCreated.ToUniversalTime().ToString('o'); data = $d }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;
};

/** Records after `afterRecordId`, oldest first, at most `max`. Production
 *  always reads the Sysmon channel; `log` is the seam described above. */
export async function readSysmon(afterRecordId: number, max = 500, log = SYSMON_LOG): Promise<LogRecord[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT(log, Math.max(0, Math.floor(afterRecordId)), max)],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (text === "ACCESS_DENIED") {
    throw new LogAccessDenied(
      "Cannot read the Sysmon log. Install Sysmon from OSAVA (it adds you to Event Log Readers), then sign out and back in."
    );
  }
  if (text === "LOG_MISSING") {
    throw new LogMissing("There is no Sysmon log on this machine. Install Sysmon from OSAVA, and make sure its service is running.");
  }
  const recs = JSON.parse(text || "[]") as LogRecord[];
  // Already oldest-first (-Oldest); sorted anyway because the bookmark must
  // only ever move forward and the pipeline relies on it.
  return recs.sort((a, b) => a.recordId - b.recordId);
}

/**
 * Can this process read the Sysmon log, right now? Asks for records past any
 * RecordId that exists, so nothing is parsed -- it only learns whether the
 * log opens. "unknown" is anything else going wrong (PowerShell itself failing).
 */
export async function probeSysmon(): Promise<"readable" | "denied" | "missing" | "unknown"> {
  try {
    await readSysmon(Number.MAX_SAFE_INTEGER, 1);
    return "readable";
  } catch (e) {
    if (e instanceof LogAccessDenied) return "denied";
    if (e instanceof LogMissing) return "missing";
    return "unknown";
  }
}
