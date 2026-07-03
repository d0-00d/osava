import { useState, useEffect } from "react";

type ScanRecord = {
  id: string;
  path: string;
  startedAt: string;
  finishedAt: string;
  outcome: "clean" | "infected" | "cancelled" | "error";
  infectedFiles: string[];
  verbose: boolean;
};

const OUTCOME_COLORS: Record<ScanRecord["outcome"], string> = {
  clean: "#4f4",
  infected: "#f87",
  cancelled: "#aaa",
  error: "#fa4",
};

export default function ScanHistory() {
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  function toggleExpanded(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function formatDuration(startedAt: string, finishedAt: string): string {
    const diff = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    return (diff / 1000).toFixed(1) + "s";
  }

  if (loading) return <p>Loading history...</p>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <h2 style={{ margin: 0 }}>Scan History</h2>
        <button onClick={fetchHistory}>Refresh</button>
      </div>

      {records.length === 0 && (
        <p style={{ color: "#aaa" }}>No scan history yet. Run a scan to see results here.</p>
      )}

      {records.map(record => (
        <div key={record.id} style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: "6px",
          padding: "12px",
          marginBottom: "10px",
          fontFamily: "monospace",
          fontSize: "13px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#eee", fontWeight: "bold", wordBreak: "break-all" }}>
              {record.path}
            </span>
            <span style={{
              color: OUTCOME_COLORS[record.outcome],
              fontWeight: "bold",
              marginLeft: "12px",
              whiteSpace: "nowrap",
            }}>
              {record.outcome.toUpperCase()}
            </span>
          </div>

          <div style={{ color: "#888", marginTop: "6px", fontSize: "11px" }}>
            {new Date(record.startedAt).toLocaleString()} &nbsp;·&nbsp;
            {formatDuration(record.startedAt, record.finishedAt)} &nbsp;·&nbsp;
            {record.verbose ? "verbose" : "quick"} scan
          </div>

          {record.infectedFiles.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <button
                onClick={() => toggleExpanded(record.id)}
                style={{ fontSize: "11px", cursor: "pointer" }}
              >
                {expanded[record.id] ? "Hide" : "Show"} {record.infectedFiles.length} infected file{record.infectedFiles.length > 1 ? "s" : ""}
              </button>

              {expanded[record.id] && (
                <ul style={{ margin: "6px 0 0 0", paddingLeft: "16px", color: "#f87" }}>
                  {record.infectedFiles.map((file, i) => (
                    <li key={i}>{file}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}