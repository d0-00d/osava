import { useState, useEffect } from "react";
import { OsavaHeader, StatusPill } from "./OsavaUI";

type ScanRecord = {
  id: string;
  path: string;
  startedAt: string;
  finishedAt: string;
  outcome: "clean" | "infected" | "cancelled" | "error";
  infectedFiles: string[];
  verbose: boolean;
};

const OUTCOME_TONE: Record<ScanRecord["outcome"], "ok" | "bad" | "warn" | "neutral"> = {
  clean: "ok",
  infected: "bad",
  cancelled: "neutral",
  error: "warn",
};

export default function ScanHistory() {
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  async function fetchHistory() {
    setLoading(true);
    try {
      const response = await fetch("http://localhost:4000/api/av/history");
      const data = await response.json();
      setRecords(data);
    } catch (err) {
      console.error("Failed to fetch history:", err);
    } finally {
      setLoading(false);
    }
  }

  async function clearHistory() {
    setClearing(true);
    setError(null);
    try {
      const response = await fetch("http://localhost:4000/api/av/history", { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Could not clear history");
        return;
      }
      setRecords([]);
      setExpanded({});
      setConfirmingClear(false);
    } catch (err) {
      setError("Could not reach the backend");
    } finally {
      setClearing(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function formatDuration(startedAt: string, finishedAt: string): string {
    const diff = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    return (diff / 1000).toFixed(1) + "s";
  }

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Archives"
        status="Log"
        title="Scan History"
        subtitle="Record of completed scans and detected threats."
      />

      <div style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="osv-btn" onClick={fetchHistory} disabled={loading || clearing}>
          {loading ? "Loading…" : "Refresh"}
        </button>

        {/* Clearing can't be undone, so it takes a second, deliberate click. */}
        {!confirmingClear ? (
          <button
            className="osv-btn osv-btn--danger"
            onClick={() => setConfirmingClear(true)}
            disabled={loading || clearing || records.length === 0}
          >
            Clear history
          </button>
        ) : (
          <>
            <span className="osv-muted">
              Delete all {records.length} record{records.length === 1 ? "" : "s"}? This can't be undone.
            </span>
            <button className="osv-btn osv-btn--danger" onClick={clearHistory} disabled={clearing}>
              {clearing ? "Clearing…" : "Yes, delete"}
            </button>
            <button className="osv-btn" onClick={() => setConfirmingClear(false)} disabled={clearing}>
              Cancel
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="osv-panel" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <StatusPill tone="warn">Notice</StatusPill>
            <p style={{ margin: 0 }}>{error}</p>
          </div>
        </div>
      )}

      {!loading && records.length === 0 && (
        <div className="osv-empty">No scan history yet. Run a scan to see results here.</div>
      )}

      {records.map(record => (
        <div className="osv-panel" key={record.id}>
          <div className="osv-record-head">
            <span className="osv-record-path">{record.path}</span>
            <StatusPill tone={OUTCOME_TONE[record.outcome]}>{record.outcome}</StatusPill>
          </div>
          <div className="osv-record-meta">
            {new Date(record.startedAt).toLocaleString()} · {formatDuration(record.startedAt, record.finishedAt)} · {record.verbose ? "verbose" : "quick"} scan
          </div>

          {record.infectedFiles.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                className="osv-btn osv-btn--danger"
                style={{ padding: "6px 12px", fontSize: 11 }}
                onClick={() => toggleExpanded(record.id)}
              >
                {expanded[record.id] ? "Hide" : "Show"} {record.infectedFiles.length} infected file{record.infectedFiles.length > 1 ? "s" : ""}
              </button>
              {expanded[record.id] && (
                <div className="osv-tags" style={{ marginTop: 10 }}>
                  {record.infectedFiles.map((file, i) => (
                    <span className="osv-tag" key={i}>{file}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
