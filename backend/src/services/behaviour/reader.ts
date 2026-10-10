// ─────────────────────────────────────────────────────────────
// Read new Sysmon records, and logon records from the Security log, from the
// Windows event log.
//
// Reading Microsoft-Windows-Sysmon/Operational needs administrator rights OR
// membership of BUILTIN\Event Log Readers (S-1-5-32-573) -- the channel's
// ACL grants that group read. OSAVA's backend runs unelevated, so the
// elevated Sysmon install step adds the user to that group instead of running
// the whole backend as admin. The group takes effect at next sign-in. The
// Security channel's ACL grants the same group, (A;;0x1;;;S-1-5-32-573), so one
// membership opens both.
// ─────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawEvent } from "./convert";

const execFileAsync = promisify(execFile);
export const SYSMON_LOG = "Microsoft-Windows-Sysmon/Operational";
export const SECURITY_LOG = "Security";

// The Security log is a firehose (4672, 4634, 5379, ...) and the model judges
// only logons, so they are filtered in the query rather than read and dropped,
// which would spend each page on events it cannot classify. The logon
// vocabulary (interactive, kerberos, failed, ...) is derived from LogonType and
// the authentication package inside these two events, so it needs no more.
export const SECURITY_EVENT_IDS = [4624, 4625];

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
export const SCRIPT = (log: string, after: number, max: number, eventIds: number[]) => {
  const q = log.replace(/'/g, "''");
  const source = /\.evtx$/i.test(log) ? `-Path '${q}'` : `-LogName '${q}'`;
  const ids = eventIds.length ? `(${eventIds.map((id) => `EventID=${id}`).join(" or ")}) and ` : "";
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $ev = Get-WinEvent ${source} -Oldest -MaxEvents ${max} -FilterXPath '*[System[${ids}EventRecordID > ${after}]]'
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

/** Records in `log` after `afterRecordId`, oldest first, at most `max`; `eventIds` limits which events
 *  (empty: all of them). `label` names the log to a person when it cannot be read. */
async function readChannel(
  log: string, label: string, afterRecordId: number, max: number, eventIds: number[],
): Promise<LogRecord[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT(log, Math.max(0, Math.floor(afterRecordId)), Math.max(1, Math.floor(max)), eventIds)],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (text === "ACCESS_DENIED") {
    throw new LogAccessDenied(
      `Cannot read the ${label} log. Your account must be in the Event Log Readers group and must have signed in since it was added; the Behaviour tab can add you.`
    );
  }
  if (text === "LOG_MISSING") {
    throw new LogMissing(label === "Sysmon"
      ? "There is no Sysmon log on this machine. Install Sysmon from OSAVA, and make sure its service is running."
      : `There is no ${label} log on this machine.`);
  }
  const recs = JSON.parse(text || "[]") as LogRecord[];
  // Already oldest-first (-Oldest); sorted anyway because the bookmark must
  // only ever move forward and the pipeline relies on it.
  return recs.sort((a, b) => a.recordId - b.recordId);
}

/** Sysmon records after `afterRecordId`, oldest first, at most `max`. Production
 *  always reads the Sysmon channel; `log` is the seam described above. */
export function readSysmon(afterRecordId: number, max = 500, log = SYSMON_LOG): Promise<LogRecord[]> {
  return readChannel(log, "Sysmon", afterRecordId, max, []);
}

/** Logon records (4624 / 4625) from the Security log after `afterRecordId`, oldest first, at most `max`.
 *  RecordIds are numbered per channel, so this has its own bookmark. */
export function readSecurity(afterRecordId: number, max = 500, log = SECURITY_LOG): Promise<LogRecord[]> {
  return readChannel(log, "Security", afterRecordId, max, SECURITY_EVENT_IDS);
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
