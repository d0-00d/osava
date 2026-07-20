import { useState, useEffect } from "react";
import { OsavaHeader, StatusPill } from "./OsavaUI";

type ProductStatus = {
  displayName: string;
  isEnabled: boolean;
  isUpToDate: boolean;
};

export default function Dashboard() {
  const [antivirus, setAntivirus] = useState<ProductStatus[]>([]);
  const [firewall, setFirewall] = useState<ProductStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch("http://localhost:4000/api/system-status");
        const data = await response.json();
        setAntivirus(data.antivirus);
        setFirewall(data.firewall);
      } catch (error) {
        console.error("Failed to fetch system status", error);
      } finally {
        setLoading(false);
      }
    }
    fetchStatus();
  }, []);

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Dashboard"
        status={loading ? "Scanning" : "Live"}
        title="System Health"
        subtitle="Live protection status pulled from Windows Security Center."
      />

      {loading && <p className="osv-muted">Checking protection status…</p>}

      {!loading && (
        <>
          <div className="osv-panel">
            <h3 className="osv-panel-title">Antivirus</h3>
            {antivirus.length === 0 && (
              <p className="osv-muted">No antivirus product detected.</p>
            )}
            <div className="osv-grid">
              {antivirus.map(av => (
                <div className="osv-stat" key={av.displayName}>
                  <div className="osv-stat-name">{av.displayName}</div>
                  <div className="osv-stat-row">
                    <span className="osv-label">Real-time</span>
                    <StatusPill tone={av.isEnabled ? "ok" : "bad"}>
                      {av.isEnabled ? "On" : "Off"}
                    </StatusPill>
                  </div>
                  <div className="osv-stat-row">
                    <span className="osv-label">Definitions</span>
                    <StatusPill tone={av.isUpToDate ? "ok" : "warn"}>
                      {av.isUpToDate ? "Up to date" : "Out of date"}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="osv-panel">
            <h3 className="osv-panel-title">Firewall</h3>
            {firewall.length === 0 && (
              <p className="osv-muted">No firewall product detected.</p>
            )}
            <div className="osv-grid">
              {firewall.map(fw => (
                <div className="osv-stat" key={fw.displayName}>
                  <div className="osv-stat-name">{fw.displayName}</div>
                  <div className="osv-stat-row">
                    <span className="osv-label">Status</span>
                    <StatusPill tone={fw.isEnabled ? "ok" : "bad"}>
                      {fw.isEnabled ? "On" : "Off"}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
