// The release gate: everything a clean machine will fetch, checked against what this code pins.
//
//   npm run verify-release            about 35 MB: llama.cpp, the Sysmon config and zip, and the model's URL
//   npm run verify-release -- --full  also downloads the 1.9 GB model from its URL, with OSAVA's own download
//                                     code, and checks its SHA-256
//
// A pinned hash only protects anyone if the thing it pins is still what the server serves, and a model
// that is not reachable at the address the contract names is an install that fails for every new user.
// Run it before tagging, and again after publishing the model. Exit status is non-zero if anything fails.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CONTRACT } from "../src/services/behaviour/contractSpec";
import { download } from "../src/services/behaviour/download";
import { LLAMA_SHA256, LLAMA_URL, modelUrl, psq, sha256File } from "../src/services/behaviour/runtime";
import { CONFIG_SHA256, CONFIG_URL, SYSMON_URL } from "../src/services/behaviour/sysmonInstall";

const FULL = process.argv.includes("--full");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osava-verify-"));
let failed = 0;
const row = (ok: boolean | null, what: string, detail = "") => {
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${what}${detail ? "  " + detail : ""}`);
  if (ok === false) failed++;
};
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function hashOf(url: string, name: string): Promise<{ sha: string; bytes: number }> {
  const dest = path.join(tmp, name);
  await download(url, dest, { reserveBytes: 0 });
  return { sha: await sha256File(dest), bytes: fs.statSync(dest).size };
}

(async () => {
  const m = CONTRACT.model;
  row(!!(m.gguf_sha256 && m.gguf_bytes), "contract is bound to a model", m.gguf_sha256 ? `${m.name} ${m.gguf_sha256.slice(0, 8)}… ${m.gguf_bytes} bytes` : "no checksum: regenerate with export_contract.py --model-sha256");
  row((CONTRACT.canaries ?? []).length > 0, "contract carries canaries", `${(CONTRACT.canaries ?? []).map((c) => c.id).join(", ")}`);

  // llama.cpp
  try {
    const r = await hashOf(LLAMA_URL, "llama.zip");
    row(r.sha === LLAMA_SHA256, "llama.cpp build matches its pinned SHA-256", `${mb(r.bytes)} from ${new URL(LLAMA_URL).host}`);
  } catch (e) { row(false, "llama.cpp build is downloadable", (e as Error).message); }

  // Sysmon
  try {
    const r = await hashOf(CONFIG_URL, "sysmonconfig.xml");
    row(r.sha === CONFIG_SHA256, "Sysmon config matches its pinned SHA-256", `${r.bytes} bytes`);
  } catch (e) { row(false, "Sysmon config is downloadable", (e as Error).message); }
  try {
    const zip = path.join(tmp, "Sysmon.zip");
    await download(SYSMON_URL, zip, { reserveBytes: 0 });
    if (process.platform !== "win32") {
      row(null, "Sysmon64.exe carries a valid Microsoft signature", "needs Windows (Get-AuthenticodeSignature)");
    } else {
      const dir = path.join(tmp, "sysmon");
      const ps = (c: string) => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", c], { windowsHide: true });
      await ps(`Expand-Archive -LiteralPath '${psq(zip)}' -DestinationPath '${psq(dir)}' -Force`);
      const { stdout } = await ps(`$s = Get-AuthenticodeSignature '${psq(path.join(dir, "Sysmon64.exe"))}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
      // the very test installSysmon applies before it will run the download elevated
      row(/^Valid\|.*Microsoft/.test(stdout.trim()), "Sysmon64.exe carries a valid Microsoft signature", stdout.trim().split("|")[1]?.slice(0, 60));
    }
  } catch (e) { row(false, "Sysmon is downloadable and verifiable", (e as Error).message); }

  // the model: the one thing a clean machine cannot do without
  const url = modelUrl();
  if (!url) {
    row(false, "the model has a download address", "no model.url in contract.json and OSAVA_MODEL_URL is unset: a clean machine cannot install the model");
  } else {
    try {
      const head = await fetch(url, { method: "HEAD" });
      const len = Number(head.headers.get("content-length"));
      row(head.ok, "the model's URL answers", `${head.status} ${new URL(url).host}`);
      row(len === m.gguf_bytes, "its size is the contract's", `${len} bytes${len === m.gguf_bytes ? "" : `, expected ${m.gguf_bytes}`}`);
      const ranged = await fetch(url, { headers: { Range: "bytes=0-0" } });
      row(ranged.status === 206, "it honours Range, so a broken download resumes", `HTTP ${ranged.status}`);
      await ranged.body?.cancel();
      if (FULL) {
        const dest = path.join(tmp, "model.gguf");
        let last = 0;
        await download(url, dest, { reserveBytes: 0, onProgress: (r, t) => { const p = t ? Math.floor((100 * r) / t) : 0; if (p >= last + 10) { last = p; console.log(`      ${p}%`); } } });
        row((await sha256File(dest)) === m.gguf_sha256, "the downloaded model matches the contract's SHA-256", mb(fs.statSync(dest).size));
      } else {
        row(null, "the downloaded model matches the contract's SHA-256", "run with --full (downloads 1.9 GB)");
      }
    } catch (e) { row(false, "the model is downloadable", (e as Error).message); }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = 1; });
