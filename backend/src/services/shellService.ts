import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { CLAMAV_DIR, CLAMDB_DIR, FRESHCLAM_CONF, currentScan } from "../config";
import { ensureClamConfig } from "./clamavConfig";
import { makeLineHandler } from "./avService";
import { appendHistoryRecord } from "./statusFile";
import type { ScanRecord } from "../types";

/**
 * Only these binaries can be run, and only from CLAMAV_DIR. The console takes
 * a typed command line, so the binary is never taken from user input as a path
 * — it's looked up by bare name here. Everything is spawned with shell:false,
 * so quotes/pipes/redirects/`&&` in the input are inert: they can only ever
 * become literal argv entries, never shell syntax.
 */
const ALLOWED_BINARIES: Record<string, string> = {
  clamscan: "clamscan.exe",
  freshclam: "freshclam.exe",
  sigtool: "sigtool.exe",
  clamconf: "clamconf.exe",
};

export class CommandError extends Error {}

/**
 * Split a command line into argv. Double quotes group a run of characters
 * (needed for "C:\Program Files\..."); a backslash is always literal, since
 * on Windows it's a path separator rather than an escape.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasContent = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
    } else if (!inQuotes && /\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
    } else {
      current += char;
      hasContent = true;
    }
  }

  if (inQuotes) throw new CommandError("Unterminated quote in command");
  if (hasContent) tokens.push(current);

  return tokens;
}

export function resolveCommand(line: string): { binary: string; args: string[]; name: string } {
  const [head, ...args] = tokenize(line);
  if (!head) throw new CommandError("Empty command");

  // Accept "clamscan" and "clamscan.exe" alike, but nothing path-shaped.
  const name = head.toLowerCase().replace(/\.exe$/, "");
  const exe = ALLOWED_BINARIES[name];
  if (!exe) {
    throw new CommandError(
      `Not an allowed command: ${head}. Available: ${Object.keys(ALLOWED_BINARIES).join(", ")}`
    );
  }

  return { binary: path.join(CLAMAV_DIR, exe), args, name };
}

/** The prefab commands the console's buttons run. */
export function getPresetCommands() {
  return [
    {
      id: "update",
      label: "Update Definitions",
      command: `freshclam --config-file="${FRESHCLAM_CONF}"`,
    },
    {
      id: "version",
      label: "Version",
      command: "clamscan --version",
    },
    {
      id: "config",
      label: "Show Config",
      command: "clamconf",
    },
  ];
}

/**
 * The Scan button's command line. Built here because the database directory is
 * server-side knowledge, and echoing it to the console keeps a button honest:
 * it's the same string you could have typed yourself.
 */
export function buildScanCommand(scanPath: string, verbose: boolean): string {
  const flags = [
    `--database "${CLAMDB_DIR}"`,
    "--recursive",
    "--max-filesize=25M",
    "--max-scansize=100M",
  ];
  if (!verbose) flags.push("--infected");
  return `clamscan ${flags.join(" ")} "${scanPath}"`;
}

// Flags that make clamscan print something and exit without scanning, so a run
// with one of them shouldn't land in scan history.
const INFO_ONLY_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

/**
 * clamscan's usage is `clamscan [options] [target]`, so the scanned path is the
 * final argument. A hand-typed command can end on a flag instead, in which case
 * clamscan falls back to the working directory and so do we.
 */
function scanTargetFrom(args: string[]): string {
  const last = args[args.length - 1];
  return last && !last.startsWith("-") ? last : ".";
}

export function runCommand(
  line: string,
  onEvent: (type: string, data: string) => void,
  onEnd: (code: number | null) => void
): ChildProcess {
  const { binary, args, name } = resolveCommand(line);

  // Any clamscan run is recorded, whether it came from the button or was typed.
  const isScan = name === "clamscan" && !args.some((a) => INFO_ONLY_FLAGS.has(a));
  const infectedFiles: string[] = [];
  const startedAt = new Date().toISOString();
  let scannedDirs: number | undefined;
  let scannedFiles: number | undefined;

  // Idempotent, and self-heals a db dir/conf that was never created.
  try {
    ensureClamConfig();
  } catch (e: any) {
    onEvent("error", `Failed to prepare ClamAV config: ${e.message}`);
  }

  onEvent("command", line);

  const child = spawn(binary, args, { shell: false });
  currentScan.currentScan = child;

  const onLog = (l: string) => {
    if (isScan) {
      // clamscan's SCAN SUMMARY reports the counts; nothing else knows them.
      const dirs = l.match(/^Scanned directories:\s*(\d+)/);
      if (dirs?.[1]) scannedDirs = Number(dirs[1]);
      const files = l.match(/^Scanned files:\s*(\d+)/);
      if (files?.[1]) scannedFiles = Number(files[1]);
    }

    if (isScan && l.includes("FOUND")) {
      const filename = l.substring(0, l.lastIndexOf(":")).trim();
      if (filename) infectedFiles.push(filename);
      onEvent("error", l);
    } else {
      onEvent("log", l);
    }
  };
  const onProgress = (l: string) => onEvent("progress", l);
  child.stdout.on("data", makeLineHandler(onLog, onProgress));
  child.stderr.on("data", makeLineHandler(onLog, onProgress));

  let failedToStart = false;
  child.on("error", (err: NodeJS.ErrnoException) => {
    failedToStart = true;
    onEvent(
      "error",
      err.code === "ENOENT"
        ? `${path.basename(binary)} not found — is ClamAV installed?`
        : `Could not run ${path.basename(binary)}: ${err.message}`
    );
  });

  child.on("close", async (code) => {
    currentScan.currentScan = null;

    if (isScan && !failedToStart) {
      const record: ScanRecord = {
        id: Date.now().toString(),
        path: scanTargetFrom(args),
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome:
          code === null ? "cancelled" : code === 0 ? "clean" : code === 1 ? "infected" : "error",
        infectedFiles,
        verbose: !args.includes("--infected"),
        scannedDirs,
        scannedFiles,
      };
      await appendHistoryRecord(record);
    }

    // The error handler already said why; a raw exit code adds only noise.
    if (failedToStart) {
      onEvent("done", "");
    } else if (code === null) {
      onEvent("log", isScan ? "Scan cancelled." : "Command cancelled.");
    } else if (isScan && code === 0) {
      onEvent("done", "Scan complete. No threats found.");
    } else if (isScan && code === 1) {
      onEvent("error", "Scan complete. Threats were found!");
    } else if (code === 0) {
      onEvent("done", "Exited with code 0");
    } else {
      onEvent("error", `Exited with code ${code}`);
    }
    onEnd(code);
  });

  return child;
}
