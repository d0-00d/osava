import { useState, useEffect } from "react";
import EmailCheck from "./EmailCheck";
import Dashboard from "./Dashboard";
import SecurityHub from "./SecurityHub";
import AvConsole from "./AvConsole";
import ScanHistory from "./ScanHistory";
import SplashScreen from "./SplashScreen";
import PixelTransition from "./PixelTransition";
import LetterGlitch from "./LetterGlitch";

import "./App.css";

type Tab = "email" | "dashboard" | "hub" | "console" | "history";

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

const NAV_ITEMS: { id: Tab; label: string }[] = [
  { id: "email", label: "Email Check" },
  { id: "dashboard", label: "System Health" },
  { id: "hub", label: "Security Hub" },
  { id: "console", label: "AV Console" },
  { id: "history", label: "Scan History" },
];

const PAGE_TITLES: Record<Tab, { title: string; subtitle: string }> = {
  email: { title: "Email Check", subtitle: "Check if an email address appears in known data breaches" },
  dashboard: { title: "System Health", subtitle: "Live protection status pulled from Windows Security Center" },
  hub: { title: "Security Hub", subtitle: "Install and manage antivirus engines" },
  console: { title: "AV Console", subtitle: "Update definitions and run on-demand scans" },
  history: { title: "Scan History", subtitle: "Record of completed scans and detected threats" },
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("email");
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  useEffect(() => {

    fetch("http://localhost:4000/health")
      .then(r => r.json())
      .then(d => setBackendStatus(d.status))
      .catch(() => setBackendStatus("offline"));
  }, []);

  async function fetchInstallStatus() {
    try {
      const r = await fetch("http://localhost:4000/api/install-status");
      const d = await r.json();
      setInstallStatus(d);
    } catch (e) {
      console.error("Failed to fetch install status:", e);
    }
  }

  async function checkHistory() {
    try {
      const r = await fetch("http://localhost:4000/api/av/history");
      if (r.ok) {
        const d = await r.json();
        setHasHistory(d.length > 0);
      }
    } catch (e) {
      console.error("Failed to check history:", e);
    }
  }

  useEffect(() => { fetchInstallStatus(); }, []);
  useEffect(() => { checkHistory(); }, []);

  const visibleTabs = NAV_ITEMS.filter(item => {
    if (item.id === "console") return installStatus?.installed;
    if (item.id === "history") return hasHistory;
    return true;
  });

  const { title, subtitle } = PAGE_TITLES[activeTab] ?? PAGE_TITLES.email;

  const shell = (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-wordmark">OSAVA</div>
          <div className="sidebar-tagline">Open Source Antivirus</div>
          <div className="sidebar-tagline">Security Suite</div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Navigation</div>
          {visibleTabs.map(item => (
            <button
              key={item.id}
              className={`nav-item ${activeTab === item.id ? "active" : ""}`}
              onClick={() => setActiveTab(item.id)}
            >
              <span className="nav-item-dot" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-status-dot" style={{
            background: backendStatus === "ok" ? "var(--status-ok)" : "var(--status-threat)"
          }} />
          {backendStatus === "ok" ? "backend online" : "backend offline"}
        </div>
      </aside>

      <main className="content">
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>

        {activeTab === "email" && <EmailCheck />}
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "hub" && (
          <SecurityHub
            status={installStatus}
            onInstallChange={fetchInstallStatus}
          />
        )}
        {activeTab === "console" && <AvConsole onScanComplete={checkHistory} />}
        {activeTab === "history" && <ScanHistory />}
      </main>
    </div>
  );

  // Faint animated LetterGlitch backdrop, fixed behind everything (splash + shell).
  // The surfaces on top (.content/.sidebar/.splash-container) are translucent so
  // it shows through — see App.css.
  const backdrop = (
    <div className="app-bg" aria-hidden="true">
      <LetterGlitch
        glitchColors={["#ffffff", "#adb8ab", "#f0f0f0"]}
        glitchSpeed={20}
        centerVignette
        outerVignette
        smooth
      />
    </div>
  );

  // Until the handoff finishes, the transition owns the screen: it holds the
  // splash, covers it with the pixel grid, swaps the shell in underneath, then
  // dissolves away to reveal it.
  return (
    <>
      {backdrop}
      {!initialized ? (
        <PixelTransition
          active={transitioning}
          onComplete={() => setInitialized(true)}
          gridSize={28}
          pixelColor="#e3e3ec"
          animationStepDuration={0.5}
          holdDuration={0.12}
          firstContent={<SplashScreen onComplete={() => setTransitioning(true)} />}
          secondContent={shell}
        />
      ) : (
        shell
      )}
    </>
  );
}

export default App;