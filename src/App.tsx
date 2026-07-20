import { useState, useEffect } from "react";
import Dashboard from "./Dashboard";
import SecurityHub from "./SecurityHub";
import AvConsole from "./AvConsole";
import ScanHistory from "./ScanHistory";
import Threats from "./Threats";
import SplashScreen from "./SplashScreen";
import PixelTransition from "./PixelTransition";
import LetterGlitch from "./LetterGlitch";

import "./App.css";
import "./osava-ui.css";

type Tab = "dashboard" | "hub" | "console" | "threats" | "history";

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

const NAV_ITEMS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "System Health" },
  { id: "hub", label: "Security Hub" },
  { id: "console", label: "AV Console" },
  { id: "threats", label: "Threats" },
  { id: "history", label: "Scan History" },
];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

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
    if (item.id === "history" || item.id === "threats") return hasHistory;
    return true;
  });

  const shell = (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-wordmark">OSAVA</div>
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

      </aside>

      <main className="content">
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "hub" && (
          <SecurityHub
            status={installStatus}
            onInstallChange={fetchInstallStatus}
          />
        )}
        {activeTab === "console" && <AvConsole onScanComplete={checkHistory} />}
        {activeTab === "threats" && <Threats />}
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