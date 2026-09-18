import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const execAsync = promisify(exec);

const CACHE_FILE = path.join(os.homedir(), ".osava", "system-status-cache.json");

export type SystemStatus = {
  antivirus: ProductStatus[];
  firewall: ProductStatus[];
  cachedAt: string;
};

export type ProductStatus = {
  displayName: string;
  isEnabled: boolean;
  isUpToDate: boolean;
};

/**
 * Each query shells out to PowerShell, which takes seconds — far too slow to
 * block the dashboard on every visit. The last result is kept on disk so the UI
 * can paint immediately, then refresh in the background.
 */
let memoryCache: SystemStatus | null = null;
let refreshing = false;

export async function readCachedStatus(): Promise<SystemStatus | null> {
  if (memoryCache) return memoryCache;
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    memoryCache = JSON.parse(data);
    return memoryCache;
  } catch {
    return null;
  }
}

export async function refreshStatus(): Promise<SystemStatus> {
  const [antivirus, firewall] = await Promise.all([
    queryProducts("AntiVirusProduct"),
    queryFirewallProfiles(),
  ]);
  const status: SystemStatus = { antivirus, firewall, cachedAt: new Date().toISOString() };
  memoryCache = status;
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(status, null, 2), "utf-8");
  } catch (error) {
    console.error("Could not persist system status cache:", error);
  }
  return status;
}

/** Kick off a refresh without waiting for it, ignoring overlapping calls. */
export function refreshStatusInBackground(): void {
  if (refreshing) return;
  refreshing = true;
  refreshStatus()
    .catch((error) => console.error("Background system status refresh failed:", error))
    .finally(() => {
      refreshing = false;
    });
}

export function decodeProductState(state: number) {
  const hexState = state.toString(16).padStart(6, "0");
  const protectionBytes = hexState.substring(2, 4);
  const defBytes = hexState.substring(4, 6);
  return {
    isEnabled: protectionBytes === "10" || protectionBytes === "11",
    isUpToDate: defBytes === "00",
  };
}

export async function queryProducts(className: string) {
  const { stdout } = await execAsync(
    `powershell -Command "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ConvertTo-Json"`
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item: any) => ({
    displayName: item.displayName,
    ...decodeProductState(item.productState),
  }));
}

export async function queryFirewallProfiles() {
  const { stdout } = await execAsync(
    'powershell -Command "Get-NetFirewallProfile | ConvertTo-Json"'
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((profile: any) => ({
    displayName: `${profile.Name} Firewall Profile`,
    isEnabled:
      profile.Enabled === true ||
      profile.Enabled === 1 ||
      String(profile.Enabled).toLowerCase() === "true",
    isUpToDate: true,
  }));
}
