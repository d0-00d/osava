import { useCallback, useEffect, useRef, useState } from "react";
import { OsavaHeader, StatusPill } from "./OsavaUI";

// Behaviour triage: a local model reads the Sysmon log and ranks the events
// that deserve a person's attention. The page is built around what that model
// is and is not:
//   * it triages, it does not prove -- so verdicts are "look here first", never
//     "infected", and High is not a conviction;
//   * silence is never clean -- when monitoring is off, stopped, or an event is
//     of a kind the model does not judge, the page says so rather than showing
//     an empty list;
//   * a model that gives no usable answer is escalated, and shown as exactly
//     that, not dressed up with a rationale it never produced.

const API = "http://localhost:4000/api/behaviour";

type Tone = "ok" | "bad" | "warn" | "neutral";
type ReviewReason = "no_answer" | "not_benign" | "close_call" | null;

type Verdict = {
  signature: string;
  severity: "none" | "low" | "medium" | "high" | "critical";
  threatType: string | null;
  indicators: Record<string, string | number | boolean>;
  reasoning: string;
  severityProbs: Record<string, number>;
  classProbs: Record<string, number>;
  needsReview: boolean;
  reviewReason: ReviewReason;
  failedOpen: boolean;
  sample: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
};

type ScanSummary = {
  read: number; outOfDomain: number; known: number; classified: number;
  deferred: boolean; more: boolean; bookmark: number;
};

type Monitor = {
  phase: "off" | "checking" | "starting" | "scanning" | "waiting";
  intervalMs: number;
  scans: number;
  lastScanAt: string | null;
  lastScan: ScanSummary | null;
  failures: number;
  error: { code: string; message: string; at: string; fatal: boolean } | null;
};

/** The model-runtime install job: it runs in the backend, so any page that looks sees the same progress. */
type Install = {
  phase: "idle" | "running" | "done" | "error";
  label: string;
  received: number;
  total: number | null;
  error: { code: string; message: string } | null;
};

type Status = {
  sysmon: {
    installed: boolean; running: boolean;
    /** in the group that may read the log: a member only has to sign in again, anyone else has to be added */
    group: "member" | "not-member" | "unknown";
    log: "readable" | "denied" | "missing" | "unknown";
  };
  runtime: {
    serverInstalled: boolean;
    /** a file is in place (perhaps copied by hand); not necessarily the right one yet */
    modelPresent: boolean;
    /** present AND checked against the checksum this OSAVA was built for */
    modelInstalled: boolean;
    running: boolean;
    /** where the running (or last) model server ran; "cpu" is the fallback when the GPU path failed */
    device: "gpu" | "cpu" | null;
  };
  install: Install;
  model: { name?: string; gguf_sha256?: string; gguf_bytes?: number; quantisation?: string; promptVariant: string; contract: string };
  monitor: Monitor;
  scanning: boolean;
  behaviours: number;
  counts: { benign: number; suspicious: number; malicious: number; needsReview: number };
  outOfDomain: number;
  supportedEventIds: number[];
  bookmark: number;
};

type Busy = "sysmon" | "runtime" | "monitor" | "scan" | "unload" | null;
type Reply<T> = { ok: boolean; status: number; body: (T & { error?: string; code?: string }) | null };

async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<Reply<T>> {
  const r = await fetch(`${API}${path}`, { method });
  let body: Reply<T>["body"] = null;
  try { body = await r.json(); } catch { /* an empty or non-JSON reply */ }
  return { ok: r.ok, status: r.status, body };
}

const SEVERITY_TONE: Record<Verdict["severity"], Tone> = {
  none: "ok", low: "neutral", medium: "warn", high: "bad", critical: "bad",
};
const SEVERITY_LABEL: Record<Verdict["severity"], string> = {
  none: "None", low: "Low", medium: "Medium", high: "High", critical: "Critical",
};
const EVENT_KINDS: Record<number, string> = {
  1: "process", 3: "network", 7: "image load", 11: "file", 12: "registry", 13: "registry",
};

/** "process (1), network (3), …" from the EventIDs the model was trained on. */
function coverage(ids: number[]): string {
  const byKind = new Map<string, number[]>();
  for (const id of ids.filter((i) => i < 1000)) {
    const k = EVENT_KINDS[id] ?? "other";
    byKind.set(k, [...(byKind.get(k) ?? []), id]);
  }
  return [...byKind].map(([k, v]) => `${k} (${v.join(", ")})`).join(", ");
}

function field(sample: string, key: string): string | undefined {
  return sample.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
}
const baseName = (p?: string) => (p ? p.slice(p.lastIndexOf("\\") + 1) : undefined);

/** The one line that says what the event actually did. */
function detailOf(sample: string): string | undefined {
  const file = field(sample, "TargetFilename");
  if (file) return `→ ${file}`;
  const ip = field(sample, "DestinationIp");
  if (ip) return `→ ${ip}${field(sample, "DestinationPort") ? ":" + field(sample, "DestinationPort") : ""}`;
  return field(sample, "CommandLine");
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const words = (s: string) => s.replace(/_/g, " ");

function Notice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div className={`osv-panel osv-notice${tone === "bad" ? " osv-notice--bad" : tone === "warn" ? " osv-notice--warn" : ""}`}
         role="status">
      <StatusPill tone={tone}>{tone === "ok" ? "Done" : tone === "bad" ? "Stopped" : "Notice"}</StatusPill>
      <p>{children}</p>
    </div>
  );
}

function Kpi({ label, value, note, attn, small }: { label: string; value: string | number; note?: string; attn?: boolean; small?: boolean }) {
  return (
    <div className="osv-kpi">
      <span className="osv-label">{label}</span>
      <span className={`osv-kpi-value${attn ? " osv-kpi-value--attn" : ""}${small ? " osv-kpi-value--small" : ""}`}>{value}</span>
      {note && <span className="osv-kpi-note">{note}</span>}
    </div>
  );
}

function VerdictRow({ v, open, onToggle }: { v: Verdict; open: boolean; onToggle: () => void }) {
  const image = baseName(field(v.sample, "Image"));
  const kind = field(v.sample, "EventType");
  const detail = detailOf(v.sample);
  const certainty = v.failedOpen ? null : Math.max(0, ...Object.values(v.classProbs));
  const tagTone = v.severity === "high" || v.severity === "critical" ? "" : v.severity === "medium" ? " osv-tag--warn" : " osv-tag--neutral";
  const entries = Object.entries(v.indicators);
  return (
    <article className={`osv-verdict osv-verdict--${v.severity === "critical" ? "high" : v.severity}`}>
      <div className="osv-verdict-head">
        <StatusPill tone={SEVERITY_TONE[v.severity]}>{SEVERITY_LABEL[v.severity]}</StatusPill>
        <span className="osv-verdict-title">{image ?? kind ?? "Event"}</span>
        {image && kind && <span className="osv-verdict-kind">{kind}</span>}
        {v.reviewReason === "close_call" && <StatusPill tone="warn">Close call</StatusPill>}
        {v.reviewReason === "no_answer" && <StatusPill tone="bad">No answer</StatusPill>}
      </div>

      {detail && <div className="osv-verdict-detail" title={detail}>{detail}</div>}

      <p className="osv-verdict-reason">
        {v.failedOpen
          ? "The model gave no usable answer for this event, so OSAVA escalated it instead of calling it clean."
          : v.reasoning}
      </p>

      {((v.threatType && !v.failedOpen) || entries.length > 0) && (
        <div className="osv-tags">
          {/* a threat type is derived assuming the class the model chose; on a fail-open it chose none */}
          {v.threatType && !v.failedOpen && <span className={`osv-tag${tagTone}`}><b>type</b>{words(v.threatType)}</span>}
          {entries.map(([k, val]) => (
            <span className={`osv-tag${tagTone}`} key={k} title={String(val)}><b>{words(k)}</b>{String(val)}</span>
          ))}
        </div>
      )}

      <div className="osv-verdict-meta">
        <span>seen {v.count}×</span>
        <span>first seen {new Date(v.firstSeen).toLocaleString()}</span>
        <span>last seen {ago(v.lastSeen)}</span>
        {certainty !== null && <span title="The probability the model put on its answer. Not calibrated: use it to rank, not to measure.">certainty {pct(certainty)}</span>}
        <button className="osv-link" onClick={onToggle} aria-expanded={open}>{open ? "Hide event" : "Show event"}</button>
      </div>

      {open && (
        <div className="osv-evidence">
          <span className="osv-label">The event, exactly as the model saw it</span>
          <pre className="osv-pre">{v.sample}</pre>
          {!v.failedOpen && (
            <div className="osv-probs">
              {(["none", "low", "medium", "high"] as const).map((s) => (
                <div className="osv-prob" key={s}>
                  <span>{s} {pct(v.severityProbs[s] ?? 0)}</span>
                  <div className="osv-prob-bar"><span style={{ width: pct(v.severityProbs[s] ?? 0) }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function Behaviour() {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<"ok" | "offline" | "refused">("ok");
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [view, setView] = useState<"review" | "all">("review");
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const seen = useRef("");
  const viewRef = useRef(view);
  viewRef.current = view;

  const loadVerdicts = useCallback(async (v: "review" | "all") => {
    try {
      const r = await call<Verdict[]>(`/verdicts?view=${v}&limit=200`);
      if (r.ok && Array.isArray(r.body)) setVerdicts(r.body as Verdict[]);
    } catch { /* the status poll reports an unreachable backend */ }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await call<Status>("/status");
      if (r.status === 403) { setLink("refused"); return; }
      if (!r.ok || !r.body) { setLink("offline"); return; }
      const s = r.body as Status;
      setLink("ok");
      setStatus(s);
      // Re-read the list only when something it is built from has changed.
      const key = [s.behaviours, s.counts.needsReview, s.bookmark, s.monitor.lastScanAt].join("|");
      if (key !== seen.current) { seen.current = key; void loadVerdicts(viewRef.current); }
    } catch { setLink("offline"); }
  }, [loadVerdicts]);

  useEffect(() => { void loadVerdicts(view); }, [view, loadVerdicts]);

  const active = !!status && (status.monitor.phase !== "off" || status.scanning || status.install.phase === "running");
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), active ? 1500 : 4000);
    return () => clearInterval(t);
  }, [refresh, active]);

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(kind);
    setNotice(null);
    try { await action(); }
    catch { setLink("offline"); setNotice({ tone: "warn", text: "Could not reach the OSAVA backend." }); }
    finally { setBusy(null); void refresh(); }
  }

  const installSysmon = () => run("sysmon", async () => {
    const r = await call<{ note?: string }>("/install-sysmon", "POST");
    setNotice(r.ok
      ? { tone: "ok", text: r.body?.note ?? "Sysmon is installed." }
      : { tone: "warn", text: r.body?.error ?? "The Sysmon install failed." });
  });

  // Starting the install returns at once; progress and any failure come back through /status.
  const installRuntime = () => run("runtime", async () => {
    const r = await call<Install>("/install-runtime", "POST");
    if (!r.ok) setNotice({ tone: "warn", text: r.body?.error ?? "The model install could not be started." });
  });
  const stopInstall = () => run("runtime", async () => { await call("/install-runtime/cancel", "POST"); });

  const startMonitoring = () => run("monitor", async () => {
    await call("/monitor/start", "POST");
  });
  const stopMonitoring = () => run("monitor", async () => { await call("/monitor/stop", "POST"); });
  const unload = () => run("unload", async () => { await call("/stop", "POST"); });

  const scanOnce = () => run("scan", async () => {
    const r = await call<ScanSummary>("/scan", "POST");
    if (!r.ok || !r.body) { setNotice({ tone: "warn", text: r.body?.error ?? "The scan failed." }); return; }
    const s = r.body;
    setNotice({
      tone: "ok",
      text: `Read ${s.read} events: ${s.classified} new behaviour${s.classified === 1 ? "" : "s"} judged, ` +
        `${s.known} already known, ${s.outOfDomain} not assessed.${s.more ? " More is waiting; scan again to continue." : ""}`,
    });
  });

  // ── derived state ────────────────────────────────────────────────────────
  const sysmonReady = !!status && status.sysmon.installed && status.sysmon.log === "readable";
  // Installed but unreadable has two cures. Never added to the log-readers group
  // (Sysmon put there by hand, say): OSAVA has to add the user, and signing out
  // would never help. Already added: Windows only applies it at the next sign-in.
  const logDenied = !!status && status.sysmon.installed && status.sysmon.log === "denied";
  const needsGrant = logDenied && status?.sysmon.group !== "member";
  const needsSignOut = logDenied && status?.sysmon.group === "member";
  const modelReady = !!status && status.runtime.serverInstalled && status.runtime.modelInstalled;
  const installing = status?.install.phase === "running";
  const installPct = installing && status?.install.total
    ? Math.min(100, Math.round((status.install.received / status.install.total) * 100)) : null;
  const ready = sysmonReady && modelReady;
  const m = status?.monitor;
  const monitoring = !!m && m.phase !== "off";
  // A log problem that the Setup panel is already explaining need not be said twice.
  const logCause = m?.error?.code === "LOG_ACCESS_DENIED" || m?.error?.code === "LOG_MISSING";
  const showStopped = !!m?.error?.fatal && !(logCause && !sysmonReady);

  const headerStatus =
    link === "offline" ? "Offline" :
    link === "refused" ? "Refused" :
    !status ? "Connecting" :
    !ready ? "Setup required" :
    m?.error?.fatal ? "Stopped" :
    m?.phase === "checking" || m?.phase === "starting" ? "Starting" :
    m?.phase === "scanning" || status.scanning ? "Scanning" :
    m?.phase === "waiting" ? "Monitoring" : "Idle";

  const liveText = !status || !m ? "" :
    m.phase === "checking" ? "Checking that the Sysmon log can be read…" :
    m.phase === "starting" ? (status.runtime.running ? "Checking the model…" : "Loading the model: usually ten seconds, up to a minute or two the first time while Windows checks the new files…") :
    m.phase === "scanning" ? "Reading the log and judging new behaviours…" :
    m.phase === "waiting" ? (m.lastScan?.more
      ? "Catching up on a backlog of log records…"
      : `Monitoring — last scan ${ago(m.lastScanAt)}${m.error ? ", and it failed: retrying" : ""}. Next scan about every ${Math.round(m.intervalMs / 1000)}s.`) :
    status.scanning ? "Scanning once…" :
    "Monitoring is off. Nothing is being assessed.";
  const liveDot = m?.phase === "off" && !status?.scanning ? "" : m?.error ? " osv-dot--warn" : " osv-dot--live";

  const reviewCount = status?.counts.needsReview ?? 0;
  const total = status?.behaviours ?? 0;

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Behaviour"
        status={headerStatus}
        title="Behaviour Triage"
        subtitle="A local model reads your Sysmon log and ranks the events that deserve a look. It triages; it does not prove."
      />

      {link === "offline" && <Notice tone="warn">Cannot reach the OSAVA backend on this machine. If you started OSAVA a moment ago, wait a few seconds.</Notice>}
      {link === "refused" && <Notice tone="warn">The OSAVA backend refused this window. Behaviour data is only served to the OSAVA app itself.</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {showStopped && <Notice tone="bad">Monitoring stopped: {m?.error?.message}</Notice>}

      {status && !ready && (
        <div className="osv-panel">
          <h3 className="osv-panel-title">Setup</h3>

          <div className="osv-step">
            <div className="osv-step-body">
              <span className="osv-step-name">Sysmon</span>
              <p className="osv-step-desc">
                {!status.sysmon.installed
                  ? "Records process, network, file and registry activity to the Windows event log. OSAVA installs it with a pinned, checksummed configuration and asks for administrator permission once. Installing it accepts Microsoft's Sysinternals Software License Terms for Sysmon on your behalf."
                  : needsGrant
                    ? "Sysmon is installed, but your account cannot read its log. OSAVA adds you to the Event Log Readers group (one administrator prompt), so it never has to run as admin. Windows applies that at your next sign-in." +
                      (status.sysmon.group === "unknown" ? " If you were already added, sign out and back in instead." : "")
                    : needsSignOut
                      ? "Sysmon is installed and you are in the Event Log Readers group. Windows applies that at your next sign-in: sign out and back in, then return here."
                      : status.sysmon.log === "missing"
                        ? "Sysmon is installed, but its log does not exist yet. Check that the Sysmon service is running."
                        : "Sysmon is installed, but OSAVA could not open its log. Check that the Sysmon service is running."}
              </p>
            </div>
            <div className="osv-step-side">
              <StatusPill tone={sysmonReady ? "ok" : status.sysmon.installed ? "warn" : "neutral"}>
                {sysmonReady ? "Ready" : !status.sysmon.installed ? "Not installed"
                  : needsGrant ? "Access needed" : needsSignOut ? "Sign-out needed" : "Not readable"}
              </StatusPill>
              {(!status.sysmon.installed || needsGrant) && (
                <button className="osv-btn osv-btn--primary" onClick={installSysmon} disabled={busy !== null}>
                  {busy === "sysmon" ? (needsGrant ? "Granting…" : "Installing…") : needsGrant ? "Grant log access" : "Install Sysmon"}
                </button>
              )}
            </div>
          </div>

          <div className="osv-step">
            <div className="osv-step-body">
              <span className="osv-step-name">Local model</span>
              <p className="osv-step-desc">
                {status.model.name ?? "osava-smollm"} ({status.model.quantisation ?? "quantised"}, about{" "}
                {status.model.gguf_bytes ? (status.model.gguf_bytes / 1e9).toFixed(1) : "2"} GB) runs on this PC through llama.cpp.
                Both downloads are checked against fixed checksums, and nothing you scan leaves the machine.
                {status.runtime.modelPresent && !status.runtime.modelInstalled && !installing &&
                  " A model file is already in place; Install model will check it, which takes about ten seconds."}
              </p>
              {installing && (
                <div className="osv-progress" role="progressbar" aria-label={status.install.label}
                     aria-valuenow={installPct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                  <div className="osv-progress-row">
                    <span>{status.install.label}</span>
                    <span>
                      {status.install.total
                        ? `${fmtBytes(status.install.received)} of ${fmtBytes(status.install.total)} · ${installPct}%`
                        : status.install.received ? fmtBytes(status.install.received) : ""}
                    </span>
                  </div>
                  <div className={`osv-progress-bar${installPct === null ? " osv-progress-bar--wait" : ""}`}>
                    <span style={installPct === null ? undefined : { width: `${installPct}%` }} />
                  </div>
                </div>
              )}
              {!installing && status.install.error && (
                <p className="osv-step-desc osv-step-desc--warn">{status.install.error.message}</p>
              )}
              {!installing && !status.install.error && status.install.phase === "idle" && status.install.label && (
                <p className="osv-step-desc">{status.install.label}</p>
              )}
            </div>
            <div className="osv-step-side">
              <StatusPill tone={installing ? "warn" : modelReady ? "ok" : "neutral"}>
                {installing ? "Installing" : modelReady ? "Installed" : "Not installed"}
              </StatusPill>
              {installing ? (
                <button className="osv-btn" onClick={stopInstall} disabled={busy !== null}>Stop</button>
              ) : !modelReady && (
                <button className="osv-btn osv-btn--primary" onClick={installRuntime} disabled={busy !== null}>
                  {status.install.error ? "Retry" : "Install model"}
                </button>
              )}
            </div>
          </div>

          {busy === "sysmon" && (
            <div className="osv-live">
              <span className="osv-dot osv-dot--live" aria-hidden />
              Approve the Windows permission (UAC) prompt to continue. The window may look idle while it works.
            </div>
          )}
        </div>
      )}

      {status && (
        <div className="osv-panel">
          <h3 className="osv-panel-title">Live triage</h3>
          <div className="osv-toolbar" style={{ marginBottom: 0 }}>
            {monitoring ? (
              <button className="osv-btn osv-btn--danger" onClick={stopMonitoring} disabled={busy !== null}>Stop monitoring</button>
            ) : (
              <button className="osv-btn osv-btn--primary" onClick={startMonitoring} disabled={!ready || busy !== null}>
                {busy === "monitor" ? "Starting…" : "Start monitoring"}
              </button>
            )}
            <button className="osv-btn" onClick={scanOnce} disabled={!ready || monitoring || status.scanning || busy !== null}>
              {busy === "scan" || (!monitoring && status.scanning) ? "Scanning…" : "Scan once"}
            </button>
            {!monitoring && status.runtime.running && !status.scanning && (
              <button className="osv-btn" onClick={unload} disabled={busy !== null} title="Stop the model and free its memory">Unload model</button>
            )}
          </div>

          <div className="osv-live" role="status">
            <span className={`osv-dot${liveDot}`} aria-hidden />
            {liveText}
          </div>
          {status.runtime.running && status.runtime.device === "cpu" && (
            <p className="osv-fine" style={{ marginTop: 8 }}>
              The model is running on the CPU, so each new behaviour takes about a second or more. That is the
              fallback: the graphics path did not start or did not pass its check on this PC.
            </p>
          )}

          <div className="osv-kpis">
            <Kpi label="Behaviours judged" value={total} note="each judged once, then counted" />
            <Kpi label="Need review" value={reviewCount} attn={reviewCount > 0} note="not benign, or too close to call" />
            <Kpi label="Not assessed" value={status.outOfDomain} note="event types the model does not judge" />
            <Kpi label="Last scan" value={ago(m?.lastScanAt ?? null)} small
                 note={m?.lastScan ? `read ${m.lastScan.read} · new ${m.lastScan.classified}` : undefined} />
          </div>

          <p className="osv-fine">
            <b>Judges</b> Sysmon {coverage(status.supportedEventIds)} events.{" "}
            <b>Everything else</b> is counted under “Not assessed” — it is not treated as clean.
          </p>
          <p className="osv-fine" style={{ marginTop: 6 }}>
            Model {status.model.name ?? "osava-smollm"} · {status.model.quantisation} ·{" "}
            sha256 {status.model.gguf_sha256?.slice(0, 8)}… · prompt {status.model.promptVariant} · contract {status.model.contract}
          </p>
        </div>
      )}

      {status && (
        <div className="osv-panel">
          <div className="osv-record-head" style={{ marginBottom: 14 }}>
            <h3 className="osv-panel-title" style={{ margin: 0 }}>
              {view === "review" ? "Needs review" : "All behaviours"}
            </h3>
            <div className="osv-seg" role="group" aria-label="Which behaviours to list">
              <button aria-pressed={view === "review"} onClick={() => setView("review")}>Needs review · {reviewCount}</button>
              <button aria-pressed={view === "all"} onClick={() => setView("all")}>All · {total}</button>
            </div>
          </div>

          {verdicts.length > 0 && (
            <p className="osv-fine" style={{ margin: "0 0 14px" }}>
              <b>Severity</b> is the model’s call. <b>The reasons and tags</b> are read off the event by fixed rules, so
              they only quote what it contains. High means look here first — not that it is an attack.
            </p>
          )}

          {verdicts.length === 0 && (
            <div className="osv-empty">
              {total === 0
                ? (monitoring
                    ? "Nothing judged yet. New behaviours appear here as soon as the first scan finishes."
                    : ready
                      ? "Nothing has been assessed yet. Start monitoring, or scan once."
                      : "Nothing has been assessed yet. Finish the setup above, then start monitoring.")
                : view === "review"
                  ? `Nothing needs review. ${total} behaviour${total === 1 ? "" : "s"} judged benign${monitoring ? "" : " — but monitoring is off, so nothing new is being looked at"}.`
                  : "No behaviours to show."}
            </div>
          )}

          <div className="osv-verdicts">
            {verdicts.map((v) => (
              <VerdictRow key={v.signature} v={v} open={!!open[v.signature]}
                          onToggle={() => setOpen((o) => ({ ...o, [v.signature]: !o[v.signature] }))} />
            ))}
          </div>
          {verdicts.length === 200 && <p className="osv-fine">Showing the 200 that matter most.</p>}
        </div>
      )}

      {status && (
        <details className="osv-panel osv-about">
          <summary>About these verdicts</summary>
          <ul>
            <li>The model judges one event at a time, with no memory of the ones before it.</li>
            <li>The reasons and tags on each row are not written by the model. They are read off the event by fixed rules, so they can only quote what is in it.</li>
            <li>A behaviour is judged the first time it is seen and counted afterwards. Who and where (user, IP address, port) are ignored when deciding whether two events are the same behaviour.</li>
            <li>Clear attacks and clearly normal activity are called far more reliably than the grey area between them. Treat None and Low as “nothing stood out”, not “safe”.</li>
            <li>If the model gives no usable answer, OSAVA escalates the event rather than calling it clean.</li>
            <li>Everything runs on this PC. Events and verdicts are kept in your profile under .osava and are never sent anywhere.</li>
          </ul>
        </details>
      )}
    </div>
  );
}
