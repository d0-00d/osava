// Install Sysmon (Sysinternals) with a pinned config, and grant the current
// user read access to its log -- one elevation prompt, like ClamAV's install.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { sha256File } from "./runtime";

const execFileAsync = promisify(execFile);
const ps = (script: string) => execFileAsync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });

const SYSMON_URL = "https://download.sysinternals.com/files/Sysmon.zip";
// SwiftOnSecurity/sysmon-config, pinned to a commit and checksummed.
const CONFIG_URL = "https://raw.githubusercontent.com/SwiftOnSecurity/sysmon-config/" +
  "1836897f12fbd6a0a473665ef6abc34a6b497e31/sysmonconfig-export.xml";
const CONFIG_SHA256 = "055febc600e6d7448cdf3812307275912927a62b1f94d0d933b64b294bc87162";
const EVENT_LOG_READERS = "S-1-5-32-573";

export async function sysmonStatus(): Promise<{ installed: boolean; running: boolean }> {
  const { stdout } = await ps(
    "Get-Service Sysmon64,Sysmon -ErrorAction SilentlyContinue | Select-Object -First 1 Status | ConvertTo-Json");
  const s = stdout.trim() ? JSON.parse(stdout) : null;
  // Status serialises as an enum number; 4 is Running.
  return { installed: !!s, running: !!s && (s.Status === 4 || s.Status === "Running") };
}

export async function installSysmon(): Promise<{ installedSysmon: boolean }> {
  const dir = path.join(os.tmpdir(), "osava-sysmon");
  await fs.mkdir(dir, { recursive: true });
  const status = await sysmonStatus();
  const user = (await ps("[Security.Principal.WindowsIdentity]::GetCurrent().Name")).stdout.trim();

  let installCmd = "";
  if (!status.installed) {
    const zip = path.join(dir, "Sysmon.zip");
    const cfg = path.join(dir, "sysmonconfig.xml");
    const r = await fetch(SYSMON_URL);
    if (!r.ok) throw new Error(`Sysmon download failed: ${r.status}`);
    await fs.writeFile(zip, Buffer.from(await r.arrayBuffer()));
    const c = await fetch(CONFIG_URL);
    if (!c.ok) throw new Error(`Sysmon config download failed: ${c.status}`);
    await fs.writeFile(cfg, Buffer.from(await c.arrayBuffer()));
    if ((await sha256File(cfg)) !== CONFIG_SHA256) throw new Error("Sysmon config checksum mismatch");
    await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`);
    // Sysinternals publishes no checksum; verify the Authenticode signature instead.
    const { stdout } = await ps(`$s = Get-AuthenticodeSignature '${path.join(dir, "Sysmon64.exe")}';` +
      `"$($s.Status)|$($s.SignerCertificate.Subject)"`);
    if (!/^Valid\|.*Microsoft/.test(stdout.trim())) throw new Error(`Sysmon64.exe signature invalid: ${stdout.trim()}`);
    installCmd = `& '${path.join(dir, "Sysmon64.exe")}' -accepteula -i '${cfg}' | Out-Null; `;
  }

  // One elevation for both steps. The user is passed in explicitly: under an
  // over-the-shoulder UAC prompt the elevated context is a different account.
  const elevated = `${installCmd}` +
    `try { Add-LocalGroupMember -SID '${EVENT_LOG_READERS}' -Member '${user.replace(/'/g, "''")}' -ErrorAction Stop } ` +
    `catch { if ($_.Exception.Message -notmatch 'already a member') { throw } }`;
  const encoded = Buffer.from(elevated, "utf16le").toString("base64");
  await ps(`$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-EncodedCommand','${encoded}' ` +
    `-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`);
  return { installedSysmon: !status.installed };
}
