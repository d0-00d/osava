import { useState, useEffect, useRef } from "react";
import Dashboard from "./Dashboard";
import SecurityHub from "./SecurityHub";
import AvConsole from "./AvConsole";
import ScanHistory from "./ScanHistory";
import Threats from "./Threats";
import SplashScreen from "./SplashScreen";
import PixelHandoff from "./PixelHandoff";
import PixelFlowBackground from "./PixelFlowBackground";
import type { PixelFlowHandle } from "./pixelFlow";

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
  const [threatAlert, setThreatAlert] = useState(0);
  // Shared with the splash so the backdrop is one continuous instance across
  // the handoff instead of the splash spawning and destroying its own.
  const flowRef = useRef<PixelFlowHandle | null>(null);

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
        // The newest record is the current picture: threats in the last scan
        // turn the backdrop amber until a later scan comes back clean.
        setThreatAlert((d[0]?.infectedFiles?.length ?? 0) > 0 ? 1 : 0);
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
        <div hidden={activeTab !== "console"}>
        <AvConsole onScanComplete={checkHistory} />
        </div>
        {activeTab === "threats" && <Threats />}
        {activeTab === "history" && <ScanHistory />}
      </main>
    </div>
  );

  // Faint animated backdrop, fixed behind everything (splash + shell). The
  // surfaces on top (.content/.sidebar) are translucent so it shows through —
  // see App.css. The splash paints its own opaque flow over this one.
  const backdrop = (
    <div className="app-bg" aria-hidden="true">
      {/* The index (not the id) is what makes the sweep directional: moving down
          the nav sweeps downward, moving back up sweeps upward. */}
      <PixelFlowBackground
        controlRef={flowRef}
        burstKey={NAV_ITEMS.findIndex(item => item.id === activeTab)}
        alert={threatAlert}
      />
    </div>
  );

  // Until the handoff finishes, the curtain owns the screen: it holds the
  // splash, dithers across to cover it, swaps the shell in underneath, then
  // dissolves away to reveal it. pixelSize matches the backdrop so the curtain
  // and the flow read as the same material.
  return (
    <>
      {backdrop}
      {!initialized ? (
        <PixelHandoff
          active={transitioning}
          onComplete={() => setInitialized(true)}
          durationMs={1100}
          pixelSize={2}
          direction="down"
          firstContent={
            <SplashScreen
              flowRef={flowRef}
              onComplete={() => setTransitioning(true)}
              tagline="Security Suite"
              footer="OSAVA v1.0.0 // BEING gay is ok! desu"
              launchLabel="Launch DESU!!"
            />
          }
          secondContent={shell}
        />
      ) : (
        shell
      )}
    </>
  );
}

export default App;