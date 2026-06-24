import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { send, stdout } from "node:process";
import { log } from "node:console";

const execAsync = promisify(exec);
const app = express();
const CLAMAV_DIR  = "C:\\Program Files\\ClamAV";
const CLAMDB_DIR = path.join(CLAMAV_DIR, "database");
const FRESHCLAMAM_CONF = path.join(CLAMAV_DIR, "freshclam.conf");
dotenv.config();
app.use(cors());

type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

/*
  __ _ ___ _   _ _ __   ___                   
 / _` / __| | | | '_ \ / __|                  
| (_| \__ \ |_| | | | | (__   OR                
 \__,_|___/\__, |_| |_|\___|              ____
 / _|_   _ |___/| |_(_) ___  _ __  ___   / / /
| |_| | | | '_ \| __| |/ _ \| '_ \/ __| / / / 
|  _| |_| | | | | |_| | (_) | | | \__ \/ / /  
|_|  \__,_|_| |_|\__|_|\___/|_| |_|___/_/_/ /
*/


async function readStatusFile() {
  const STATUS_FILE = path.join(os.homedir(), ".osava", "install-status.json");

  try {
    await fs.access(STATUS_FILE);
    const data = await fs.readFile(STATUS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { installed: false, engine: null, installedAt: null };
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
  const response = await fetch("https://api.github.com/repos/Cisco-Talos/clamav/releases/latest", {
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

async function installClamAV(url: string): Promise<{ installPath: string; productCode: string | null }> {
  const tempPath = path.join(os.tmpdir(), "clamav-installer.msi");
  const installPath = "C:\\Program Files\\ClamAV";
  const logPath = path.join(os.tmpdir(), "clamav-install.log");
  const scriptPath = path.join(os.tmpdir(), "install-clamav.ps1");

  await downloadFile(url, tempPath);

  const psScript = `
$process = Start-Process msiexec.exe -ArgumentList '/i "${tempPath}" ALLUSERS=1 /qn /norestart /l*v "${logPath}"' -Verb RunAs -Wait -PassThru
$exitCode = $process.ExitCode

if ($exitCode -eq 0 -or $exitCode -eq 3010) {
  $dbDir = 'C:\\Program Files\\ClamAV\\database'
  $confPath = 'C:\\Program Files\\ClamAV\\freshclam.conf'
  
  if (-not (Test-Path $dbDir)) {
    New-Item -ItemType Directory -Path $dbDir | Out-Null
  }
  
  if (-not (Test-Path $confPath)) {
   $content = 'DatabaseDirectory "C:\\Program Files\\ClamAV\\database"' + [char]10 + 'DatabaseMirror database.clamav.net' + [char]10 + 'UpdateLogFile "' + $env:USERPROFILE + '\\.osava\\freshclam.log"' + [char]10 + 'LogTime yes'
  }
}

exit $exitCode
`;
  await fs.writeFile(scriptPath, psScript, "utf-8");
  await execAsync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`);

  const productCode = await getInstalledProductCode("ClamAV");

  try {
    await fs.unlink(tempPath);
    await fs.unlink(scriptPath);
  } catch (cleanupError) {
    console.error("Cleanup failed (non-fatal):", cleanupError);
  }

  return { installPath, productCode };
}

async function getInstalledProductCode(name: string): Promise<string | null> {
  const { stdout } = await execAsync(
    `powershell -Command "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Get-ItemProperty | Where-Object { $_.DisplayName -like '${name}*' } | Select-Object -First 1 -ExpandProperty PSChildName"`
  );
  return stdout.trim() || null;
}

async function uninstallClamAV(productCode: string): Promise<void> {
  const scriptPath = path.join(os.tmpdir(), "uninstall-clamav.ps1");
  const psScript = `
$process = Start-Process msiexec.exe -ArgumentList '/x ${productCode} /qn /norestart' -Verb RunAs -Wait -PassThru
exit $process.ExitCode
`;
  await fs.writeFile(scriptPath, psScript, "utf-8");
  await execAsync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`);
  try {
    await fs.unlink(scriptPath);
  } catch (cleanupError) {
    console.error("Cleanup failed (non-fatal):", cleanupError);
  }
}

async function setUpClamAConfig(): Promise<void> {
  try {
    await fs.access(FRESHCLAMAM_CONF);
  } catch {
    const config = [
      `DatabaseDirectory "${CLAMDB_DIR}"`,
      `UpdateLogFile "${path.join(CLAMAV_DIR, "freshclam.log")}"`,
      `LogTime yes`,
    ].join("\n");
    await fs.writeFile(FRESHCLAMAM_CONF, config, "utf-8");
    console.log("freshclam.conf created");
  }
}

/*
  ____ _____ _____  __               _                                 
 / ___| ____|_   _|/ / __   ___  ___| |_   _ __ ___  __ _    ___  _ __ 
| |  _|  _|   | | / / '_ \ / _ \/ __| __| | '__/ _ \/ _` |  / _ \| '__|
| |_| | |___  | |/ /| |_) | (_) \__ \ |_  | | |  __/ (_| | | (_) | |   
 \____|_____| |_/_/ | .__/ \___/|___/\__| |_|  \___|\__, |  \___/|_|   
                    |_|                                |_|             */


app.get("/api/check-email/:email", async (req, res) => {
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
    const { installPath, productCode } = await installClamAV(url);
    await writeStatusFile({
      installed: true,
      engine: "clamav",
      productCode,
      installedAt: new Date().toISOString()
    });
    res.json({ success: true, message: "ClamAV installed", installPath, productCode });
  } catch (error: any) {
    if (error.code === 3010) {
      const productCode = await getInstalledProductCode("ClamAV");
      await writeStatusFile({
        installed: true,
        engine: "clamav",
        productCode,
        installedAt: new Date().toISOString()
      });
      res.json({ success: true, message: "ClamAV installed (reboot required)" });
      return;
    }
    console.error("Install failed:", error);
    res.status(500).json({ error: error.message || "Failed to install ClamAV" });
  }
});

app.post("/api/uninstall", async (_req, res) => {
  try {
    const status = await readStatusFile();
    if (!status.installed) {
      return res.status(400).json({ error: "Nothing installed" });
    }

    let productCode = status.productCode;
    if (!productCode) {
      productCode = await getInstalledProductCode("ClamAV");
    }
    if (!productCode) {
      return res.status(400).json({ error: "Could not determine product code for installed engine" });
    }

    await uninstallClamAV(productCode);
    await writeStatusFile({ installed: false, engine: null, installedAt: null, productCode: null });
    res.json({ success: true, message: "ClamAV uninstalled" });
  } catch (error: any) {
    if (error.code === 3010) {
      await writeStatusFile({ installed: false, engine: null, installedAt: null, productCode: null });
      res.json({ success: true, message: "ClamAV uninstalled (reboot required)" });
      return;
    }
    console.error("Uninstall failed:", error);
    res.status(500).json({ error: error.message || "Failed to uninstall ClamAV" });
  }
});

app.get("/api/av/update-definitions", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type: string, data: string) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  sendEvent("log", "Starting definitions update...");

  const freshclam = spawn(
    `${CLAMAV_DIR}\\freshclam.exe`,
    [`--config-file=${CLAMAV_DIR}\\freshclam.conf`],
    { shell: false }
  );

  freshclam.stdout.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => sendEvent("log", line));
  });

  freshclam.stderr.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => sendEvent("log", line));
  });

  freshclam.on("close", (code) => {
    if (code === 0) {
      sendEvent("done", "Definitions updated successfully!");
    } else {
      sendEvent("error", `freshclam exited with code ${code}`);
    }
    res.end();  
  });

  req.on("close", () => freshclam.kill());

app.get("/api/av/scan", (req, res) =>{
  const scanPath = req.query.path as string;
  if(!scanPath){
    res.status(400).json({error: "No path provided."})
    return;
  }

  res.setHeader("Content-type", "text/event-stream");
  res.setHeader("Cache-control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type:string, data:string) => {
    res.write(`data: ${JSON.stringify({type, data})} \n \n`);
  };

  sendEvent("log", `Starting scan of: ${scanPath}`);
  const clamscan = spawn (
    `${CLAMAV_DIR}\\clamscan.exe`,
    [
      "--database", CLAMDB_DIR,
      "--recursive",
      "--infected",
      scanPath
    ],
    {shell: false}
  );

  clamscan.stdout.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => {
        const isInfected = line.includes("FOUND");
        sendEvent(isInfected ? "error" : "log", line);
      });
  });

  clamscan.stderr.on("data", (chunk) => {
    chunk.toString().split("\n")
      .filter((l: string) => l.trim())
      .forEach((line: string) => sendEvent("log", line));
      });

  clamscan.on("close", (code) =>{
    if(code === 0){
      sendEvent("done", "Scan complete. No threats found.");
    }
    else if(code === 1){
      sendEvent("error", "Scan Complete!, Threats found!");
    }
    else{
      sendEvent("error", `Scan exited with code ${code}`);
    }
    res.end();
  });

  req.on("close", () => clamscan.kill());
  });
})
app.listen(4000, () => console.log("backend running on port 4000"));  
