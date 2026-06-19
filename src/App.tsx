import { useState } from "react";
import { useEffect } from "react";
import EmailCheck from "./EmailCheck";
import Dashboard from "./Dashboard";
import SecurityHub from "./SecurityHub";

type Tab = "email" | "dashboard" | "hub" | "console";


function App() {
  const [activeTab, setActiveTab] = useState<Tab>("email");
  const [status, setStatus] = useState<string| null>(null);

  useEffect(() => {
  async function checkBackend() {
    const response = await fetch("http://localhost:4000/health");
    const data = await response.json();
    setStatus(data.status);
  }
  
  checkBackend();
}, [])
  return (
    
    <div>
      <nav style={{ display: "flex", gap: "1px" }}>
        <button onClick={() => setActiveTab("email")}>Email check</button>
        <button onClick={() => setActiveTab("dashboard")}>Dashboard</button>
        <button onClick={() => setActiveTab("hub")}>Security hub</button>
        <button onClick={() => setActiveTab("console")}>AV console</button>
      </nav>
      
      <main>
        {activeTab === 'email' && (
        <div className="tab-content">
        <EmailCheck />
        </div>
      )}
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "hub" && <SecurityHub />}
        {activeTab === "console" && <div>AV console tab — placeholder</div>}
        
        <div>Backend: {status ?? "checking..."}</div>
      </main>
    </div>
    
  );
}

export default App;