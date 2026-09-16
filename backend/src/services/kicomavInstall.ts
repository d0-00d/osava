import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallStatus } from "../types";

const execFile = promisify(execFileCallback);

const KICOMAV_DIR = path.join(os.homedir(), ".osava", "kicomav");
const KICOMAV_EXECUTABLE = path.join(KICOMAV_DIR, "k2.exe");

// Under pkg the backend runs from a virtual filesystem, so __dirname points at a
// C:\snapshot\... path that doesn't exist on disk. process.execPath is the real
// osava-backend.exe, and Tauri installs resources/ as its sibling.
function isPackaged(): boolean {
  return Boolean((process as any).pkg) || Boolean(process.env.PKG_EXECPATH);
}

function resolveBundledK2(): string {
  if (isPackaged()) {
    return path.join(path.dirname(process.execPath), "resources", "kicomav", "k2.exe");
  }
  // Dev: __dirname is real here — backend/src/services -> repo root.
  return path.join(__dirname, "..", "..", "..", "src-tauri", "vendor", "k2.exe");
}

// KicomAV writes signature updates next to its own executable, so it can't run
// from the install directory under Program Files. Copy it into the user profile
// first and run the writable copy.
export async function installKicomAV(): Promise<InstallStatus> {
  const source = resolveBundledK2();

  try {
    await fs.access(source);
  } catch {
    throw new Error(`Bundled KicomAV binary not found at ${source}`);
  }

  await fs.mkdir(KICOMAV_DIR, { recursive: true });

  try {
    await fs.copyFile(source, KICOMAV_EXECUTABLE);
    // Smoke-test the copy so a truncated or blocked exe fails here rather than
    // on the user's first scan.
    await execFile(KICOMAV_EXECUTABLE, ["--help"]);
  } catch (error) {
    // Never leave a half-installed executable behind.
    await fs.unlink(KICOMAV_EXECUTABLE).catch(() => {});
    throw error;
  }

  return {
    installed: true,
    engine: "kicomav",
    installedAt: new Date().toISOString(),
    productCode: null,
  };
}


export async function uninstallKicomAV(): Promise<InstallStatus> {
  try {
    await fs.unlink(KICOMAV_EXECUTABLE);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { installed: false, engine: null, installedAt: null, productCode: null };
  
}

