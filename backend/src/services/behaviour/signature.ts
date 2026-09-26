// ─────────────────────────────────────────────────────────────
// Behaviour signatures — a port of osava-slm/signature.py.
//
// Collapses who and where (usernames, GUIDs, versions, IPs, ephemeral ports)
// and keeps what happened. OSAVA caches one verdict per signature: a benign
// capture of 52,791 events collapses to 1,788 signatures, which is what makes
// running a 3B model on a live Sysmon feed affordable on a laptop.
//
// Parity-tested against the Python on real records (parity/): a cache keyed
// on a different signature would silently disagree with every tool upstream.
// ─────────────────────────────────────────────────────────────

import { pySlice, pySplitWs } from "./pystr";

// Order matters: most specific first. Each mirrors signature.SUBS exactly.
const SUBS: [RegExp, string][] = [
  [/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g, "<GUID>"],
  [/S-1-5-21-[\d-]+/g, "<SID>"],
  [/\b[a-z]:\\users\\[^\\\s"]+/gi, "<PROFILE>"],
  [/\\(users|documents and settings)\\[^\\\s"]+/gi, "\\<PROFILE>"],
  [/\b\d+\.\d+\.\d+(\.\d+)?\b(?!\.\d)/g, "<VER>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>"],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, "<B64>"],
  [/\b[a-fA-F0-9]{16,}\b/g, "<HEX>"],
  [/\b[a-z0-9]{8}\.(tmp|dat|log|bin)\b/gi, "<RANDFILE>"],
  [/\\pipe\\[^\s"]+/gi, "\\pipe\\<PIPE>"],
  [/\b\d{3,}\b/g, "<N>"],
];
const VERDIR = /\\(?:app-)?<VER>\\/gi;

export function normalise(s: string | undefined | null): string {
  if (!s) return "";
  s = s.split("%%").join("%");
  for (const [pat, rep] of SUBS) s = s.replace(pat, () => rep);
  s = s.replace(VERDIR, () => "\\<VERDIR>\\");
  return pySplitWs(s.toLowerCase()).join(" ");
}

export function basename(path: string | undefined | null): string {
  if (!path) return "";
  const p = path.split("/").join("\\");
  return p.slice(p.lastIndexOf("\\") + 1).toLowerCase();
}

export function dirname(path: string | undefined | null): string {
  if (!path) return "";
  const p = path.split("/").join("\\");
  return p.includes("\\") ? normalise(p.slice(0, p.lastIndexOf("\\"))).toLowerCase() : "";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function cmdShape(cmdline: string | undefined, image: string | undefined): string {
  let c = normalise(cmdline);
  const b = basename(image);
  if (b) c = c.replace(new RegExp('^"?[^"\\s]*' + escapeRe(b) + '"?\\s*'), "");
  return pySlice(c, 300);
}

const WELL_KNOWN = new Set([80, 443, 53, 88, 123, 135, 139, 389, 445, 636, 3268, 3389,
  1433, 5985, 5986, 25, 110, 143, 993, 995]);
const SUSPECT_PORTS = new Set([4444, 1337, 8080, 8443, 9001, 1234, 31337, 6666, 6667, 8888]);

/** Python int() accepts surrounding whitespace, a sign, and _ separators. */
function pyInt(p: unknown): number | null {
  const s = String(p ?? "").trim();
  return /^[+-]?\d+(_\d+)*$/.test(s) ? Number(s.split("_").join("")) : null;
}

export function portBucket(p: unknown): string {
  const n = pyInt(p);
  if (n === null) return "noport";
  if (SUSPECT_PORTS.has(n)) return `suspect:${n}`;
  if (WELL_KNOWN.has(n)) return `wk:${n}`;
  if (n >= 49152) return "ephemeral";
  if (n < 1024) return "low";
  return "registered";
}

export function signature(f: Record<string, string>): string {
  const eid = String(f["EventID"] ?? "");
  const img = f["Image"] ?? "";
  const par = f["ParentImage"] ?? "";
  const parts = [eid, basename(img), dirname(img), basename(par)];
  if (eid === "1" || eid === "4688") {
    parts.push(cmdShape(f["CommandLine"] ?? "", img));
  } else if (eid === "11" || eid === "12" || eid === "13" || eid === "7") {
    parts.push(pySlice(normalise(f["TargetFilename"] ?? ""), 200));
  } else if (eid === "3") {
    parts.push(portBucket(f["DestinationPort"]), f["DestinationHostname"] ? "dns" : "nodns");
  } else if (eid === "4624" || eid === "4625") {
    parts.push(String(f["LogonType"] ?? ""), String(f["AuthPackage"] ?? ""));
  }
  return parts.join("|");
}

/** Port of targets.parse(): a rendered body back into fields. */
export function parseBody(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let last: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (m) { last = m[1]!; fields[last] = m[2]!; }
    else if (last !== null) fields[last] += "\n" + line;
  }
  return fields;
}
