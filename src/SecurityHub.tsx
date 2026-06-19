import { useState } from "react";

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
};

type SecurityHubProps = {
  status: InstallStatus | null;
  onInstallChange: () => void;
};

export default function SecurityHub({ status, onInstallChange }: SecurityHubProps) {
  const [installing, setInstalling] = useState(false);

  async function handleInstall() {
    setInstalling(true);
    try {
      await fetch("http://localhost:4000/api/install-status", { method: "POST" });
      await onInstallChange();
    } finally {
      setInstalling(false);
    }
  }

  if (!status) return <p>Loading...</p>;

  return (
    <div>
      <h2>Security Hub</h2>
      <div>
        <h3>ClamAV</h3>
        {status.installed ? (
          <p>Installed ({status.engine})</p>
        ) : (
          <button onClick={handleInstall} disabled={installing}>
            {installing ? "Installing..." : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}