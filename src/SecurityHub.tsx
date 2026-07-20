import { useState } from "react";
import { OsavaHeader, StatusPill } from "./OsavaUI";

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

type SecurityHubProps = {
  status: InstallStatus | null;
  onInstallChange: () => void;
};

export default function SecurityHub({ status, onInstallChange }: SecurityHubProps) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uninstall, setUninstall] = useState(false);

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      const response = await fetch("http://localhost:4000/api/install-status", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Install failed");
        return;
      }
      await onInstallChange();
    } catch (err) {
      setError("Could not reach the backend");
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall() {
    setUninstall(true);
    setError(null);
    try {
      const response = await fetch("http://localhost:4000/api/uninstall", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Uninstall failed");
        return;
      }
      await onInstallChange();
    } catch (err) {
      console.error("Uninstall request failed.", err);
      setError("Could not reach the backend");
    } finally {
      setUninstall(false);
    }
  }

  const installed = !!status?.installed;

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Security Hub"
        status={installed ? "Armed" : "Idle"}
        title="Security Hub"
        subtitle="Install and manage antivirus engines."
      />

      {!status ? (
        <p className="osv-muted">Loading…</p>
      ) : (
        <div className="osv-panel">
          <div className="osv-record-head">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="osv-record-path">ClamAV</span>
              <span className="osv-record-meta" style={{ marginTop: 0 }}>
                {installed
                  ? `Open-source engine${status.installedAt ? ` · installed ${new Date(status.installedAt).toLocaleDateString()}` : ""}`
                  : "Open-source antivirus engine"}
              </span>
            </div>
            <StatusPill tone={installed ? "ok" : "neutral"}>
              {installed ? "Installed" : "Not installed"}
            </StatusPill>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {installed ? (
              <button className="osv-btn osv-btn--danger" onClick={handleUninstall} disabled={uninstall}>
                {uninstall ? "Uninstalling…" : "Uninstall"}
              </button>
            ) : (
              <button className="osv-btn osv-btn--primary" onClick={handleInstall} disabled={installing}>
                {installing ? "Installing…" : "Install ClamAV"}
              </button>
            )}
          </div>

          {error && (
            <div className="osv-result">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <StatusPill tone="warn">Notice</StatusPill>
                <p style={{ margin: 0 }}>{error}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
