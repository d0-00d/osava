// Read new Sysmon records, keep the ones the model can judge, and classify
// each NEW behaviour once. Known behaviours only bump a counter: a working
// machine's 52,791 benign events collapsed to 1,788 signatures, so after a
// warm-up the model is called on a small fraction of what Sysmon produces.

import { CONTRACT } from "./contractSpec";
import { classify } from "./classifier";
import { toContractBody } from "./convert";
import { readSysmon } from "./reader";
import { baseUrl, currentApiKey } from "./runtime";
import { parseBody, signature } from "./signature";
import { readState, writeState } from "./store";

export interface ScanSummary {
  read: number;
  outOfDomain: number;
  known: number;
  classified: number;
  /** new behaviours left for the next scan (per-scan budget reached) */
  deferred: boolean;
  bookmark: number;
}

export async function scanOnce(maxNew = 25): Promise<ScanSummary> {
  const st = await readState();
  const recs = await readSysmon(st.bookmark, 500);
  const sum: ScanSummary = { read: recs.length, outOfDomain: 0, known: 0, classified: 0, deferred: false, bookmark: st.bookmark };

  for (const r of recs) {
    const body = toContractBody(r);
    if (body === null) {
      if (!CONTRACT.input.supported_event_ids.includes(r.eid)) sum.outOfDomain++;
      st.bookmark = r.recordId;
      continue;
    }
    const sig = signature(parseBody(body));
    const seen = st.verdicts[sig];
    if (seen) {
      seen.count++;
      seen.lastSeen = r.time;
      sum.known++;
      st.bookmark = r.recordId;
      continue;
    }
    if (sum.classified >= maxNew) {
      // stop here WITHOUT advancing the bookmark, so this record and the rest
      // are read again next scan instead of being skipped
      sum.deferred = true;
      break;
    }
    const v = await classify(body, { baseUrl: baseUrl(), apiKey: currentApiKey() });
    st.verdicts[sig] = { ...v, signature: sig, sample: body, firstSeen: r.time, lastSeen: r.time, count: 1 };
    sum.classified++;
    st.bookmark = r.recordId;
  }
  st.outOfDomain += sum.outOfDomain;
  sum.bookmark = st.bookmark;
  await writeState(st);
  return sum;
}
