import { useState, useEffect } from "react";
import { OsavaHeader, StatusPill } from "./OsavaUI";

type ProductStatus = {
  displayName: string;
  isEnabled: boolean;
  isUpToDate: boolean;
};

type Stats = {
  uptimeSeconds: number;
  totalScans: number;
  totalThreats: number;
  currentThreats: number;
  scannedDirectories: number;
  scannedFiles: number;
  lastScanAt: string | null;
};

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export default function Dashboard() {
  const [antivirus, setAntivirus] = useState<ProductStatus[]>([]);
  const [firewall, setFirewall] = useState<ProductStatus[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Counted forward locally so it ticks every second without polling the
  // backend; the periodic stats fetch re-anchors it to the real value.
  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function fetchStatus(isRefresh: boolean) {
      if (isRefresh) setRefreshing(true);
      try {
        const response = await fetch("http://localhost:4000/api/system-status");
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;
        setAntivirus(data.antivirus);
        setFirewall(data.firewall);
        // The first response is usually the saved copy, served instantly while
        // the backend re-queries Windows behind it. Check back once for the
        // fresh numbers instead of making the user wait on PowerShell.
        if (data.fromCache && !isRefresh) {
          timer = setTimeout(() => fetchStatus(true), 4000);
        }
      } catch (error) {
        console.error("Failed to fetch system status", error);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    async function fetchStats() {
      try {
        const response = await fetch("http://localhost:4000/api/stats");
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setStats(data);
          setUptime(data.uptimeSeconds);
        }
      } catch (error) {
        console.error("Failed to fetch stats", error);
      }
    }

    fetchStatus(false);
    fetchStats();

    // Tick the clock every second, and re-anchor to the backend every 30s so a
    // restart (which resets uptime to 0) can't leave the counter drifting.
    const ticker = setInterval(() => setUptime(u => u + 1), 1000);
    const resync = setInterval(fetchStats, 30000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(ticker);
      clearInterval(resync);
    };
  }, []);

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Dashboard"
        status={loading ? "Scanning" : refreshing ? "Refreshing" : "Live"}
        title="System Health"
        subtitle="Live protection status pulled from Windows Security Center."
      />

      {loading && <p className="osv-muted">Checking protection status…</p>}

      {!loading && (
        <>
          {stats && (
            <div className="osv-panel">
              <h3 className="osv-panel-title">Overview</h3>
              <div className="osv-grid">
                <div className="osv-stat">
                  <div className="osv-metric">{stats.currentThreats}</div>
                  <div className="osv-label">Threats, last scan</div>
                </div>
                <div className="osv-stat">
                  <div className="osv-metric">{stats.totalThreats}</div>
                  <div className="osv-label">Threats, all time</div>
                </div>
                <div className="osv-stat">
                  <div className="osv-metric">{stats.scannedDirectories.toLocaleString()}</div>
                  <div className="osv-label">Directories scanned</div>
                </div>
                <div className="osv-stat">
                  <div className="osv-metric">{stats.scannedFiles.toLocaleString()}</div>
                  <div className="osv-label">Files scanned</div>
                </div>
                <div className="osv-stat">
                  <div className="osv-metric">{stats.totalScans}</div>
                  <div className="osv-label">Scans run</div>
                </div>
                <div className="osv-stat">
                  <div className="osv-metric">{formatUptime(uptime)}</div>
                  <div className="osv-label">osava uptime</div>
                </div>
              </div>
            </div>
          )}

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
