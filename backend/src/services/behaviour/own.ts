// ─────────────────────────────────────────────────────────────
// OSAVA watching OSAVA.
//
// The backend reads the log through PowerShell, checks Sysmon's status through
// PowerShell, runs llama-server, and Sysmon records all of it. Judged like
// anything else, OSAVA's own log reader came out "High: execution policy
// bypassed", and every PowerShell start writes a __PSScriptPolicyTest_<random>.ps1
// that never deduplicates. None of it is something a person needs to look at,
// so it is skipped before the model, and counted (ScanSummary.own) rather than
// dropped silently.
//
// What is OSAVA's is decided from the log itself, by lineage. Sysmon gives each
// process a ProcessGuid that, unlike a PID, is never reused:
//   * a process created by this backend: ParentProcessId is our pid AND
//     ParentImage is our executable (a PID alone could be recycled);
//   * in the packaged app, a process created by any osava-backend.exe at our
//     path, so what a previous run left in the backlog is recognised too;
//   * a process created by one of those (PowerShell started through a shell);
//   * the backend's own creation.
// Every event whose ProcessGuid is one of those is OSAVA's. A child's creation
// is logged before anything it does, and the log is read in order, so lineage
// is known by the time its events arrive.
// ─────────────────────────────────────────────────────────────

import type { LogRecord } from "./reader";

export interface Self {
  pid: number;
  /** Full path of the executable running this backend. */
  exe: string;
  /** The packaged sidecar: its path is OSAVA's alone, so it identifies OSAVA without the pid. */
  packaged: boolean;
}

/** How many process GUIDs to remember. A scan sees a handful of OSAVA's processes; this is days of them. */
const MAX_GUIDS = 4096;

type Field = string | null | undefined;
const guid = (g: Field) => (g ?? "").trim().replace(/^\{|\}$/g, "").toLowerCase();
const samePath = (a: Field, b: string) =>
  !!a && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
const pidOf = (p: Field) => (/^\d+$/.test((p ?? "").trim()) ? Number(p) : -1);

export function createOwnTracker(self: Self) {
  const own = new Set<string>();
  const remember = (g: string) => {
    if (!g) return;
    own.delete(g);
    own.add(g);
    if (own.size > MAX_GUIDS) own.delete(own.values().next().value as string);
  };
  const isSelf = (pid: Field, image: Field) =>
    samePath(image, self.exe) && (self.packaged || pidOf(pid) === self.pid);

  return {
    /** Is this record OSAVA's own doing? Learns lineage from process creations as it goes. */
    claims(r: LogRecord): boolean {
      const d = r.data ?? {};
      if (r.eid === 1) {
        const mine = isSelf(d["ProcessId"], d["Image"]) ||
          isSelf(d["ParentProcessId"], d["ParentImage"]) ||
          own.has(guid(d["ParentProcessGuid"]));
        if (mine) remember(guid(d["ProcessGuid"]));
        return mine;
      }
      const g = guid(d["ProcessGuid"]);
      if (g && own.has(g)) return true;
      // An event by the backend itself, when its own creation was before what we read.
      if (isSelf(d["ProcessId"], d["Image"])) { remember(g); return true; }
      return false;
    },
    /** For tests and diagnostics. */
    size: () => own.size,
  };
}

/** This backend: pkg sets process.pkg in the packaged sidecar. */
export const SELF: Self = {
  pid: process.pid,
  exe: process.execPath,
  packaged: !!(process as unknown as { pkg?: unknown }).pkg,
};

export const ownTracker = createOwnTracker(SELF);
