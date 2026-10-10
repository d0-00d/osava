// Read new Sysmon records, keep the ones the model can judge, and classify
// each NEW behaviour once. Known behaviours only bump a counter: a working
// machine's 52,791 benign events collapsed to 1,788 signatures, so after a
// warm-up the model is called on a small fraction of what Sysmon produces.

import { CONTRACT } from "./contractSpec";
import { classify } from "./classifier";
import { toContractBody } from "./convert";
import { readSysmon, type LogRecord } from "./reader";
import { baseUrl, currentApiKey } from "./runtime";
import { parseBody, signature } from "./signature";
import { readState, writeState } from "./store";

/** Records read from the log per scan. */
export const PAGE = 500;

export interface ScanSummary {
  read: number;
  outOfDomain: number;
  known: number;
  classified: number;
  /** new behaviours left for the next scan (per-scan budget reached) */
  deferred: boolean;
  /** more is waiting right now (budget reached, or the log page came back full) */
  more: boolean;
  bookmark: number;
}

/** Where records come from. The Sysmon log in production; a script in tests. */
export type Source = (afterRecordId: number, max: number) => Promise<LogRecord[]>;

let inflight: Promise<ScanSummary> | null = null;

/** Is a scan running right now (from the monitor or a manual one)? */
export const scanning = (): boolean => inflight !== null;

/**
 * Scan once. Only one scan runs at a time: a second caller (the UI's Scan
 * button during a monitor tick, say) gets the scan already in progress rather
 * than a second one reading the same bookmark and classifying the same
 * behaviours twice. It therefore also gets that scan's `maxNew`.
 */
export function scanOnce(maxNew = 25, source: Source = readSysmon): Promise<ScanSummary> {
  if (!inflight) {
    const p = run(maxNew, source);
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
  }
  return inflight;
}

async function run(maxNew: number, source: Source): Promise<ScanSummary> {
  const st = await readState();
  const recs = await source(st.bookmark, PAGE);
  const sum: ScanSummary = {
    read: recs.length, outOfDomain: 0, known: 0, classified: 0,
    deferred: false, more: recs.length >= PAGE, bookmark: st.bookmark,
  };
  const model = CONTRACT.model.gguf_sha256;
  let dirty = false;

  // Whatever happens below -- the model times out on record 20 of 25 -- what
  // was decided so far is saved together with the bookmark that goes with it.
  // The bookmark only advances past a record once that record is fully
  // handled, so a partial save is always consistent and the next scan resumes
  // at the record that failed instead of re-deciding the ones before it.
  try {
    for (const r of recs) {
      const body = toContractBody(r);
      if (body === null) {
        if (!CONTRACT.input.supported_event_ids.includes(r.eid)) sum.outOfDomain++;
        st.bookmark = r.recordId;
        dirty = true;
        continue;
      }
      const sig = signature(parseBody(body));
      const seen = st.verdicts[sig];
      // A verdict is a claim by one specific model. After a model upgrade the
      // old claims must not stand just because the behaviour was seen first.
      if (seen && seen.modelSha256 === model) {
        seen.count++;
        seen.lastSeen = r.time;
        sum.known++;
        st.bookmark = r.recordId;
        dirty = true;
        continue;
      }
      if (sum.classified >= maxNew) {
        // stop here WITHOUT advancing the bookmark, so this record and the rest
        // are read again next scan instead of being skipped
        sum.deferred = true;
        sum.more = true;
        break;
      }
      const v = await classify(body, { baseUrl: baseUrl(), apiKey: currentApiKey() });
      st.verdicts[sig] = {
        ...v, signature: sig, sample: body,
        firstSeen: seen?.firstSeen ?? r.time, lastSeen: r.time, count: (seen?.count ?? 0) + 1,
      };
      sum.classified++;
      st.bookmark = r.recordId;
      dirty = true;
    }
  } finally {
    st.outOfDomain += sum.outOfDomain;
    sum.bookmark = st.bookmark;
    if (dirty) await writeState(st);
  }
  return sum;
}
