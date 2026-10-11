// Read new Sysmon records and logons, keep the ones the model can judge, and classify
// each NEW behaviour once. Known behaviours only bump a counter: a working
// machine's 52,791 benign events collapsed to 1,788 signatures, so after a
// warm-up the model is called on a small fraction of what Sysmon produces.

import { CONTRACT } from "./contractSpec";
import { classify } from "./classifier";
import { toContractBody } from "./convert";
import { ownTracker } from "./own";
import { LogAccessDenied, readSecurity, readSysmon, type LogRecord } from "./reader";
import { baseUrl, currentApiKey } from "./runtime";
import { parseBody, signature } from "./signature";
import { exclusive, readState, writeState } from "./store";

/** Records read from the log per scan. */
export const PAGE = 500;

export interface ScanSummary {
  read: number;
  /** OSAVA's own activity (its log readers, llama-server, what they write): skipped, never judged */
  own: number;
  outOfDomain: number;
  known: number;
  classified: number;
  /** new behaviours left for the next scan (per-scan budget reached) */
  deferred: boolean;
  /** more is waiting right now (budget reached, or a log page came back full) */
  more: boolean;
  /** last Sysmon RecordId handled */
  bookmark: number;
  /** last Security-log RecordId handled (RecordIds are numbered per channel) */
  securityBookmark: number;
  /** logons were not assessed because the Security log refused this account */
  securityUnreadable: boolean;
  /** stored behaviours an earlier model had judged, judged again from their stored event this scan */
  rejudged: number;
  /** stored behaviours still carrying an earlier model's verdict after this scan */
  stale: number;
}

/** Where records come from. The Sysmon log in production; a script in tests. */
export type Source = (afterRecordId: number, max: number) => Promise<LogRecord[]>;

/** The two channels a scan reads. `security: null` scans Sysmon alone. */
export interface Sources { sysmon: Source; security: Source | null }

const LIVE: Sources = { sysmon: readSysmon, security: readSecurity };

let inflight: Promise<ScanSummary> | null = null;

/** Is a scan running right now (from the monitor or a manual one)? */
export const scanning = (): boolean => inflight !== null;

/**
 * Scan once. Only one scan runs at a time: a second caller (the UI's Scan
 * button during a monitor tick, say) gets the scan already in progress rather
 * than a second one reading the same bookmark and classifying the same
 * behaviours twice. It therefore also gets that scan's `maxNew`.
 */
export function scanOnce(maxNew = 25, sources: Sources | Source = LIVE): Promise<ScanSummary> {
  // A bare Source is a Sysmon-only scan, which is how tests script one channel.
  const src = typeof sources === "function" ? { sysmon: sources, security: null } : sources;
  if (!inflight) {
    const p = exclusive(() => run(maxNew, src));
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
  }
  return inflight;
}

async function run(maxNew: number, src: Sources): Promise<ScanSummary> {
  const st = await readState();
  const sum: ScanSummary = {
    read: 0, own: 0, outOfDomain: 0, known: 0, classified: 0, deferred: false, more: false,
    bookmark: st.bookmark, securityBookmark: st.securityBookmark ?? 0, securityUnreadable: false,
    rejudged: 0, stale: 0,
  };
  const model = CONTRACT.model.gguf_sha256;
  let dirty = false;

  /**
   * Handle one channel's records in order. Returns false once the per-scan budget of new behaviours is
   * spent, leaving that channel's bookmark on the last record fully handled, so the rest are read again
   * next scan instead of being skipped. The bookmark only advances past a record once that record is
   * fully handled, so a partial save is always consistent.
   */
  async function drain(recs: LogRecord[], setBookmark: (recordId: number) => void): Promise<boolean> {
    for (const r of recs) {
      // Before anything else, so OSAVA's own work is neither judged nor counted as anything but its own.
      if (ownTracker.claims(r)) {
        sum.own++;
        setBookmark(r.recordId);
        dirty = true;
        continue;
      }
      const body = toContractBody(r);
      if (body === null) {
        if (!CONTRACT.input.supported_event_ids.includes(r.eid)) sum.outOfDomain++;
        setBookmark(r.recordId);
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
        setBookmark(r.recordId);
        dirty = true;
        continue;
      }
      if (sum.classified >= maxNew) {
        sum.deferred = true;
        sum.more = true;
        return false;
      }
      const v = await classify(body, { baseUrl: baseUrl(), apiKey: currentApiKey() });
      // A new verdict replaces the record whole, so a person's "expected" on the old one does not carry over.
      st.verdicts[sig] = {
        ...v, signature: sig, sample: body,
        firstSeen: seen?.firstSeen ?? r.time, lastSeen: r.time, count: (seen?.count ?? 0) + 1,
      };
      sum.classified++;
      setBookmark(r.recordId);
      dirty = true;
    }
    return true;
  }

  // Whatever happens below -- the model times out on record 20 of 25 -- what
  // was decided so far is saved together with the bookmarks that go with it,
  // and the next scan resumes at the record that failed instead of re-deciding
  // the ones before it.
  try {
    // Logons go first: once filtered they are few and high in signal (failed logons are how brute force
    // shows up), and a Sysmon warm-up that spends the whole budget on new behaviours would otherwise hold
    // them back every scan.
    let budgetLeft = true;
    if (src.security) {
      try {
        const logons = await src.security(sum.securityBookmark, PAGE);
        sum.read += logons.length;
        if (logons.length >= PAGE) sum.more = true;
        budgetLeft = await drain(logons, (id) => { st.securityBookmark = id; });
      } catch (e) {
        // Both channels are opened by the same group, so they should fail together. But logons were added
        // to a working Sysmon pipeline, and being unable to read them must not be what stops it. It is
        // reported (`securityUnreadable`, shown in the Behaviour tab), never silent.
        if (!(e instanceof LogAccessDenied)) throw e;
        sum.securityUnreadable = true;
      }
    }

    if (budgetLeft) {
      const events = await src.sysmon(st.bookmark, PAGE);
      sum.read += events.length;
      if (events.length >= PAGE) sum.more = true;
      budgetLeft = await drain(events, (id) => { st.bookmark = id; });
    }

    // Behaviours an earlier model judged are judged again by this one, from the event stored with each, with
    // whatever budget the new events left. Before, an upgrade left the old verdicts on screen, looking current,
    // until each behaviour happened to recur. History (first and last seen, count) is kept; a person's
    // "expected" is not, because it was given to the old verdict.
    if (budgetLeft) {
      for (const [sig, old] of Object.entries(st.verdicts)) {
        if (old.modelSha256 === model) continue;
        if (sum.classified + sum.rejudged >= maxNew) { sum.more = true; break; }
        const v = await classify(old.sample, { baseUrl: baseUrl(), apiKey: currentApiKey() });
        st.verdicts[sig] = {
          ...v, signature: sig, sample: old.sample, firstSeen: old.firstSeen, lastSeen: old.lastSeen, count: old.count,
        };
        sum.rejudged++;
        dirty = true;
      }
    }
  } finally {
    sum.stale = Object.values(st.verdicts).filter((v) => v.modelSha256 !== model).length;
    st.outOfDomain += sum.outOfDomain;
    sum.bookmark = st.bookmark;
    sum.securityBookmark = st.securityBookmark ?? 0;
    if (dirty) await writeState(st);
  }
  return sum;
}
