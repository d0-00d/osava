import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { ensureClamConfig } from "./clamavConfig";

const execAsync = promisify(exec);

export async function getClamAvDownloadUrl(): Promise<string> {
  const response = await fetch(
    "https://api.github.com/repos/Cisco-Talos/clamav/releases/latest",
    { headers: { "User-Agent": "osava" } }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch ClamAV release info: ${response.statusText}`);
  }
  const data = await response.json();
  const targetAsset = data.assets.find((asset: any) =>
    asset.name.includes("win.x64") && asset.name.endsWith(".msi")
  );
  if (!targetAsset) throw new Error("Failed to find ClamAV download URL");
  return targetAsset.browser_download_url;
}

export async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

export async function installClamAV(url: string): Promise<{ installPath: string; productCode: string | null }> {
  const tempPath = path.join(os.tmpdir(), "clamav-installer.msi");
  const installPath = "C:\\Program Files\\ClamAV";
  const logPath = path.join(os.tmpdir(), "clamav-install.log");
  const scriptPath = path.join(os.tmpdir(), "install-clamav.ps1");

  await downloadFile(url, tempPath);

  const psScript = `
try {
  $process = Start-Process msiexec.exe -ArgumentList '/i "${tempPath}" ALLUSERS=1 /qn /norestart /l*v "${logPath}"' -Verb RunAs -Wait -PassThru -ErrorAction Stop
} catch {
  $native = $_.Exception.NativeErrorCode
  if ($null -eq $native -and $_.Exception.InnerException) { $native = $_.Exception.InnerException.NativeErrorCode }
  if ($native -eq 1223) { exit 1223 }
  Write-Error $_.Exception.Message
  exit 1
}

if ($null -eq $process) { exit 1 }
exit $process.ExitCode
`;

  await fs.writeFile(scriptPath, psScript, "utf-8");
  await execAsync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`);

  // Set up ClamAV's writable data (db dir + freshclam.conf) in the user profile.
  // Done here in Node — not in the elevated script — so it never needs admin
  // and can't silently fail on a locked-down Program Files.
  ensureClamConfig();

  const productCode = await getInstalledProductCode("ClamAV");

  try {
    await fs.unlink(tempPath);
    await fs.unlink(scriptPath);
  } catch (cleanupError) {
    console.error("Cleanup failed (non-fatal):", cleanupError);
  }

  return { installPath, productCode };
}

export async function getInstalledProductCode(name: string): Promise<string | null> {
  const { stdout } = await execAsync(
    `powershell -Command "Get-ChildItem 'HKLM:\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\*' | Get-ItemProperty | Where-Object { $_.DisplayName -like '${name}*' } | Select-Object -First 1 -ExpandProperty PSChildName"`
  );
  return stdout.trim() || null;
}

export async function uninstallClamAV(productCode: string): Promise<void> {
  const scriptPath = path.join(os.tmpdir(), "uninstall-clamav.ps1");
  const psScript = `
try {
  $process = Start-Process msiexec.exe -ArgumentList '/x ${productCode} /qn /norestart' -Verb RunAs -Wait -PassThru -ErrorAction Stop
} catch {
  $native = $_.Exception.NativeErrorCode
  if ($null -eq $native -and $_.Exception.InnerException) { $native = $_.Exception.InnerException.NativeErrorCode }
  if ($native -eq 1223) { exit 1223 }
  Write-Error $_.Exception.Message
  exit 1
}

if ($null -eq $process) { exit 1 }
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
