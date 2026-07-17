import { useState, useEffect, useRef } from "react";
import Shuffle from "./Shuffle";

type TerminalLine = {
  text: string;
  type: "log" | "ok" | "warn" | "done";
};

type SplashCompleteData = {
  installStatus: any;
  hasHistory: boolean;
};

type SplashProps = {
  onComplete: (data: SplashCompleteData) => void;
};

export default function SplashScreen({ onComplete }: SplashProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [allDone, setAllDone] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom on new lines
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    // StrictMode double-invokes this effect in dev. Without a cancel flag the
    // first run keeps polling and opens a second EventSource, which is why the
    // boot log used to print every line twice.
    let cancelled = false;
    let eventSource: EventSource | null = null;

    function addLine(text: string, type: TerminalLine["type"]) {
      if (cancelled) return;
      setLines(prev => [...prev, { text, type }]);
    }

    /**
     * First, wait for the backend to be reachable, showing connection
     * attempts in the terminal. Then connect to the /api/boot SSE
     * endpoint and stream real initialization logs.
     */
    async function waitForBackend() {
      addLine("osava splash // connecting to backend...", "log");
      addLine("", "log");

      let attempts = 0;
      const maxAttempts = 30; // ~15 seconds

      const tryConnect = async (): Promise<boolean> => {
        try {
          const r = await fetch("http://localhost:4000/health", {
            signal: AbortSignal.timeout(2000),
          });
          const d = await r.json();
          return d.status === "ok";
        } catch {
          return false;
        }
      };

      while (attempts < maxAttempts) {
        if (cancelled) return false;
        attempts++;
        const ok = await tryConnect();
        if (cancelled) return false;
        if (ok) {
          addLine(`> Backend reached after ${attempts} attempt(s)`, "ok");
          addLine("", "log");
          return true;
        }
        addLine(`  attempt ${attempts}... waiting`, "log");
        await new Promise(res => setTimeout(res, 500));
      }

      addLine("> Could not reach backend after 15s", "warn");
      addLine("  Start the backend with: cd backend && npm run dev", "warn");
      if (!cancelled) setAllDone(true);
      return false;
    }

    async function streamBoot() {
      const reached = await waitForBackend();
      if (cancelled || !reached) return;

      addLine("> Streaming backend initialization...", "log");
      addLine("", "log");

      eventSource = new EventSource("http://localhost:4000/api/boot");

      eventSource.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data);
          const type = data.type as TerminalLine["type"];
          const text = data.text as string;

          addLine(text, type);

          if (type === "done") {
            eventSource?.close();
            setAllDone(true);
          }
        } catch {
          // ignore malformed events
        }
      };

      eventSource.onerror = () => {
        if (cancelled) return;
        eventSource?.close();
        addLine("> Connection to boot stream lost", "warn");
        setAllDone(true);
      };
    }

    streamBoot();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, []);

  function getLineClass(type: TerminalLine["type"]): string {
    switch (type) {
      case "ok": return "splash-status-ok";
      case "warn": return "splash-status-warn";
      case "done": return "splash-status-ok";
      default: return "";
    }
  }

  return (
    <div className="splash-container">
      <div className="splash-scanline" />

      <div className="splash-card">
        <div className="splash-indicator">
        </div>

        <Shuffle
          tag="h1"
          className="splash-title"
          text="Welcome to OSAVA"
          shuffleDirection="right"
          duration={0.35}
          animationMode="evenodd"
          shuffleTimes={2}
          ease="power3.out"
          stagger={0.03}
          scrambleCharset="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@*"
          threshold={0.1}
          triggerOnce={true}
          triggerOnHover={true}
          respectReducedMotion={true}
        />

        <div className="splash-terminal" ref={termRef}>
          {lines.map((line, i) => (
            <div key={i} className="splash-line">
              {line.text === "" ? (
                <span>&nbsp;</span>
              ) : (
                <>
                  {line.type === "log" && line.text.startsWith(">") && (
                    <span className="splash-prompt">&gt;</span>
                  )}
                  <span className={getLineClass(line.type)}>
                    {line.text.startsWith(">") ? line.text.slice(1).trimStart() : line.text}
                  </span>
                </>
              )}
            </div>
          ))}
          {!allDone && (
            <div className="splash-line">
              <span className="splash-cursor">_</span>
            </div>
          )}
        </div>

        {allDone && (
          <button
            className="splash-btn"
            onClick={() => onComplete({
              installStatus: null,
              hasHistory: false,
            })}
          >
            Launch OSAVA
          </button>
        )}
      </div>

      <div className="splash-footer">OSAVA v1.0.0 // Security Suite</div>
    </div>
  );
}