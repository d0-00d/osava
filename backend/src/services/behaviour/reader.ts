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

export class LogAccessDenied extends Error {}

// EventData goes into an [ordered] dictionary on purpose: the converter keeps
// the FIRST occurrence of each field, exactly as training did, so field order
// from the log must survive the trip. A plain @{} hashtable scrambles it.
const SCRIPT = (after: number, max: number) => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $ev = Get-WinEvent -LogName '${SYSMON_LOG}' -MaxEvents ${max} -FilterXPath '*[System[EventRecordID > ${after}]]'
} catch [Exception] {
  if ($_.Exception.Message -match 'No events were found') { '[]'; exit 0 }
  if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.Message -match 'unauthorized') { 'ACCESS_DENIED'; exit 0 }
  throw
}
$out = foreach ($e in $ev) {
  $x = [xml]$e.ToXml()
  $d = [ordered]@{}
  foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
  [pscustomobject]@{ recordId = $e.RecordId; eid = $e.Id; time = $e.TimeCreated.ToUniversalTime().ToString('o'); data = $d }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

/** Records after `afterRecordId`, oldest first, at most `max`. */
export async function readSysmon(afterRecordId: number, max = 500): Promise<LogRecord[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT(Math.max(0, Math.floor(afterRecordId)), max)],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (text === "ACCESS_DENIED") {
    throw new LogAccessDenied(
      "Cannot read the Sysmon log. Install Sysmon from OSAVA (it adds you to Event Log Readers), then sign out and back in."
    );
  }
  const recs = JSON.parse(text || "[]") as LogRecord[];
  // Get-WinEvent returns newest first; process oldest first so the bookmark only moves forward.
  return recs.sort((a, b) => a.recordId - b.recordId);
}
