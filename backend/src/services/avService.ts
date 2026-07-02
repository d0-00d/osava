import { spawn, ChildProcess } from "node:child_process";
import { CLAMAV_DIR, CLAMDB_DIR, FRESHCLAM_CONF, currentScan } from "../config";
import { appendHistoryRecord} from "./statusFile";
import type { ScanRecord } from "../types";

export function updateDefinitions(
  onEvent: (type: string, data: string) => void,
  onEnd: (code: number | null) => void
): ChildProcess {
  onEvent("log", "Starting definitions update...");

  const freshclam = spawn(
    `${CLAMAV_DIR}\\freshclam.exe`,
    [`--config-file=${FRESHCLAM_CONF}`],
    { shell: false }
  );

  freshclam.stdout.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => onEvent("log", line));
  });

  freshclam.stderr.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => onEvent("log", line));
  });

  freshclam.on("close", (code) => {
    if (code === 0) {
      onEvent("done", "Definitions updated successfully!");
    } else {
      onEvent("error", `freshclam exited with code ${code}`);
    }
    onEnd(code);
  });

  return freshclam;
}

export function startScan(
  scanPath: string,
  verbose: boolean,
  onEvent: (type: string, data: string) => void,
  onEnd: (code: number | null) => void
): ChildProcess {
  const args = [
    "--database", CLAMDB_DIR,
    "--recursive",
    "--max-filesize=25M",
    "--max-scansize=100M",
    scanPath
  ];
  if (!verbose) args.splice(2, 0, "--infected");

  onEvent("log", `Starting scan of: ${scanPath}`);
  const startAt = new Date().toISOString();
  const infectedFiles: string[] = [];
  const clamscan = spawn(
    `${CLAMAV_DIR}\\clamscan.exe`, args,
    { shell: false }
  );
  currentScan.currentScan = clamscan;

  clamscan.stdout.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => {
        const isInfected = line.includes("FOUND");
        onEvent(isInfected ? "error" : "log", line);
        if (isInfected) {
          const filename = line.split(":")[0]?.trim();
          if (filename) {
            infectedFiles.push(filename);
          }
        }
      });
  });

  clamscan.stderr.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => onEvent("log", line));
  });

  let heartbeat: NodeJS.Timeout | null = null;
  if (!verbose) {
    heartbeat = setInterval(() => onEvent("log", "Scanning..."), 3000);
  }

  clamscan.on("close", async (code) => {
  if (heartbeat) clearInterval(heartbeat);
  
  const record: ScanRecord = {
    id: Date.now().toString(),
    path: scanPath,
    startAt,
    finishedAt: new Date().toISOString(),
    outcome: code === null ? "cancelled" : code === 0 ? "clean" : code === 1 ? "infected" : "error",
    infectedFiles,
    verbose,
  };
  await appendHistoryRecord(record);
  
  if (code === null) {
    onEvent("log", "Scan cancelled.");
  } else if (code === 0) {
    onEvent("done", "Scan complete. No threats found.");
  } else if (code === 1) {
    onEvent("error", "Scan complete. Threats were found!");
  } else {
    onEvent("error", `Scan exited with code ${code}`);
  }
  
  currentScan.currentScan = null;
  onEnd(code);
});
return clamscan;
}
export function cancelScan(): { success: boolean; error?: string; message?: string } {
  if (currentScan.currentScan === null) {
    return {
      success: false,
      error: "No scan is currently running!"
    };
  }
  const signalSent = currentScan.currentScan.kill();
  if (!signalSent) {
    return {
      success: false,
      error: "Failed to send termination signal."
    };
  }

  return {
    success: true,
    message: "Cancellation requested."
  };
}
