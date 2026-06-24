import { useState, useEffect } from "react";
import EmailCheck from "./EmailCheck";
import Dashboard from "./Dashboard";
import SecurityHub from "./SecurityHub";
import AvConsole from "./AvConsole";

type Tab = "email" | "dashboard" | "hub" | "console";

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("email");
  const [status, setStatus] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);

  useEffect(() => {
    async function checkBackend() {
      const response = await fetch("http://localhost:4000/health");
      const data = await response.json();
      setStatus(data.status);
    }
    checkBackend();
  }, []);

  async function fetchInstallStatus() {
    try {
      const response = await fetch("http://localhost:4000/api/install-status");
      const data = await response.json();
      setInstallStatus(data);
    } catch (error) {
      console.error("Failed to fetch install status:", error);
    }
  }

  useEffect(() => {
    fetchInstallStatus();
  }, []);

  return (
    <div>
      <nav style={{ display: "flex", gap: "1px" }}>
        <button onClick={() => setActiveTab("email")}>Email check</button>
        <button onClick={() => setActiveTab("dashboard")}>Dashboard</button>
        <button onClick={() => setActiveTab("hub")}>Security hub</button>
        {installStatus?.installed && (
          <button onClick={() => setActiveTab("console")}>AV console</button>
        )}
      </nav>

      <main>
        {activeTab === "email" && (
          <div className="tab-content">
            <EmailCheck />
          </div>
        )}
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "hub" && (
          <SecurityHub status={installStatus} onInstallChange={fetchInstallStatus}  />
        )}
        {activeTab === "console" && <AvConsole />}
        

        <div>Backend: {status ?? "checking..."}</div>
      </main>
    </div>
  );
}

export default App;