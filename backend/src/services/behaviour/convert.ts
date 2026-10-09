// ─────────────────────────────────────────────────────────────
// Raw Windows event -> contract body.
//
// A line-for-line port of the two Python functions that produced every
// training example: evtx_to_contract.parse_record() and contract.render()
// with the "backfill" signature policy. It is parity-tested against them on
// thousands of real Sysmon records (parity/); if you change anything here,
// rerun that test, because a converter that differs from training in any
// detail feeds the model inputs it never learned from — silently.
// ─────────────────────────────────────────────────────────────

import { CONTRACT } from "./contractSpec";
import { pyLen, pySlice, pyStrip } from "./pystr";

const C = CONTRACT.conversion;
const I = CONTRACT.input;
const SIG = C.signature_backfill;

/** One record as the event log hands it over: EventID + EventData Name->text. */
export interface RawEvent {
  eid: number;
  /** Must preserve document order: the first occurrence of a field wins. */
  data: Record<string, string | null | undefined>;
}

export type Fields = Record<string, string>;

/** Port of evtx_to_contract.parse_record(). Returns null when unusable. */
export function parseRecord(ev: RawEvent): Fields | null {
  const type = C.event_types[String(ev.eid)];
  if (type === undefined) return null;
  const out: Fields = { EventID: String(ev.eid), EventType: type };

  for (const [name, text] of Object.entries(ev.data ?? {})) {
    const target = C.field_map[name];
    if (!target || !text) continue;
    const val = pyStrip(text);
    if (val && !C.null_values.includes(val) && !(target in out)) out[target] = val;
  }

  const status = out["SignatureStatus"];
  delete out["SignatureStatus"];
  if (status) {
    out["Signed"] = status.toLowerCase() === "valid" ? "true" : "false";
  } else if ("Signer" in out && !("Signed" in out)) {
    out["Signed"] = "true";
  }

  // parse_record truncates with "..." BEFORE render() undoes %% and applies
  // the real marker. The order matters: a command line with %% near the
  // boundary comes out differently if the two steps are merged.
  const cl = out["CommandLine"];
  if (cl !== undefined && pyLen(cl) > I.max_cmdline) {
    out["CommandLine"] = pySlice(cl, I.max_cmdline) + "...";
  }

  if (!["Image", "TargetFilename", "DestinationIp", "User"].some((k) => k in out)) return null;
  return out;
}

/** Port of contract.normalise_cmdline(). */
function normaliseCmdline(s: string): string {
  s = s.split("%%").join("%");
  return pyLen(s) > I.max_cmdline ? pySlice(s, I.max_cmdline) + I.truncation_marker : s;
}

/** Port of contract.signature_for(): (Signed, Signer) from the image path. */
function signatureFor(image: string | undefined): [string, string | null] | null {
  if (!image) return null;
  const low = image.toLowerCase();
  const base = image.includes("\\") ? image.slice(image.lastIndexOf("\\") + 1) : image;
  const vendor = SIG.vendor_signers[base];
  if (vendor !== undefined) return ["true", vendor];
  if ([...SIG.writable_windows_dirs, ...SIG.unsigned_prefixes].some((p) => low.startsWith(p))) {
    return ["false", null];
  }
  if (SIG.system_dirs.some((p) => low.startsWith(p)) || low.startsWith("c:\\windows\\")) {
    return ["true", SIG.microsoft_signer];
  }
  return ["false", null];
}

/** Port of contract.render(fields, "backfill"). */
export function render(fields: Fields): string {
  const f: Fields = { ...fields };
  const eid = Number(f["EventID"]);
  if (!("EventType" in f)) f["EventType"] = C.event_types[String(eid)] ?? "";
  for (const k of ["CommandLine", "ParentCommandLine"]) {
    if (k in f) f[k] = normaliseCmdline(String(f[k]));
  }
  if (!C.signature_eids.includes(eid)) {
    delete f["Signed"];
    delete f["Signer"];
  } else if (!("Signed" in f)) {
    const sig = signatureFor(f["Image"]);
    if (sig) {
      f["Signed"] = sig[0];
      if (sig[1]) f["Signer"] = sig[1];
    }
  }
  const unknown = Object.keys(f).filter((k) => !I.field_order.includes(k));
  if (unknown.length) throw new Error(`off-contract fields: ${unknown.sort().join(", ")}`);
  return I.field_order
    .filter((k) => k in f && f[k] !== null && f[k] !== undefined)
    .map((k) => `${k}: ${f[k]}`)
    .join("\n");
}

/** Raw event -> contract body, or null if unusable or outside the model's domain. */
export function toContractBody(ev: RawEvent): string | null {
  // The model was trained on these EventIDs only. The parser accepts more,
  // and a live Sysmon feed produces them in volume (DNS queries, process
  // access); out of distribution the model answers "none" instead of
  // declining, so they must never reach it.
  if (!I.supported_event_ids.includes(ev.eid)) return null;
  const fields = parseRecord(ev);
  return fields ? render(fields) : null;
}
