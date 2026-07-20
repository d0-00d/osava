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

type Detection = { file: string; scanPath: string; when: string };

export default function Threats() {
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("http://localhost:4000/api/av/history");
        setRecords(await r.json());
      } catch (err) {
        console.error("Failed to fetch history:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Flatten every infected file across all scans into a single, newest-first list.
  const detections: Detection[] = records
    .filter(r => r.infectedFiles && r.infectedFiles.length > 0)
    .flatMap(r => r.infectedFiles.map(file => ({ file, scanPath: r.path, when: r.finishedAt })))
    .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Threats"
        status={loading ? "Scanning" : detections.length > 0 ? "Detected" : "Clear"}
        title="Threat Detections"
        subtitle="Infected files flagged across all completed scans."
      />

      {loading && <p className="osv-muted">Loading detections…</p>}

      {!loading && detections.length === 0 && (
        <div className="osv-panel" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StatusPill tone="ok">No threats</StatusPill>
          <p className="osv-muted" style={{ margin: 0 }}>
            No infected files have been detected in any scan.
          </p>
        </div>
      )}

      {!loading && detections.length > 0 && (
        <div className="osv-panel">
          <h3 className="osv-panel-title">
            {detections.length} detection{detections.length > 1 ? "s" : ""}
          </h3>
          <div className="osv-threat-list">
            {detections.map((d, i) => (
              <div className="osv-threat" key={i}>
                <StatusPill tone="bad">Infected</StatusPill>
                <div className="osv-threat-body">
                  <div className="osv-threat-file">{d.file}</div>
                  <div className="osv-record-meta">
                    in {d.scanPath} · {new Date(d.when).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
