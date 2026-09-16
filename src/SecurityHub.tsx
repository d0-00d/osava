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
  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Security Hub"
        status={status?.installed ? "Armed" : "Idle"}
        title="Security Hub"
        subtitle="Install and manage antivirus engines."
      />

      {!status ? (
        <p className="osv-muted">Loading…</p>
      ) : (
        <EngineCard
          engine="clamav"
          label="ClamAV"
          description="Open-source antivirus engine"
          status={status}
          onInstallChange={onInstallChange}
        />
      )}
    </div>
  );
}

type EngineCardProps = {
  engine: "clamav";
  label: string;
  description: string;
  status: InstallStatus;
  onInstallChange: () => void;
};

function EngineCard({ engine, label, description, status, onInstallChange }: EngineCardProps) {
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installed = status.installed && status.engine === engine;
  const busy = installing || uninstalling;

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      const response = await fetch("http://localhost:4000/api/install-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
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
    setUninstalling(true);
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
      setUninstalling(false);
    }
  }

  return (
    <div className="osv-panel">
      <div className="osv-record-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="osv-record-path">{label}</span>
          <span className="osv-record-meta" style={{ marginTop: 0 }}>
            {installed
              ? `${description}${status.installedAt ? ` · installed ${new Date(status.installedAt).toLocaleDateString()}` : ""}`
              : description}
          </span>
        </div>
        <StatusPill tone={busy ? "warn" : installed ? "ok" : "neutral"}>
          {installing ? "Installing…" : uninstalling ? "Removing…" : installed ? "Installed" : "Not installed"}
        </StatusPill>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {installed ? (
          <button className="osv-btn osv-btn--danger" onClick={handleUninstall} disabled={uninstalling}>
            {uninstalling ? `Uninstalling ${label}` : `Uninstall ${label}`}
          </button>
        ) : (
          <button className="osv-btn osv-btn--primary" onClick={handleInstall} disabled={installing}>
            {installing ? `Installing ${label}` : `Install ${label}`}
          </button>
        )}
      </div>

      {busy && (
        <div className="osv-result">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#85d5c6",
                animation: "splash-pulse 1.2s infinite",
                flexShrink: 0,
              }}
            />
            <p style={{ margin: 0 }}>
              {installing ? `Installing ${label}` : `Removing ${label}`} — approve the
              Windows permission (UAC) prompt to continue. This can take a minute,
              and the window may look idle while it works.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="osv-result">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <StatusPill tone="warn">Notice</StatusPill>
            <p style={{ margin: 0 }}>{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
