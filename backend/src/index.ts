import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const execAsync = promisify(exec);
const app = express();
dotenv.config();
app.use(cors());

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
};

async function readStatusFile() {
  const STATUS_FILE = path.join(os.homedir(), ".osava", "install-status.json");

try{
  await fs.access(STATUS_FILE);
  const data = await fs.readFile(STATUS_FILE, "utf-8");
  return JSON.parse(data);
} catch {
  return {installed:  false, engine: null, installedAt: null};
}
}

async function writeStatusFile(status: InstallStatus) {
  const STATUS_FILE = path.join(os.homedir(), ".osava", "install-status.json");
  await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8");
}

function decodeProductState(state: number) {
  const hexState = state.toString(16).padStart(6, '0');
  const protectionBytes = hexState.substring(2, 4);
  const defBytes = hexState.substring(4, 6);
  return {
    isEnabled: protectionBytes === "10" || protectionBytes === "11",
    isUpToDate: defBytes === "00"
  };
}

async function queryProducts(className: string) {
  const { stdout } = await execAsync(
    `powershell -Command "Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName ${className} | ConvertTo-Json"`
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item: any) => ({
    displayName: item.displayName,
    ...decodeProductState(item.productState)
  }));
}

async function queryFirewallProfiles() {
  const { stdout } = await execAsync('powershell -Command "Get-NetFirewallProfile | ConvertTo-Json"');
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((profile: any) => ({
    displayName: `${profile.Name} Firewall Profile`,
    isEnabled: profile.Enabled === true || profile.Enabled === 1 || String(profile.Enabled).toLowerCase() === "true",
    isUpToDate: true
  }));
}

async function getClamAvDownloadUrl(): Promise<string> {
  const response = await fetch ("https://api.github.com/repos/Cisco-Talos/clamav/releases/latest", {
    headers: {
      "User-Agent": "osava"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ClamAV release info: ${response.statusText}`);
  }

  const data = await response.json(); 
  const targetAsset = data.assets.find((asset: any) => {
    return asset.name.includes("win.x64") && asset.name.endsWith(".msi");
  });

  if (!targetAsset) {
    throw new Error("Failed to find ClamAV download URL");
  }

  return targetAsset.browser_download_url;
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(outputPath, buffer);
}

async function installClamAV(url: string): Promise<string> {
  const tempPath = path.join(os.tmpdir(), "clamav-installer.msi");
  const installPath = "C:\\Program Files\\ClamAV";
  const logPath = path.join(os.tmpdir(), "clamav-install.log");
  const scriptPath = path.join(os.tmpdir(), "install-clamav.ps1");

  await downloadFile(url, tempPath);

  const psScript = `
$process = Start-Process msiexec.exe -ArgumentList '/i "${tempPath}" ALLUSERS=1 /qn /norestart /l*v "${logPath}"' -Verb RunAs -Wait -PassThru
exit $process.ExitCode
`;
  await fs.writeFile(scriptPath, psScript, "utf-8");
  await execAsync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`);

  return installPath;
}
app.get("/api/check-email/:email", async(req, res) => {
  const email = encodeURIComponent(req.params.email);
  const response = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${email}`, {
    headers: {
      "hibp-api-key": process.env.HIBP_API_KEY || "",
      "user-agent": "osava"
    }
  });
  if (response.status === 404) {
    return res.json({ breached: false });
  } 
  if (!response.ok) {
    const errorBody = await response.text();
    return res.status(response.status).json({ error: `HIBP returned ${response.status}: ${errorBody}` });
  }
  const data = await response.json();
  res.json({ breached: true, breaches: data });
});
if (!process.env.HIBP_API_KEY) {
  console.error("Server misconfigured: missing API key");
}
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});


app.get("/api/system-status", async (_req, res) => {
  try {
    const [antivirus, firewall] = await Promise.all([
      queryProducts("AntiVirusProduct"),
      queryFirewallProfiles()
    ]);
    res.json({ antivirus, firewall });
  } catch (error) {
    console.error("Error fetching system status:", error);
    res.status(500).json({ error: "Failed to fetch system status" });
  }
});
    
app.get("/api/install-status", async (_req, res) => {
  try {
    const status = await readStatusFile();
    res.json(status);
  }
  catch (error) {
    console.error("Error reading install status:", error);
    res.status(500).json({ error: "Failed to read install status" });
  }
});

app.post("/api/install-status", async (_req, res) => {
  try {
    const url = await getClamAvDownloadUrl();
    const installPath = await installClamAV(url);
    await writeStatusFile({
      installed: true,
      engine: "clamav",
      installedAt: new Date().toISOString()
    });
    res.json({ success: true, message: "ClamAV installed", installPath });
  } catch (error: any) {
  if (error.code === 3010) {
    await writeStatusFile({
      installed: true,
      engine: "clamav",
      installedAt: new Date().toISOString()
    });
    res.json({ success: true, message: "ClamAV installed (reboot required)" });
    return;
  }
  console.error("Install failed:", error);
  res.status(500).json({ error: "Failed to install ClamAV" });
}
});

app.listen(4000, () => console.log("backend running on port 4000"));  
