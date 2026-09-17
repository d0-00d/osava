import { spawn, ChildProcess } from "node:child_process";
import { CLAMAV_DIR, FRESHCLAM_CONF, currentScan } from "../config";
import { ensureClamConfig } from "./clamavConfig";

/**
 * Turns a child process's raw stdout/stderr into clean events. Handles two
 * things a naive `split("\n")` didn't:
 *   - buffers partial lines across chunks, so a line split between two reads
 *     isn't emitted half-formed;
 *   - treats a carriage return (\r) as "redraw this line" — which is how tools
 *     like freshclam animate a download bar. Instead of emitting a new log line
 *     for every redraw (hundreds per second), it surfaces only the latest state
 *     as a throttled "progress" event.
 *
 * Returns a function to attach to a stream's "data" event. Give stdout and
 * stderr their own handler (own buffer) so they don't corrupt each other.
 */
export function makeLineHandler(
  onLog: (line: string) => void,
  onProgress: (line: string) => void
) {
  let buffer = "";
  let lastProgressAt = 0;
  return (chunk: Buffer) => {
    buffer += chunk.toString();

    // Emit each completed (newline-terminated) line as a permanent log line.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      // Drop CRLF's own \r first, or the redraw logic below would treat it as a
      // progress redraw and slice the whole line away to nothing.
      const raw = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      // A finished line may still carry \r redraws — keep only its final state.
      const cr = raw.lastIndexOf("\r");
      const line = (cr === -1 ? raw : raw.slice(cr + 1)).trim();
      if (line) onLog(line);
    }

    // The leftover is an unfinished line. If it's being redrawn with \r (a
    // progress bar), collapse the redraws and surface just the latest state,
    // at most ~7x/second.
    const cr = buffer.lastIndexOf("\r");
    if (cr !== -1) {
      buffer = buffer.slice(cr + 1); // collapse so the buffer can't grow
      const current = buffer.trim();
      const now = Date.now();
      if (current && now - lastProgressAt >= 150) {
        lastProgressAt = now;
        onProgress(current);
      }
    }
  };
}

export function updateDefinitions(
  onEvent: (type: string, data: string) => void,
  onEnd: (code: number | null) => void
): ChildProcess {
  onEvent("log", "Starting definitions update...");

  // Make sure the db dir + freshclam.conf exist (self-heals a bad install).
  try {
    ensureClamConfig();
  } catch (e: any) {
    onEvent("error", `Failed to prepare ClamAV config: ${e.message}`);
  }

  const freshclam = spawn(
    `${CLAMAV_DIR}\\freshclam.exe`,
    [`--config-file=${FRESHCLAM_CONF}`],
    { shell: false }
  );

  const onLog = (line: string) => onEvent("log", line);
  const onProgress = (line: string) => onEvent("progress", line);
  freshclam.stdout.on("data", makeLineHandler(onLog, onProgress));
  freshclam.stderr.on("data", makeLineHandler(onLog, onProgress));

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
