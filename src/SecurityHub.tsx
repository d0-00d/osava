import {useEffect, useState} from "react";

type installStatus = {
    installed: boolean;
    engine: string | null;
    installedAt: string | null;
};



export default function SecurityHub() {
    const [status, setStatus] = useState<installStatus | null>(null);
    const [installing, setInstalling] = useState(false);
    useEffect(() => {
        fetchStatus();
    }, []);
    async function fetchStatus() {
  try {
    const response = await fetch("http://localhost:4000/api/install-status");
    const data = await response.json();
    setStatus(data);
  } catch (error) {
    console.error("Failed to fetch install status:", error);
  }
}

    async function handleInstall() {
        setInstalling(true);
        try {
            await fetch("http://localhost:4000/api/install-status", { method: "POST" });
            await fetchStatus();
        } finally {
        setInstalling(false);
        }
  }
  if (!status) return <div>Loading...</div>;
  return (
    <div>
        <h2>Security Hub</h2>
        <div>
            <h3>Clam AV</h3>
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