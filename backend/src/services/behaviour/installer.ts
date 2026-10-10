// ─────────────────────────────────────────────────────────────
// Installing the model runtime as a background job.
//
// It is ~2 GB, so it cannot be one HTTP request the UI waits on: the window may
// be closed, the tab changed, the laptop put to sleep. The job lives here in the
// backend, its progress is part of /status (so any page that looks sees it), and
// pressing Install again while it runs just joins it. Stopping keeps what was
// downloaded, and the next press resumes from there.
// ─────────────────────────────────────────────────────────────

import { DownloadError } from "./download";
import { installModel, installServer, ModelUnavailable, type InstallHooks } from "./runtime";

export interface InstallState {
  /** idle: nothing has been started this session (or it was cancelled) */
  phase: "idle" | "running" | "done" | "error";
  /** what is happening right now, e.g. "Downloading the model" */
  label: string;
  received: number;
  total: number | null;
  error: { code: string; message: string } | null;
}

export interface InstallSteps {
  server: (hooks: InstallHooks) => Promise<void>;
  model: (hooks: InstallHooks) => Promise<unknown>;
}

const IDLE: InstallState = { phase: "idle", label: "", received: 0, total: null, error: null };
let state: InstallState = IDLE;
let job: Promise<void> | null = null;
let abort: AbortController | null = null;

export const installState = (): InstallState => ({ ...state });

function failure(e: unknown): { code: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DownloadError) return { code: e.kind, message };
  if (e instanceof ModelUnavailable) return { code: "MODEL_UNAVAILABLE", message };
  return { code: "ERROR", message };
}

/**
 * Start installing (or join the install already running). Returns at once; the
 * progress is in installState(). `steps` is a seam for tests.
 */
export function startInstall(steps: InstallSteps = { server: installServer, model: installModel }): InstallState {
  if (job) return installState();
  state = { phase: "running", label: "Starting", received: 0, total: null, error: null };
  const ctl = new AbortController();
  abort = ctl;
  const hooks: InstallHooks = {
    signal: ctl.signal,
    report: (label, received, total) => { state = { phase: "running", label, received, total, error: null }; },
  };
  const p = (async () => {
    try {
      await steps.server(hooks);
      await steps.model(hooks);
      state = { phase: "done", label: "Installed", received: 0, total: null, error: null };
    } catch (e) {
      const f = failure(e);
      // Stopping on purpose is not a failure: say what happens next.
      state = f.code === "CANCELLED"
        ? { ...IDLE, label: "Stopped. What was downloaded is kept; pressing Install continues from there." }
        : { phase: "error", label: "", received: 0, total: null, error: f };
    } finally {
      if (abort === ctl) abort = null;
      job = null;
    }
  })();
  job = p;
  return installState();
}

/** Stop the running install, keeping the partial download. */
export function cancelInstall(): InstallState {
  abort?.abort();
  return installState();
}

/** Resolves when the running install ends (for tests and shutdown). */
export const installDone = (): Promise<void> => job ?? Promise.resolve();
