import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";

type LogLine = {
  id: number;
  type: "log" | "done" | "error";
  text: string;
};

type AvConsoleProps = {
  onScanComplete: () => void;
};
  

export default function AvConsole({ onScanComplete }: AvConsoleProps) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [updating, setUpdating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [verboseScan, setVerboseScan] = useState(false);
  const [scanPath, setScanPath] = useState(
    `C:\\Users\\${window.navigator.platform.includes("Win") ? "" : ""}` 
  );
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
  fetch("http://localhost:4000/api/homedir")
    .then(r => r.json())
    .then(d => setScanPath(d.homedir + "\\Downloads"));
}, []);

  function addLog(type: LogLine["type"], text: string) {
    setLogs(prev => [...prev, { id: logCounter.current++, type, text }]);
  }

  function clearLogs() {
    setLogs([]);
  }

  function startUpdate() {
    clearLogs();
    setUpdating(true);
    const source = new EventSource("http://localhost:4000/api/av/update-definitions");

    source.onmessage = (e) => {
      const { type, data } = JSON.parse(e.data);
      addLog(type, data);
      if (type === "done" || type === "error") {
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
            addLog(type, data);
          } catch { /* partial chunk, skip */ }
        }
      }
    } catch (err) {
      addLog("error", "Scan request failed.");
    } finally {
      setScanning(false);
      onScanComplete();
    }
  }

  async function cancelScan() {
    try{
      const response = await fetch("http://localhost:4000/api/av/cancelscan", {method: "POST"});
    } catch (err) {
      console.error("Error fetching cancel! message:", err);
    } finally{
      setScanning(false);
    }
  }

  async function pickupHolder() {
    const selected = await open({directory:true, multiple:false});
    if(selected){
      setScanPath(selected as string);
    }
  }

  const busy = updating || scanning;

  return (
    <div>
      <h2>AV Console</h2>

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <button onClick={startUpdate} disabled={busy}>
          {updating ? "Updating..." : "Update Definitions"}
        </button>
        <button onClick={clearLogs} disabled={busy}>Clear</button>
      </div>
      <label>
        <input 
          type="checkbox"
          checked={verboseScan}
          onChange={e => setVerboseScan(e.target.checked)}
          />
          Show all files
      </label>
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <input
          value={scanPath}
          onChange={e => setScanPath(e.target.value)}
          placeholder="Path to scan"
          style={{ flex: 1 }}
        />
        <button onClick={startScan} disabled={busy}>
          {scanning ? "Scanning..." : "Scan"}
        </button>
        {scanning && (
        <button onClick={cancelScan}>Cancel</button>
        )}  
        <button onClick={pickupHolder} disabled={busy}>Browse</button>  
      </div>

      <div style={{
        background: "#111",
        color: "#eee",
        fontFamily: "monospace",
        fontSize: "12px",
        padding: "12px",
        height: "300px",
        overflowY: "auto",
        borderRadius: "4px"
      }}>
        {logs.length === 0 && <span style={{ color: "#666" }}>Output will appear here...</span>}
        {logs.map(line => (
          <div key={line.id} style={{
            color: line.type === "error" ? "#f87" : line.type === "done" ? "#4f4" : "#eee"
          }}>
            {line.text}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}