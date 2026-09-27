// ─────────────────────────────────────────────────────────────
// The explanation for a verdict, computed here rather than generated.
//
// Port of osava-slm targets.py (extract, threat_type, reasoning, build). The
// model was trained to write exactly this: every field except severity is a
// function of the event and the severity class. Generating it cost ~300
// tokens per event and was where the model hallucinated -- invented indicator
// keys, values not in the event, reasons that did not support the verdict.
// Computed, it quotes only what is in the event, by construction.
//
// Must agree with the Python byte for byte (npm run parity-explain). Python
// regex semantics differ from JS in places; each difference is handled where
// it arises: `.` excludes only \n in Python (JS also excludes \r, \u2028,
// \u2029), so `.` is written [^\n]; str.split()/strip() use Python's
// whitespace set (pystr.ts); lengths count code points.
// ─────────────────────────────────────────────────────────────

import { CONTRACT } from "./contract";
import { pyInt } from "./signature";
import { PY_WS, pyLen, pySlice, pySplitWs } from "./pystr";

type Fields = Record<string, string>;
export type Cls = "benign" | "suspicious" | "malicious";

export interface Explanation {
  isThreat: boolean;
  threatType: string | null;
  indicators: Record<string, string>;
  reasoning: string;
}

// ---------------------------------------------------------------- vocab

const LOLBINS = new Set([
  "rundll32.exe", "mshta.exe", "regsvr32.exe", "certutil.exe", "bitsadmin.exe",
  "wmic.exe", "cscript.exe", "wscript.exe", "msbuild.exe", "installutil.exe",
  "regasm.exe", "regsvcs.exe", "cmstp.exe", "forfiles.exe", "pcalua.exe",
  "odbcconf.exe", "xwizard.exe", "presentationhost.exe", "ieexec.exe",
  "msdt.exe", "hh.exe", "ftp.exe", "esentutl.exe", "extrac32.exe",
  "makecab.exe", "expand.exe", "replace.exe", "print.exe", "scriptrunner.exe",
  "mavinject.exe", "sc.exe", "schtasks.exe", "at.exe", "reg.exe",
  "csc.exe", "jsc.exe", "vbc.exe", "msxsl.exe",
]);
const SHELLS = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe",
  "mshta.exe", "bash.exe", "wsl.exe"]);
const OFFICE = new Set(["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe",
  "msaccess.exe", "mspub.exe", "visio.exe", "onenote.exe"]);
const BROWSERS = new Set(["chrome.exe", "firefox.exe", "msedge.exe", "iexplore.exe",
  "brave.exe", "opera.exe", "vivaldi.exe"]);
const SERVICE_HOSTS = new Set(["services.exe", "svchost.exe"]);
const SYSTEM_NAMES = ["svchost.exe", "lsass.exe", "services.exe", "csrss.exe",
  "winlogon.exe", "smss.exe", "spoolsv.exe", "taskhostw.exe",
  "dllhost.exe", "conhost.exe", "wininit.exe", "explorer.exe",
  "runtimebroker.exe", "sihost.exe", "ctfmon.exe"];

const SYSTEM_DIRS = ["c:\\windows\\system32", "c:\\windows\\syswow64",
  "c:\\program files", "c:\\program files (x86)",
  "c:\\windows\\winsxs", "c:\\windows\\microsoft.net"];
const TEMP_DIRS = ["\\appdata\\local\\temp", "\\appdata\\roaming", "\\appdata\\local",
  "c:\\windows\\temp", "c:\\programdata", "c:\\temp", "c:\\users\\public",
  "\\downloads", "c:\\perflogs", "c:\\windows\\tasks",
  "c:\\windows\\debug", "c:\\windows\\tracing"];

const EXPECTED: Record<string, Set<string>> = {
  "explorer.exe": new Set(["cmd.exe", "powershell.exe", "notepad.exe", "chrome.exe",
    "msedge.exe", "firefox.exe", "code.exe", "winword.exe",
    "excel.exe", "outlook.exe", "teams.exe", "slack.exe",
    "mmc.exe", "taskmgr.exe", "control.exe", "regedit.exe"]),
  "services.exe": new Set(["svchost.exe", "spoolsv.exe", "msmpeng.exe", "searchindexer.exe",
    "wmiprvse.exe", "vmtoolsd.exe", "sqlservr.exe", "w3wp.exe",
    "dllhost.exe", "vgauthservice.exe", "securityhealthservice.exe"]),
  "svchost.exe": new Set(["taskhostw.exe", "runtimebroker.exe", "sihost.exe", "ctfmon.exe",
    "dllhost.exe", "wmiprvse.exe", "audiodg.exe", "consent.exe",
    "backgroundtaskhost.exe", "wuauclt.exe", "usoclient.exe"]),
  "wininit.exe": new Set(["services.exe", "lsass.exe", "lsm.exe"]),
  "userinit.exe": new Set(["explorer.exe"]),
  "winlogon.exe": new Set(["userinit.exe", "dwm.exe", "logonui.exe", "fontdrvhost.exe"]),
  "taskeng.exe": new Set(["cmd.exe", "powershell.exe", "msiexec.exe"]),
  "msiexec.exe": new Set(["msiexec.exe", "rundll32.exe"]),
  "code.exe": new Set(["code.exe", "cmd.exe", "powershell.exe", "node.exe", "git.exe"]),
  "msbuild.exe": new Set(["tracker.exe", "csc.exe", "vbcscompiler.exe", "cl.exe", "link.exe",
    "msbuild.exe", "conhost.exe"]),
};
// own-property lookups only: process names come from telemetry, and a binary
// called `constructor` or `__proto__` must not reach Object.prototype
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
const expectedFor = (p: string) => own(EXPECTED, p) ?? new Set<string>();

const AUTO_ELEVATE = ["fodhelper.exe", "computerdefaults.exe", "sdclt.exe", "eventvwr.exe",
  "compmgmtlauncher.exe", "wsreset.exe", "slui.exe", "changepk.exe",
  "sysprep.exe", "pkgmgr.exe", "wusa.exe", "consent.exe", "cliconfg.exe",
  "perfmon.exe", "colorcpl.exe", "iscsicpl.exe", "dccw.exe", "ieinstal.exe"];
const AUTO_ELEVATE_S = new Set(AUTO_ELEVATE);
const ELEVATE_LAUNCHERS = new Set(["explorer.exe", "svchost.exe", "services.exe", "mmc.exe",
  "winlogon.exe", "msiexec.exe", "wuauclt.exe", "taskhostw.exe", "taskeng.exe"]);
const ACCESSIBILITY = ["sethc.exe", "utilman.exe", "osk.exe", "magnify.exe", "narrator.exe",
  "displayswitch.exe", "atbroker.exe"];
const ACCESSIBILITY_S = new Set(ACCESSIBILITY);
const ACCESS_LAUNCHERS = new Set(["winlogon.exe", "utilman.exe", "atbroker.exe", "explorer.exe"]);
const PROXY_PARENTS = new Set(["wmic.exe", "wmiprvse.exe", "pcalua.exe", "forfiles.exe", "mshta.exe",
  "rundll32.exe", "regsvr32.exe", "msbuild.exe", "installutil.exe",
  "cmstp.exe", "scriptrunner.exe", "regasm.exe", "regsvcs.exe", "odbcconf.exe"]);
const HOME_DIR: Record<string, string> = { "explorer.exe": "c:\\windows", "psexesvc.exe": "c:\\windows" };
const MASQ_NAMES = new Set([...SYSTEM_NAMES, ...AUTO_ELEVATE, ...ACCESSIBILITY]);
const PAYLOAD_EXT = [".exe", ".dll", ".scr", ".hta", ".js", ".jse", ".vbs", ".vbe", ".ps1",
  ".bat", ".cmd", ".sct", ".wsf", ".msi"];
const WRITABLE = [...TEMP_DIRS, "\\desktop\\", "\\start menu\\"];

// ---------------------------------------------------------------- regexes
//
// Written in Python syntax and compiled by py(), which gives \b \w \d \s their
// Python (Unicode) meaning. JavaScript's are ASCII-only: in a mojibake command
// line (`ntdsutil â€œifmâ€`) Python sees no word boundary between `œ` and `i`,
// JavaScript does, and the two disagreed on credential_access.

const W = "\\p{L}\\p{N}_";
function py(src: string, flags = "i"): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\") {
      const n = src[++i]!;
      if (n === "b" && !inClass) out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
      else if (n === "w") out += inClass ? W : `[${W}]`;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "s") out += inClass ? PY_WS : `[${PY_WS}]`;
      else if (n === "S" && !inClass) out += `[^${PY_WS}]`;
      else out += "\\" + n;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return new RegExp(out, flags + "u");
}
const r = String.raw;

const RE_HIDDEN = py(r`(-w(?:indow)?s?(?:tyle)?\s+h(?:idden)?\b|createnowindow|\bwindowstyle\s*=\s*hidden|\bconhost(?:\.exe)?\b[^\n]*--headless)`);
const RE_ENCODED = py(r`(-e(?:nc|ncoded)?(?:command)?\s+[A-Za-z0-9+/=]{16,}|frombase64string|\[convert\]::|-enc\b|-encodedcommand\b)`);
const RE_CRADLE = py(r`(invoke-webrequest|invoke-restmethod|\biwr\b|\bcurl\b|\bwget\b|downloadstring|downloadfile|downloaddata|net\.webclient|start-bitstransfer|bitsadmin[^|]*?/transfer|certutil[^|]*?-urlcache|\bhttps?://)`);
const RE_BYPASS = py(r`(-ex(?:ec)?(?:utionpolicy)?\s+(bypass|unrestricted)|-nop\b|-noprofile\b)`);
const RE_DISCOVERY = py(r`\b(whoami|systeminfo|nltest|net\s+(user|group|localgroup|view|share|accounts)|net1\s+(user|group)|ipconfig|arp\s+-a|nbtstat|quser|qwinsta|dsquery|tasklist|hostname|netstat|route\s+print|wmic(?:\.exe)?\s+(computersystem|os|process|qfe|useraccount))\b`);
const RE_CRED = py(r`(sekurlsa|logonpasswords|lsass\.dmp|mimikatz|ntds\.dit|\bsam\b\s+save|reg\s+save\s+hk\w*\\+(sam|security|system)|comsvcs\.dll[^|]*?minidump|vaultcmd|dpapi|ntdsutil[^|]*?\bifm\b|procdump[^|]*?lsass|\bsam\b[^|]*?\bsave\b)`);
const RE_ADMIN_SHARE = py(r`\\\\[^\\]+\\(admin\$|ipc\$|c\$)`);
// Python `$` also matches before a final newline
const RE_IP = py(r`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\n?$`, "");

const RE_DECORATED = py(r`^(?:\[\d+\]|\(\d+\)\s*)([^\n]+)\n?$`, "");
const RE_APPCMD_CRED = py(r`\bappcmd(?:\.exe)?\b[^\n]*\blist\s+(?:apppool|vdir)\b[^\n]*/text:`);
const RE_REVSHELL = py(r`(\b(?:nc|ncat|nc64|netcat)(?:\.exe)?\b[^\n]*\s-[ec]\s|net\.sockets\.tcpclient|/bin/(?:ba)?sh\s+-i)`);
const RE_ACCOUNT = py(r`\bnet1?(?:\.exe)?\b[^\n]*\b(?:user|localgroup|group)\b[^\n]*/(?:add|delete)`);
const RE_SVC_CREATE = py(r`\bsc(?:\.exe)?\s+(?:\\\\\S+\s+)?(?:create|config)\b[^\n]*binpath`);
const RE_RECOVERY = py(r`(vssadmin[^\n]*?delete\s+shadows|wbadmin\s+delete|bcdedit[^\n]*?(recoveryenabled|bootstatuspolicy))`);
const RE_EVASION_CMD = py(r`(wevtutil\s+cl|clear-eventlog|cipher\s+/w|fsutil\s+usn\s+deletejournal|set-mppreference[^\n]*-disable|add-mppreference[^\n]*-exclusion|auditpol[^\n]*/(clear|remove)|netsh[^\n]*firewall[^\n]*\b(off|disable)\b)`);
const RE_REG_PERSIST = py(r`(\\currentversion\\run(once)?(ex)?\\|\\winlogon\\(shell|userinit|notify)|` +
  r`\\image file execution options\\|\\silentprocessexit\\|` +
  r`\\currentversion\\explorer\\(user )?shell folders|\\policies\\explorer\\run|` +
  r`userinitmprlogonscript|\\inprocserver32|\\localserver32|\\appinit_dlls|` +
  r`\\microsoft\\netsh\\|\\control\\lsa\\(security|notification|authentication) packages|` +
  r`\\session manager\\bootexecute|\\print\\monitors\\|\\ntds\\directoryserviceextpt|` +
  r`\\windowsupdate\\orchestrator\\uscheduler|\\ieak\\grouppolicy\\pendinggpos)`);
const RE_REG_SERVICE = py(r`\\services\\[^\\]+\\(imagepath|parameters\\servicedll)`);
const RE_REG_UAC = py(r`((ms-settings|folder|ms-browser|mscfile|exefile|launcher\.systemsettings|appx[0-9a-z]+)\\shell\\open\\command|delegateexecute|\\environment\\(windir|systemroot))`);
const RE_REG_EVASION = py(r`(windows defender\\(exclusions|[^\n]*disable)|\\powershell\\(scriptblocklogging|modulelogging|transcription)|\\winevt\\channels\\[^\n]*\\enabled|lanmanserver\\parameters\\nullsession(pipes|shares)|\\policies\\system\\(enablelua|consentpromptbehavioradmin)|__pslockdownpolicy|\\control\\lsa\\runasppl)`);
const RE_REG_SHIM = py(r`\\appcompatflags\\(installedsdb|custom)\\`);
const RE_REG_SAM = py(r`\\sam\\sam\\domains\\(account\\users|builtin\\aliases)\\`);
const RE_REG_CRED = py(r`\\wdigest\\uselogoncredential`);
const RE_WUSA_EXTRACT = py(r`/extract:?\S*`);
const RE_PRIV = py(r`(sedebugprivilege|setcbprivilege)`);
const RE_SDB = py(r`[^\s"]+\.sdb\b`);
const RE_REMOTE_EXEC = py(r`\b(psexec\w*|sc\s+\\\\\S+|wmic\s+/node:?\S*|winrs\w*|invoke-command\s+-computername\s+\S+)`);
const RE_APPCMD_TEXT = py(r`/text:\S+`);
const RE_ENC_BLOB = py(r`-e(?:nc|ncoded)?(?:command)?\s+[A-Za-z0-9+/=]{16,}`);
const RE_FROMB64 = py(r`frombase64string`);
const RE_EXEC_BYPASS = py(r`-ex(?:ec)?(?:utionpolicy)?\s+(?:bypass|unrestricted)`);
const RE_URL = py(r`https?://[^\s'"()]+`);
const RE_GUEST = py(r`\\(guest|anonymous|anonymous logon)\n?$`);
const RE_EXFIL = py(r`(compress-archive|\brar\s+a\b|7z\s+a\b|invoke-webrequest[^|]*-method\s+post|\bftp\b|uploadfile)`);
const RE_MINER = py(r`(xmrig|stratum\+tcp|minerd|nicehash)`);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Short or English-word stems only count with the .exe suffix.
const WORDY = new Set(["at", "print", "replace", "expand", "hh", "ftp", "sc", "reg", "msdt", "csc", "jsc", "vbc"]);
const RE_LOLBIN_CMD = py("(" +
  [...LOLBINS].sort((a, b) => b.length - a.length).map((b) => {
    const stem = escapeRe(b.slice(0, -4));
    return WORDY.has(b.slice(0, -4)) ? r`\b${stem}\.exe\b` : r`\b${stem}(?:\.exe)?\b`;
  }).join("|") +
  r`|\breg(?:\.exe)?\s+(?:add|import|save|export|delete)\b` +
  r`|\bsc(?:\.exe)?\s+(?:create|config|start)\b)`);
const RE_ACCESS_PATH = py(r`([a-z]:\\[^"\n]*\\(?:` +
  ACCESSIBILITY.map((a) => escapeRe(a.slice(0, -4))).join("|") + r`)\.exe)`);

// (key, regexes that fire it, regexes that pick the quote)
const CMD_RULES: [string, RegExp[], RegExp[]][] = [
  ["credential_access", [RE_CRED, RE_APPCMD_CRED], [RE_CRED, RE_APPCMD_TEXT]],
  ["reverse_shell", [RE_REVSHELL], []],
  ["account_manipulation", [RE_ACCOUNT], []],
  ["service_binary_created", [RE_SVC_CREATE], []],
  ["defense_evasion", [RE_RECOVERY, RE_EVASION_CMD], []],
  ["encoded_command", [RE_ENCODED], [RE_ENC_BLOB, RE_FROMB64]],
  ["hidden_window", [RE_HIDDEN], []],
  ["download_cradle", [RE_CRADLE], [RE_URL]],
  ["exec_policy_bypass", [RE_BYPASS], [RE_EXEC_BYPASS]],
  ["discovery_command", [RE_DISCOVERY], []],
];

const PRIORITY = ["credential_access", "reverse_shell", "uac_bypass", "accessibility_hijack",
  "app_shim_install", "persistence_autorun", "service_binary_created",
  "defense_evasion", "account_manipulation", "remote_service_install",
  "office_spawns_shell", "browser_spawns_shell", "proxy_execution",
  "download_cradle", "encoded_command", "payload_dropped", "masquerading_name",
  "service_host_spawns_proc", "temp_path_exec", "hidden_window",
  "exec_policy_bypass", "unsigned_binary", "lolbin_exec", "discovery_command",
  "smb_admin_share", "raw_ip_no_dns", "outbound_uncommon_port",
  "privilege_escalation", "new_credentials_logon", "remote_interactive_logon",
  "blank_or_guest_account", "legacy_auth_protocol", "failed_logon",
  "system_context_exec"];

const INDICATORS = new Set(CONTRACT.indicators);

// ---------------------------------------------------------------- helpers

const lower = (s: string) => s.toLowerCase();
const base = (p: string | undefined) =>
  p ? lower(p.split("/").join("\\").split("\\").pop()!) : "";
const dir = (p: string | undefined) => {
  const q = (p ?? "").split("/").join("\\");
  return q.includes("\\") ? lower(q.slice(0, q.lastIndexOf("\\"))) : "";
};
const within = (d: string, prefixes: string[]) => prefixes.some((x) => d.includes(x));
const pyStr = (v: unknown) => (v === null || v === undefined ? "None" : String(v));

function clip(v: unknown, n = 120): string {
  const s = pySplitWs(pyStr(v)).join(" ");
  return pyLen(s) <= n ? s : pySlice(s, n - 1) + "\u2026";
}

/** str.strip("\"' ") */
const stripQuotes = (s: string) => s.replace(/^["' ]+|["' ]+$/g, "");

const SPAN = 48;
function span(rx: RegExp, s: string | undefined, n = SPAN): string | null {
  const m = rx.exec(s ?? "");
  return m ? clip(stripQuotes(m[0]), n) : null;
}

function undecorated(name: string): string {
  const m = RE_DECORATED.exec(name ?? "");
  return m ? m[1]! : name;
}

const atHome = (name: string, d: string) => d === own(HOME_DIR, name) || within(d, SYSTEM_DIRS);

/** Python str.capitalize(): first character upper, the rest LOWER. */
const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s);

// ---------------------------------------------------------------- indicators

export function extract(f: Fields): Record<string, string> {
  const eid = f["EventID"] ?? "";
  const img = f["Image"] ?? "";
  const par = f["ParentImage"] ?? "";
  const cmd = f["CommandLine"] ?? "";
  const tgt = f["TargetFilename"] || f["TargetObject"] || "";
  const user = f["User"] || f["TargetUser"] || "";
  const signed = lower(f["Signed"] ?? "");
  const signer = f["Signer"] ?? "";
  const ib = base(img), pb = base(par), idir = dir(img);
  const ibc = undecorated(ib);
  const t = lower(tgt);
  const regWrite = ["12", "13", "14"].includes(eid);
  const bad = new Map<string, unknown>();
  const good = new Map<string, unknown>();
  const flag = (k: string, v: unknown) => { if (!bad.has(k)) bad.set(k, v); };

  // lineage
  if (OFFICE.has(pb) && SHELLS.has(ib)) flag("office_spawns_shell", `${pb} -> ${ib}`);
  else if (BROWSERS.has(pb) && SHELLS.has(ib)) flag("browser_spawns_shell", `${pb} -> ${ib}`);
  else if (SERVICE_HOSTS.has(pb) && ib && !expectedFor(pb).has(ib)) flag("service_host_spawns_proc", `${pb} -> ${ib}`);
  else if (pb && ib && expectedFor(pb).has(ib)) good.set("expected_parent", `${pb} -> ${ib}`);
  if (PROXY_PARENTS.has(pb) && ib && !expectedFor(pb).has(ib)) flag("proxy_execution", `${pb} -> ${ib}`);
  if (AUTO_ELEVATE_S.has(ib) && pb && !ELEVATE_LAUNCHERS.has(pb)) flag("uac_bypass", `${pb} -> ${ib}`);
  else if (AUTO_ELEVATE_S.has(pb) && SHELLS.has(ib)) flag("uac_bypass", `${pb} -> ${ib}`);
  if (pb === "dllhost.exe" && SHELLS.has(ib)) flag("uac_bypass", `${pb} -> ${ib}`);
  if (ib === "wusa.exe" && lower(cmd).includes("/extract")) flag("uac_bypass", span(RE_WUSA_EXTRACT, cmd));
  if (ACCESSIBILITY_S.has(ibc) && (!within(idir, SYSTEM_DIRS) || (pb && !ACCESS_LAUNCHERS.has(pb))))
    flag("accessibility_hijack", pb ? `${pb} -> ${ib}` : img);
  const am = RE_ACCESS_PATH.exec(cmd);
  if (am && !lower(am[1]!).includes("\\system32\\")) flag("accessibility_hijack", am[1]);

  // identity
  const ul = lower(user);
  const logon = eid === "4624" || eid === "4625";
  if (ul.includes("system") && !ul.includes("localsystem") && !logon) flag("system_context_exec", user);
  else if (ul.includes("local service") || ul.includes("network service")) good.set("restricted_service_acct", user);
  if (RE_GUEST.test(user)) flag("blank_or_guest_account", user);
  const auth = f["AuthPackage"] ?? "";
  if (logon && ["NTLM", "NTLMV1", "MSV1_0", "MICROSOFT_AUTHENTICATION_PACKAGE_V1_0"].includes(auth.toUpperCase()))
    flag("legacy_auth_protocol", auth);
  if (logon) {
    const lt = f["LogonType"] ?? "";
    if (eid === "4625") flag("failed_logon", f["EventType"] || "Failed Logon");
    if (lt === "9") flag("new_credentials_logon", `LogonType: ${lt}`);
    else if (lt === "10") flag("remote_interactive_logon", `LogonType: ${lt}`);
    else if (["2", "7", "11"].includes(lt)) good.set("interactive_logon", `LogonType: ${lt}`);
    else if (["0", "4", "5"].includes(lt)) good.set("service_logon", `LogonType: ${lt}`);
    if (lower(auth) === "kerberos") good.set("kerberos_auth", auth);
  }
  const priv = span(RE_PRIV, cmd);
  if (priv) flag("privilege_escalation", priv);

  // the process itself
  if (img) {
    if (within(idir, TEMP_DIRS)) flag("temp_path_exec", img.includes("\\") ? img.slice(0, img.lastIndexOf("\\")) : img);
    if (ibc !== ib || (MASQ_NAMES.has(ibc) && !atHome(ibc, idir))) flag("masquerading_name", img);
    if (LOLBINS.has(ib)) flag("lolbin_exec", ib);
    if (ib === "sdbinst.exe") flag("app_shim_install", span(RE_SDB, cmd) || img);
  }
  if (signed === "false") flag("unsigned_binary", base(tgt) || ib || "-");
  else if (signed === "true" && signer)
    good.set(lower(signer).includes("microsoft") ? "signed_microsoft" : "signed_known_vendor", signer);
  if (idir && atHome(ibc, idir)) good.set("system32_path", idir);

  // command line
  if (cmd) {
    for (const [key, fire, quote] of CMD_RULES) {
      if (fire.some((rx) => rx.test(cmd))) {
        for (const rx of [...quote, ...fire]) {
          const v = span(rx, cmd);
          if (v) { flag(key, v); break; }
        }
      }
    }
    const lm = RE_LOLBIN_CMD.exec(cmd);
    if (lm && !bad.has("lolbin_exec") && base(pySplitWs(lm[1]!)[0]) !== ib) flag("lolbin_exec", lm[1]);
  }

  // registry writes
  if (regWrite && t) {
    if (RE_REG_SERVICE.test(t)) flag("service_binary_created", tgt);
    if (RE_REG_PERSIST.test(t) || (t.includes("\\environment\\") && t.includes("userinitmprlogonscript")))
      flag("persistence_autorun", tgt);
    if (RE_REG_UAC.test(t)) flag("uac_bypass", tgt);
    if (RE_REG_EVASION.test(t)) flag("defense_evasion", tgt);
    if (RE_REG_SHIM.test(t)) flag("app_shim_install", tgt);
    if (RE_REG_SAM.test(t)) flag("account_manipulation", tgt);
    if (RE_REG_CRED.test(t)) flag("credential_access", tgt);
  }

  // image loads from a user-writable path
  if (eid === "7" && t && within(t, WRITABLE)) flag("temp_path_exec", tgt);

  // file writes
  if (eid === "11" && t) {
    if (t.endsWith(".sdb")) flag("app_shim_install", tgt);
    if (t.includes("\\start menu\\programs\\startup\\")) flag("persistence_autorun", tgt);
    if (PAYLOAD_EXT.some((e) => t.endsWith(e)) && within(t, WRITABLE)) flag("payload_dropped", tgt);
    if (t.includes("\\system32\\") && t.endsWith(".exe")) flag("service_binary_created", tgt);
  }

  // network
  if (eid === "3") {
    const port = f["DestinationPort"] ?? "";
    const dip = f["DestinationIp"] ?? "";
    const dns = f["DestinationHostname"] ?? "";
    const pn = pyInt(port) ?? -1;
    if (pn === 445 || pn === 139) flag("smb_admin_share", `${dip}:${port}`);
    if ([80, 443, 53, 123, 88, 389, 636, 3268].includes(pn)) good.set("outbound_known_good", `${dip}:${port}`);
    else if (pn >= 0 && ![445, 139, 135, 3389, 5985, 5986].includes(pn)) flag("outbound_uncommon_port", `${dip}:${port}`);
    if (!dns && RE_IP.test(dip)) flag("raw_ip_no_dns", dip);
  }
  const remote = span(RE_ADMIN_SHARE, cmd) || span(RE_REMOTE_EXEC, cmd);
  if (remote) flag("remote_service_install", remote);

  const rank = (k: string) => (PRIORITY.includes(k) ? PRIORITY.indexOf(k) : PRIORITY.length);
  const ranked = [...bad.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  const out: Record<string, string> = {};
  for (const [k, v] of [...ranked, ...good.entries()]) {
    if (INDICATORS.has(k) && !(k in out)) out[k] = clip(v);
    if (Object.keys(out).length === 4) break;
  }
  return out;
}

// ---------------------------------------------------------------- threatType

type Rule = [string, (f: Fields, i: Record<string, string>, c: string) => boolean];
const has = (i: Record<string, string>, ...ks: string[]) => ks.some((k) => k in i);
const THREAT_RULES: Rule[] = [
  ["credential_stuffing", (f) => f["EventID"] === "4625"],
  ["credential_access", (_f, i) => has(i, "credential_access", "account_manipulation")],
  ["ransomware", (_f, _i, c) => RE_RECOVERY.test(c)],
  ["privilege_escalation", (_f, i) => has(i, "uac_bypass", "privilege_escalation")
    || ("system_context_exec" in i && has(i, "masquerading_name", "temp_path_exec"))],
  ["lateral_movement", (f, i) => has(i, "remote_service_install", "smb_admin_share",
    "new_credentials_logon", "remote_interactive_logon")
    || ("legacy_auth_protocol" in i && f["LogonType"] === "3")],
  ["defense_evasion", (_f, i) => "defense_evasion" in i],
  ["persistence", (_f, i) => has(i, "persistence_autorun", "app_shim_install",
    "accessibility_hijack", "service_binary_created")],
  ["rce", (_f, i) => "reverse_shell" in i],
  ["data_exfiltration", (_f, _i, c) => RE_EXFIL.test(c)],
  ["reconnaissance", (_f, i) => "discovery_command" in i],
  ["cryptomining", (_f, _i, c) => RE_MINER.test(c)],
  ["malware", (_f, i) => has(i, "download_cradle", "encoded_command", "temp_path_exec",
    "masquerading_name", "office_spawns_shell", "browser_spawns_shell", "payload_dropped",
    "proxy_execution", "lolbin_exec", "unsigned_binary", "service_host_spawns_proc",
    "raw_ip_no_dns", "outbound_uncommon_port")],
  ["defense_evasion", (_f, i) => has(i, "hidden_window", "exec_policy_bypass")],
  ["unknown", () => true],
];

export function threatType(f: Fields, ind: Record<string, string>, cls: Cls): string | null {
  if (cls === "benign") return null;
  const c = [f["CommandLine"], f["TargetFilename"], f["TargetObject"], f["Details"]].filter((x) => x).join(" ");
  for (const [name, test] of THREAT_RULES) if (test(f, ind, c)) return name;
  return "unknown";
}

// ---------------------------------------------------------------- reasoning

const BENIGN_KEYS = new Set(["signed_microsoft", "signed_known_vendor", "system32_path",
  "expected_parent", "restricted_service_acct", "outbound_known_good",
  "interactive_logon", "service_logon", "kerberos_auth"]);

const PHRASE: Record<string, string> = {
  office_spawns_shell: "an Office application spawned a shell",
  browser_spawns_shell: "a browser spawned a shell",
  service_host_spawns_proc: "a service host spawned an unexpected child",
  system_context_exec: "it runs in SYSTEM context",
  lolbin_exec: "the image is a living-off-the-land binary",
  temp_path_exec: "the image runs from a user-writable path",
  unsigned_binary: "the binary is unsigned",
  signature_invalid: "the signature failed validation",
  masquerading_name: "the filename mimics a system binary outside a system path",
  service_binary_created: "a service or system binary was written to disk",
  hidden_window: "the window is hidden",
  encoded_command: "the command line is encoded",
  download_cradle: "the command line fetches remote content",
  exec_policy_bypass: "execution policy is bypassed",
  discovery_command: "it enumerates hosts, users or domains",
  outbound_uncommon_port: "the destination port is non-standard",
  outbound_known_good: "the destination is a well-known service on its usual port",
  raw_ip_no_dns: "it connects to a literal IP with no DNS resolution",
  remote_service_install: "it acts against a remote host",
  smb_admin_share: "it touches an SMB administrative share",
  blank_or_guest_account: "the account is guest or blank-password",
  legacy_auth_protocol: "authentication is downgraded",
  privilege_escalation: "privileges are being elevated",
  signed_microsoft: "the binary carries a valid Microsoft signature",
  signed_known_vendor: "the binary is signed by a known vendor",
  system32_path: "it executes from a system path",
  expected_parent: "the parent-child relationship is normal",
  restricted_service_acct: "it runs under a restricted service account",
  credential_access: "it reads or dumps credential material",
  account_manipulation: "it creates, hides or changes a local account",
  uac_bypass: "an auto-elevating binary is used outside its normal launch context",
  accessibility_hijack: "an accessibility binary is launched or replaced abnormally",
  app_shim_install: "it installs an application-compatibility shim",
  persistence_autorun: "it arranges for code to run later",
  defense_evasion: "it weakens a security control, log or recovery mechanism",
  proxy_execution: "the process was launched through a proxy binary",
  payload_dropped: "an executable or script is written to a user-writable location",
  reverse_shell: "a command shell is bound to a network connection",
  new_credentials_logon: "it is a logon with alternate credentials for outbound use",
  remote_interactive_logon: "it is a Remote Desktop logon",
  failed_logon: "authentication failed",
  interactive_logon: "it is an interactive logon at the console",
  service_logon: "it is a system, scheduled-task or service logon",
  kerberos_auth: "it authenticated with Kerberos",
};

const VERDICT: Record<Cls, string> = {
  malicious: "This matches a known attack technique and should be treated as malicious.",
  suspicious: "This is consistent with legitimate administration but also with an "
    + "attack in progress, so it warrants review rather than a verdict.",
  benign: "Nothing here departs from normal activity for this host.",
};
const VERDICT_CONTEXT: Record<string, string> = {
  malicious: "It is classified as malicious on the pattern of the event as a whole, "
    + "not on any one indicator.",
  suspicious: "It warrants review on the pattern of the event as a whole, "
    + "not on any one indicator.",
};
const ACTION: Record<string, string> = {
  "1": "Process creation", "4688": "Process creation", "3": "Network connection",
  "7": "Image load", "11": "File creation", "12": "Registry key operation",
  "13": "Registry value set", "4624": "Successful logon", "4625": "Failed logon",
};

export function reasoning(f: Fields, ind: Record<string, string>, cls: Cls): string {
  const head = own(ACTION, f["EventID"] ?? "") ?? "Event";
  const img = base(f["Image"]) || base(f["TargetFilename"]) || f["User"] || "the subject";
  const keys = Object.keys(ind);
  const phrased = (k: string) => Object.hasOwn(PHRASE, k);
  if ("context_dependent" in ind && cls !== "benign") {
    const facts = keys.filter((k) => BENIGN_KEYS.has(k) && phrased(k)).map((k) => PHRASE[k]!);
    const seen = facts.length ? ` What it does show (${facts[0]}) does not explain the verdict.` : "";
    return `${head} by ${img}: no single field in this event is conclusive. ${VERDICT_CONTEXT[cls]}${seen}`;
  }
  const incrim = keys.filter((k) => !BENIGN_KEYS.has(k) && phrased(k)).map((k) => PHRASE[k]!);
  const excul = keys.filter((k) => BENIGN_KEYS.has(k) && phrased(k)).map((k) => PHRASE[k]!);
  const obs = (incrim.length ? incrim : excul).slice(0, 2);
  const joined = obs.length === 1 ? obs[0] : obs.length ? obs.join(" and ") : "no notable properties";
  let tail = "";
  if (incrim.length && excul.length && cls !== "benign") {
    tail = ` The mitigating evidence (${excul[0]}) does not outweigh it.`;
  } else if (incrim.length && cls === "benign") {
    const routine = f["EventID"] === "4624" || f["EventID"] === "4625"
      ? " On its own, for an ordinary account, this is routine."
      : " The pattern is documented normal behaviour for this binary.";
    tail = excul.length ? ` ${capitalize(excul[0]!)}, which accounts for it.` : routine;
  }
  return `${head} by ${img}: ${joined}. ${VERDICT[cls]}${tail}`;
}

// ---------------------------------------------------------------- assembly

export function explain(f: Fields, cls: Cls): Explanation {
  let ind = extract(f);
  // A threat verdict with no incriminating evidence says so, first, rather
  // than explaining itself with whatever reassuring evidence was left.
  if (cls !== "benign" && !Object.keys(ind).some((k) => !BENIGN_KEYS.has(k))) {
    ind = Object.fromEntries([["context_dependent", "-"], ...Object.entries(ind).slice(0, 3)]);
  }
  return {
    isThreat: cls !== "benign",
    threatType: threatType(f, ind, cls),
    indicators: ind,
    reasoning: reasoning(f, ind, cls),
  };
}
