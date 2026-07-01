import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

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
$process = Start-Process msiexec.exe -ArgumentList '/i "${tempPath}" ALLUSERS=1 /qn /norestart /l*v "${logPath}"' -Verb RunAs -Wait -PassThru
$exitCode = $process.ExitCode

if ($exitCode -eq 0 -or $exitCode -eq 3010) {
  $dbDir = 'C:\\\\Program Files\\\\ClamAV\\\\database'
  $confPath = 'C:\\\\Program Files\\\\ClamAV\\\\freshclam.conf'

  if (-not (Test-Path $dbDir)) {
    New-Item -ItemType Directory -Path $dbDir | Out-Null
    $acl = Get-Acl $dbDir
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Users", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl $dbDir $acl
  }

  if (-not (Test-Path $confPath)) {
    $content = 'DatabaseDirectory "C:\\\\Program Files\\\\ClamAV\\\\database"' + [char]10 + 'DatabaseMirror database.clamav.net' + [char]10 + 'UpdateLogFile "' + $env:USERPROFILE + '\\\\.osava\\\\freshclam.log"' + [char]10 + 'LogTime yes'
    [System.IO.File]::WriteAllText($confPath, $content, [System.Text.UTF8Encoding]::new($false))
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

export async function getInstalledProductCode(name: string): Promise<string | null> {
  const { stdout } = await execAsync(
    `powershell -Command "Get-ChildItem 'HKLM:\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\*' | Get-ItemProperty | Where-Object { $_.DisplayName -like '${name}*' } | Select-Object -First 1 -ExpandProperty PSChildName"`
  );
  return stdout.trim() || null;
}

export async function uninstallClamAV(productCode: string): Promise<void> {
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
