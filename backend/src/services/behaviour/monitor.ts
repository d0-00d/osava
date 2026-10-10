// ─────────────────────────────────────────────────────────────
// Continuous monitoring: scan, wait, scan again.
//
// It lives in the backend, not the UI, so it keeps going while the user is on
// another tab. The next scan is scheduled when the previous one finishes
// rather than on a fixed clock, so scans can never overlap or pile up behind a
// slow one. A backlog (the log page came back full, or the per-scan budget of
// new behaviours ran out) is drained straight away instead of waiting a full
// interval.
//
// Failing quietly is the one thing a monitor must not do. A problem only the
// user can fix (the log is unreadable, the model is wrong or missing) switches
// monitoring off at once and says why; a transient one is retried with backoff
// and switches it off after MAX_FAILURES in a row. Either way the state says
// so, and "off" is never presented as "all clear".
// ─────────────────────────────────────────────────────────────

import type { ScanSummary } from "./pipeline";
import { LogAccessDenied, LogMissing } from "./reader";
import { ModelUnavailable } from "./runtime";

export const DEFAULT_INTERVAL_MS = 15_000;
export const MIN_INTERVAL_MS = 2_000;
export const MAX_FAILURES = 3;
const CATCH_UP_MS = 250;
const RETRY_BASE_MS = 1_000;

/** Timings, overridable so tests do not have to wait out real intervals. */
export interface MonitorTimings {
  minIntervalMs?: number;
  catchUpMs?: number;
  retryBaseMs?: number;
}

export type MonitorPhase = "off" | "checking" | "starting" | "scanning" | "waiting";
export type MonitorErrorCode = "LOG_ACCESS_DENIED" | "LOG_MISSING" | "MODEL_UNAVAILABLE" | "ERROR";

export interface MonitorError {
  code: MonitorErrorCode;
  message: string;
  at: string;
  /** true = monitoring switched itself off because of this */
  fatal: boolean;
}

export interface MonitorState {
  phase: MonitorPhase;
  intervalMs: number;
  scans: number;
  lastScanAt: string | null;
  lastScan: ScanSummary | null;
  /** consecutive transient failures; a good scan resets it */
  failures: number;
  error: MonitorError | null;
}

export interface MonitorDeps {
  /** Throws LogAccessDenied / LogMissing if the log cannot be read. */
  probeLog(): Promise<void>;
  /** Start the model server if it is not running (idempotent). */
  startModel(): Promise<void>;
  stopModel(): void;
  scan(): Promise<ScanSummary>;
}

function describe(e: unknown): Pick<MonitorError, "code" | "message" | "fatal"> {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof LogAccessDenied) return { code: "LOG_ACCESS_DENIED", message, fatal: true };
  if (e instanceof LogMissing) return { code: "LOG_MISSING", message, fatal: true };
  if (e instanceof ModelUnavailable) return { code: "MODEL_UNAVAILABLE", message, fatal: true };
  return { code: "ERROR", message, fatal: false };
}

export function createMonitor(deps: MonitorDeps, timings: MonitorTimings = {}) {
  const minInterval = timings.minIntervalMs ?? MIN_INTERVAL_MS;
  const catchUp = timings.catchUpMs ?? CATCH_UP_MS;
  const retryBase = timings.retryBaseMs ?? RETRY_BASE_MS;
  const s: MonitorState = {
    phase: "off", intervalMs: DEFAULT_INTERVAL_MS, scans: 0,
    lastScanAt: null, lastScan: null, failures: 0, error: null,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Bumped by every start and stop. A tick that was already awaiting something
  // when the user stopped carries the old number and must neither reschedule
  // itself nor report the error that stopping the model caused.
  let generation = 0;
  let probed = false;

  async function tick(gen: number): Promise<void> {
    if (gen !== generation) return;
    let delay = s.intervalMs;
    try {
      if (!probed) {
        s.phase = "checking";
        await deps.probeLog();
        if (gen !== generation) return;
        probed = true;
      }
      s.phase = "starting";
      await deps.startModel();
      if (gen !== generation) return;
      s.phase = "scanning";
      const sum = await deps.scan();
      if (gen !== generation) return;
      s.scans++;
      s.lastScan = sum;
      s.lastScanAt = new Date().toISOString();
      s.failures = 0;
      s.error = null;
      if (sum.more) delay = catchUp;
    } catch (e) {
      if (gen !== generation) return;
      const d = describe(e);
      s.failures++;
      const giveUp = d.fatal || s.failures >= MAX_FAILURES;
      s.error = { code: d.code, message: d.message, at: new Date().toISOString(), fatal: giveUp };
      if (giveUp) {
        s.phase = "off";
        generation++;
        deps.stopModel();
        return;
      }
      // 2 s, then 4 s: quick enough that a stop-then-start that handed this tick
      // a scan dying with the old model costs seconds, never a full interval.
      delay = Math.min(retryBase * 2 ** s.failures, s.intervalMs);
    }
    s.phase = "waiting";
    timer = setTimeout(() => void tick(gen), delay);
    timer.unref?.();
  }

  return {
    state: (): MonitorState => ({ ...s }),

    /** Begin monitoring. Returns at once; progress and failures show in state(). */
    start(intervalMs?: number): MonitorState {
      if (s.phase !== "off") return { ...s };
      s.intervalMs = Math.max(minInterval, Math.floor(intervalMs ?? DEFAULT_INTERVAL_MS));
      s.failures = 0;
      s.error = null;
      s.phase = "checking";
      probed = false;
      const gen = ++generation;
      void tick(gen);
      return { ...s };
    },

    /** Stop monitoring and release the model. */
    stop(): MonitorState {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      s.phase = "off";
      deps.stopModel();
      return { ...s };
    },
  };
}
