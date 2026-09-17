import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { OsavaHeader } from "./OsavaUI";

type LogLine = {
  id: number;
  type: "log" | "done" | "error" | "command";
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
  const [scanning, setScanning] = useState(false);
  const [verboseScan, setVerboseScan] = useState(false);
  const [scanPath, setScanPath] = useState("");
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [presets, setPresets] = useState<{ id: string; label: string; command: string }[]>([]);

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

  // The backend owns the exact command strings (it knows the config paths), so
  // a button is just a command you could have typed yourself.
  useEffect(() => {
    fetch("http://localhost:4000/api/av/commands")
      .then(r => r.json())
      .then(setPresets)
      .catch(() => setPresets([]));
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

  async function startScan() {
    clearLogs();
    setScanning(true);
    try {
      const response = await fetch(
        `http://localhost:4000/api/av/scan?path=${encodeURIComponent(scanPath)}&verbose=${verboseScan}`
      );
      await streamEvents(response);
    } catch (err) {
      addLog("error", "Scan request failed.");
    } finally {
      setProgress("");
      setScanning(false);
      onScanComplete();
    }
  }

  /**
   * Read one streamed response into the log. A rejected request (400/409) sends
   * a JSON error instead of a stream, so that's surfaced rather than fed to the
   * reader, which would chew through it silently.
   */
  async function streamEvents(response: Response) {
    if (!response.ok) {
      const data = await response.json();
      addLog("error", data.error || "Command failed");
      return;
    }

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
  }

  function submitInput() {
    const cmd = input.trim();
    if (!cmd || running) return;
    setInput("");
    runCommand(cmd);
  }

  async function runCommand(cmd: string) {
    setRunning(true);
    try {
      const response = await fetch("http://localhost:4000/api/av/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      await streamEvents(response);
    } catch (err) {
      addLog("error", "Command request failed.");
    } finally {
      setProgress("");
      setRunning(false);
      // A typed clamscan is recorded in history too, so refresh it.
      if (cmd.trimStart().startsWith("clamscan")) onScanComplete();
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

  const busy = scanning || running;

  return (
    <div className="osv-tab">
      <OsavaHeader
        eyebrow="Terminal"
        status={scanning ? "Scanning" : running ? "Running" : "Operational"}
        title="AV Console"
        subtitle="Run ClamAV commands directly, or use a shortcut."
      />

      <div className="osv-toolbar">
        {presets.map(preset => (
          <button
            key={preset.id}
            className="osv-btn"
            onClick={() => runCommand(preset.command)}
            disabled={busy}
            title={preset.command}
          >
            {preset.label}
          </button>
        ))}
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
                  : line.type === "command"
                    ? " osv-term-line--command"
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

      <div className="osv-field-row" style={{ marginTop: 10 }}>
        <input
          className="osv-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submitInput(); }}
          placeholder="clamscan --version"
          disabled={busy}
          spellCheck={false}
        />
        {running ? (
          <button className="osv-btn osv-btn--danger" onClick={cancelScan}>Cancel</button>
        ) : (
          <button className="osv-btn osv-btn--primary" onClick={submitInput} disabled={busy}>Run</button>
        )}
      </div>
    </div>
  );
}
