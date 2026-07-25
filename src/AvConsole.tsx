import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { OsavaHeader } from "./OsavaUI";

type LogLine = {
  id: number;
  type: "log" | "done" | "error";
  text: string;
};

type AvConsoleProps = {
  onScanComplete: () => void;
};

// Cap how many log lines stay in the DOM so huge outputs (verbose scans of
// thousands of files) don't bog down rendering.
const MAX_LOGS = 1000;

export default function AvConsole({ onScanComplete }: AvConsoleProps) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState("");
  const [updating, setUpdating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [verboseScan, setVerboseScan] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Batch incoming lines: many can arrive per frame (a verbose scan emits one
  // per file). Buffer them and flush once per animation frame in a single
  // setState, instead of forcing a re-render for every line.
  const pending = useRef<LogLine[]>([]);
  const flushScheduled = useRef(false);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [logs, progress]);

  useEffect(() => {
    fetch("http://localhost:4000/api/homedir")
      .then(r => r.json())
      .then(d => setScanPath(d.homedir + "\\Downloads"));
  }, []);

  function flushLogs() {
    flushScheduled.current = false;
    const batch = pending.current;
    if (batch.length === 0) return;
    pending.current = [];
    setLogs(prev => {
      const next = prev.concat(batch);
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }

  function addLog(type: LogLine["type"], text: string) {
    pending.current.push({ id: logCounter.current++, type, text });
    if (!flushScheduled.current) {
      flushScheduled.current = true;
      requestAnimationFrame(flushLogs);
    }
  }

  // Route one streamed event: "progress" updates a single live line in place;
  // everything else appends as a normal log line.
  function handleEvent(type: string, data: string) {
    if (type === "progress") {
      setProgress(data);
    } else {
      addLog(type as LogLine["type"], data);
    }
  }

  function clearLogs() {
    pending.current = [];
    setLogs([]);
    setProgress("");
  }

  function startUpdate() {
    clearLogs();
    setUpdating(true);
    const source = new EventSource("http://localhost:4000/api/av/update-definitions");

    source.onmessage = (e) => {
      const { type, data } = JSON.parse(e.data);
      handleEvent(type, data);
      if (type === "done" || type === "error") {
        setProgress("");
        source.close();
        setUpdating(false);
      }
    };

    source.onerror = () => {
      addLog("error", "Connection to backend lost.");
      source.close();
      setUpdating(false);
    };
  }

  async function startScan() {
    clearLogs();
    setScanning(true);
    try {
      const response = await fetch(
        `http://localhost:4000/api/av/scan?path=${encodeURIComponent(scanPath)}&verbose=${verboseScan}`
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const dataLine = line.replace(/^data: /, "").trim();
          if (!dataLine) continue;
          try {
            const { type, data } = JSON.parse(dataLine);
            handleEvent(type, data);
          } catch { /* partial chunk, skip */ }
        }
      }
    } catch (err) {
      addLog("error", "Scan request failed.");
    } finally {
      setProgress("");
      setScanning(false);
      onScanComplete();
    }
  }

  async function cancelScan() {
    try {
      await fetch("http://localhost:4000/api/av/cancelscan", { method: "POST" });
    } catch (err) {
      console.error("Error fetching cancel! message:", err);
    } finally {
      setScanning(false);
    }
  }

  async function pickupHolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setScanPath(selected as string);
    }
  }

  const busy = updating || scanning;

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Terminal"
        status={scanning ? "Scanning" : updating ? "Updating" : "Operational"}
        title="AV Console"
        subtitle="Update definitions and run on-demand scans."
      />

      <div className="osv-toolbar">
        <button className="osv-btn" onClick={startUpdate} disabled={busy}>
          {updating ? "Updating…" : "Update Definitions"}
        </button>
        <button className="osv-btn" onClick={clearLogs} disabled={busy}>Clear</button>
        <div className="osv-toolbar-spacer" />
        <label className="osv-check">
          <input
            type="checkbox"
            checked={verboseScan}
            onChange={e => setVerboseScan(e.target.checked)}
          />
          Show all files
        </label>
      </div>

      <div className="osv-field-row" style={{ marginBottom: 14 }}>
        <input
          className="osv-input"
          value={scanPath}
          onChange={e => setScanPath(e.target.value)}
          placeholder="Path to scan"
        />
        <button className="osv-btn" onClick={pickupHolder} disabled={busy}>Browse</button>
        {scanning ? (
          <button className="osv-btn osv-btn--danger" onClick={cancelScan}>Cancel</button>
        ) : (
          <button className="osv-btn osv-btn--primary" onClick={startScan} disabled={busy}>Scan</button>
        )}
      </div>

      <div className="osv-terminal">
        {logs.length === 0 && !progress && (
          <span className="osv-term-empty">Output will appear here…</span>
        )}
        {logs.map(line => (
          <div
            key={line.id}
            className={
              "osv-term-line" +
              (line.type === "done"
                ? " osv-term-line--done"
                : line.type === "error"
                  ? " osv-term-line--error"
                  : "")
            }
          >
            {line.text}
          </div>
        ))}
        {progress && (
          <div className="osv-term-line" style={{ opacity: 0.7 }}>{progress}</div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
