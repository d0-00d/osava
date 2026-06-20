import { useState } from "react";


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
      if (!response.ok)
        throw new Error(data.error || "Uninstall failed");
      await onInstallChange();
    } catch (err) {
      console.error("Uninstall request failed.", err);
      setError("Could not reach the backend");
    } finally {
      setUninstall(false);
    }
  }

  if (!status) return <p>Loading...</p>;

  return (
    <div>
      <h2>Security Hub</h2>
      <div>
        <h3>ClamAV</h3>
        {status.installed ? (
          <>
            <p>Installed ({status.engine})</p>
            <button onClick={handleUninstall} disabled={uninstall}>
            {uninstall ? "Uninstalling..." : "Uninstall"}
          </button>
          </>
        ) : (
          <button onClick={handleInstall} disabled={installing}>
            {installing ? "Installing..." : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}