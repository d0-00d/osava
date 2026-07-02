import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallStatus, ScanRecord } from "../types";

const STATUS_FILE = path.join(os.homedir(), ".osava", "install-status.json");

export async function readStatusFile(): Promise<InstallStatus> {
  try {
    await fs.access(STATUS_FILE);
    const data = await fs.readFile(STATUS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { installed: false, engine: null, installedAt: null, productCode: null };
  }
}

export async function writeStatusFile(status: InstallStatus): Promise<void> {
  await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8");
}

export async function readHistoryFile(): Promise<ScanRecord[]> {
  const historyFile = path.join(os.homedir(), ".osava", "scan-history.json");
    try {
    await fs.access(historyFile);
    const data = await fs.readFile(historyFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function appendHistoryRecord(record: ScanRecord): Promise<void> {
  try{
    const historyFile = path.join(os.homedir(), ".osava", "scan-history.json");
    const history = await readHistoryFile();
    history.unshift(record);
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(historyFile, JSON.stringify(history, null, 2), "utf-8");
    if (history.length > 100) history.splice(100);
  } catch (error) {
    console.error("Error appending to history file:", error);
  }
}
