// Install Sysmon (Sysinternals) with a pinned config, and grant the current
// user read access to its log -- one elevation prompt, like ClamAV's install.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { psq, sha256File } from "./runtime";

const execFileAsync = promisify(execFile);
const ps = (script: string) => execFileAsync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });

const SYSMON_URL = "https://download.sysinternals.com/files/Sysmon.zip";
// SwiftOnSecurity/sysmon-config, pinned to a commit and checksummed.
const CONFIG_URL = "https://raw.githubusercontent.com/SwiftOnSecurity/sysmon-config/" +
  "1836897f12fbd6a0a473665ef6abc34a6b497e31/sysmonconfig-export.xml";
const CONFIG_SHA256 = "055febc600e6d7448cdf3812307275912927a62b1f94d0d933b64b294bc87162";
const EVENT_LOG_READERS = "S-1-5-32-573";

/** The user declined the UAC prompt (or policy blocked elevation); nothing ran. */
export class ElevationDenied extends Error {}
const ERROR_CANCELLED = 1223;

/** Is this account in the group that may read the Sysmon log? "unknown" = could not tell. */
export type GroupAccess = "member" | "not-member" | "unknown";

export interface SysmonService { installed: boolean; running: boolean; group: GroupAccess }

/**
 * Whether Sysmon is installed and running, and whether the current user is in
 * the log-readers group (`groupSid` is a seam for tests).
 *
 * Group membership is reported because "installed but cannot read its log" has
 * two different cures: a member just needs to sign in again (Windows applies a
 * new membership at sign-in), but someone who was never added -- Sysmon put
 * there by hand, as on the machine this was written on -- needs OSAVA to add
 * them, and signing out would never help.
 *
 * The answer is computed in PowerShell and the script ends in `exit 0` on
 * purpose. The 32- and 64-bit services have different names and only one of
 * them exists; the silenced "not found" for the other leaves $? false, and
 * powershell.exe then exits 1 -- after printing a correct answer -- which
 * makes execFile reject and turned every status request into a 500 on any
 * machine with the 64-bit Sysmon.
 */
export async function sysmonStatus(groupSid = EVENT_LOG_READERS): Promise<SysmonService> {
  const { stdout } = await ps(
    "$s = Get-Service -Name 'Sysmon64','Sysmon' -ErrorAction SilentlyContinue | Select-Object -First 1; " +
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $g = 'unknown'; " +
    `try { $g = if (@(Get-LocalGroupMember -SID '${groupSid}' -ErrorAction Stop | Where-Object { $_.SID.Value -eq $me }).Count) ` +
    "{ 'member' } else { 'not-member' } } catch { } ; " +
    "@{ installed = [bool]$s; running = [bool]($s -and $s.Status -eq 'Running'); group = $g } | ConvertTo-Json -Compress; exit 0");
  return JSON.parse(stdout.trim()) as SysmonService;
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
    await ps(`Expand-Archive -LiteralPath '${psq(zip)}' -DestinationPath '${psq(dir)}' -Force`);
    // Sysinternals publishes no checksum; verify the Authenticode signature instead.
    const { stdout } = await ps(`$s = Get-AuthenticodeSignature '${psq(path.join(dir, "Sysmon64.exe"))}';` +
      `"$($s.Status)|$($s.SignerCertificate.Subject)"`);
    if (!/^Valid\|.*Microsoft/.test(stdout.trim())) throw new Error(`Sysmon64.exe signature invalid: ${stdout.trim()}`);
    installCmd = `& '${psq(path.join(dir, "Sysmon64.exe"))}' -accepteula -i '${psq(cfg)}' | Out-Null; `;
  }

  // One elevation for both steps. The user is passed in explicitly: under an
  // over-the-shoulder UAC prompt the elevated context is a different account.
  const elevated = `${installCmd}` +
    `try { Add-LocalGroupMember -SID '${EVENT_LOG_READERS}' -Member '${psq(user)}' -ErrorAction Stop } ` +
    // MemberExistsException is what "already a member" is; the message text is only English.
    `catch { if ($_.Exception.GetType().Name -ne 'MemberExistsException' -and $_.Exception.Message -notmatch 'already a member') { throw } }`;
  const encoded = Buffer.from(elevated, "utf16le").toString("base64");
  // A declined UAC prompt is a NON-terminating Start-Process error: $p stays
  // null and a bare `exit $p.ExitCode` exits 0, reporting success for an
  // install that never ran. -ErrorAction Stop turns it into something we can
  // catch and give its own exit code.
  try {
    await ps(`try { $p = Start-Process powershell.exe -ArgumentList '-NoProfile','-EncodedCommand','${encoded}' ` +
      `-Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop } catch { exit ${ERROR_CANCELLED} }; ` +
      `if ($null -eq $p) { exit ${ERROR_CANCELLED} }; exit $p.ExitCode`);
  } catch (e) {
    if ((e as { code?: number }).code === ERROR_CANCELLED) {
      throw new ElevationDenied("Elevation was denied — the Sysmon install was cancelled.");
    }
    throw new Error(`The elevated Sysmon install failed (exit code ${(e as { code?: number }).code ?? "unknown"}).`);
  }
  // Do not trust an exit code for a claim the system can check.
  const after = await sysmonStatus();
  if (!after.installed) {
    throw new Error("Sysmon is still not installed after the install step; nothing was changed.");
  }
  if (after.group === "not-member") {
    throw new Error("The install step finished, but you are still not in Event Log Readers; nothing was changed.");
  }
  return { installedSysmon: !status.installed };
}
