// ─────────────────────────────────────────────────────────────
// The local model runtime: llama.cpp's llama-server + the osava-smollm GGUF.
//
// Downloaded on demand like ClamAV, not bundled, so the installer stays small.
// Both artefacts are pinned and checksum-verified:
//   * llama.cpp is pinned to one build. GitHub's releases/latest for
//     ggml-org/llama.cpp points at a tag holding only a text file -- the
//     ClamAV-style "latest" lookup would fetch nothing.
//   * the model must match contract.json's gguf_sha256 exactly, because the
//     contract (prompt, conversion rules) belongs to that one model.
// ─────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONTRACT } from "./contract";
import { classify } from "./classifier";

const execFileAsync = promisify(execFile);

/** The model or its server cannot be used as-is: missing, not the file the
 *  contract names, failed its self-test, or its port is taken. Retrying will
 *  not help; the user has to fix something. */
export class ModelUnavailable extends Error {}

export const LLAMA_BUILD = "b11177";
const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`;
const LLAMA_SHA256 = "6e4e7a8cea0d2dbd0a745b55f6b42d46d8130f8df4791938802f8269dfc205d5";
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;

const LLM_DIR = path.join(os.homedir(), ".osava", "llm");
const SERVER_DIR = path.join(LLM_DIR, LLAMA_BUILD);
export const SERVER_EXE = path.join(SERVER_DIR, "llama-server.exe");
export const MODEL_PATH = path.join(LLM_DIR, "osava-smollm-q4.gguf");
const VERIFIED_FILE = path.join(LLM_DIR, "model.verified.json");
const OLLAMA_BLOBS = path.join(os.homedir(), ".ollama", "models", "blobs");

/** Where to fetch the model when it is not already on disk. Set in .env. */
const MODEL_URL = process.env["OSAVA_MODEL_URL"];
/** e.g. "Vulkan0" to pin the iGPU; unset lets llama.cpp choose. */
const DEVICE = process.env["OSAVA_LLM_DEVICE"];
const PORT = Number(process.env["OSAVA_LLM_PORT"] ?? 8089);

export async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  const fh = await fs.open(tmp, "w");
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) await fh.write(chunk);
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dest);
}

export async function installServer(): Promise<void> {
  if (existsSync(SERVER_EXE)) return;
  const zip = path.join(LLM_DIR, LLAMA_ASSET);
  await download(LLAMA_URL, zip);
  const got = await sha256File(zip);
  if (got !== LLAMA_SHA256) {
    await fs.rm(zip, { force: true });
    throw new Error(`llama.cpp checksum mismatch: expected ${LLAMA_SHA256}, got ${got}`);
  }
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${SERVER_DIR}' -Force`], { windowsHide: true });
  await fs.rm(zip, { force: true });
}

/** Remember that the file at MODEL_PATH hashed to the contract's checksum, keyed
 *  by its size and mtime. Hashing 1.9 GB takes seconds; a file that is swapped
 *  or rewritten changes one of the two and is hashed again. */
async function recordVerified(): Promise<void> {
  const st = await fs.stat(MODEL_PATH);
  await fs.writeFile(VERIFIED_FILE,
    JSON.stringify({ sha256: CONTRACT.model.gguf_sha256, size: st.size, mtimeMs: st.mtimeMs }), "utf-8");
}

/** The file at MODEL_PATH must be the one the contract names, every time the
 *  server starts -- not only when it was installed. */
async function assertModelChecksum(): Promise<void> {
  const want = CONTRACT.model.gguf_sha256;
  if (!want) throw new ModelUnavailable("contract.json has no model checksum; regenerate it with --model-sha256");
  const st = await fs.stat(MODEL_PATH);
  try {
    const rec = JSON.parse(await fs.readFile(VERIFIED_FILE, "utf-8"));
    if (rec.sha256 === want && rec.size === st.size && rec.mtimeMs === st.mtimeMs) return;
  } catch { /* no record yet */ }
  const got = await sha256File(MODEL_PATH);
  if (got !== want) {
    throw new ModelUnavailable(`the model file is not the one this OSAVA expects ` +
      `(sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…)`);
  }
  await recordVerified();
}

/** Get the model onto disk from the cheapest source that verifies. */
export async function installModel(): Promise<"present" | "ollama" | "download"> {
  const want = CONTRACT.model.gguf_sha256;
  if (!want) throw new Error("contract.json has no model checksum; regenerate it with --model-sha256");
  if (existsSync(MODEL_PATH) && (await sha256File(MODEL_PATH)) === want) {
    await recordVerified();
    return "present";
  }

  // Ollama stores models content-addressed: the blob's name IS its sha256.
  const blob = path.join(OLLAMA_BLOBS, `sha256-${want}`);
  if (existsSync(blob)) {
    await fs.mkdir(LLM_DIR, { recursive: true });
    await fs.copyFile(blob, MODEL_PATH);
    if ((await sha256File(MODEL_PATH)) === want) {
      await recordVerified();
      return "ollama";
    }
  }
  if (!MODEL_URL) {
    throw new ModelUnavailable(
      `The classifier model is not installed. Put osava-smollm-q4.gguf (sha256 ${want.slice(0, 12)}…) in ` +
      `${LLM_DIR}, or set OSAVA_MODEL_URL to a download for it.`);
  }
  await download(MODEL_URL, MODEL_PATH);
  const got = await sha256File(MODEL_PATH);
  if (got !== want) {
    await fs.rm(MODEL_PATH, { force: true });
    throw new Error(`model checksum mismatch: expected ${want}, got ${got}`);
  }
  await recordVerified();
  return "download";
}

let proc: ChildProcess | null = null;
let apiKey = "";
export const baseUrl = () => `http://127.0.0.1:${PORT}`;
export const currentApiKey = () => apiKey;

export async function isHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** HTTP status of an authenticated call made with `key`. /health is public
 *  in llama-server; /tokenize is behind --api-key and costs nothing. */
async function statusWithKey(key: string): Promise<number> {
  try {
    const r = await fetch(`${baseUrl()}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ content: "x" }),
      signal: AbortSignal.timeout(2000),
    });
    return r.status;
  } catch {
    return 0;
  }
}

/** Is the server on our port the one we launched? Only ours knows this
 *  launch's key AND refuses a wrong one; a stale or foreign llama-server on the
 *  same port fails one of the two. */
async function isOurs(): Promise<boolean> {
  return (await statusWithKey(apiKey)) === 200 && (await statusWithKey(`x${apiKey}`)) === 401;
}

let verified = false;

/**
 * Prove the loaded model is the classifier this contract belongs to.
 *
 * A checksum proves which FILE is loaded, not that it is the right one: this
 * integration once pinned, with full confidence, the checksum of an untrained
 * base SmolLM3 that sat in an Ollama store under a classifier-like name. Same
 * architecture, same size to within 128 bytes; it answered "none" on a PsExec
 * service binary. Canaries are held-out events the real model gets right
 * with a wide margin; if any comes back wrong, refuse to classify. This also
 * catches a future llama.cpp build that mishandles the architecture.
 */
export async function selfTest(): Promise<void> {
  const canaries = CONTRACT.canaries ?? [];
  // No canaries means nothing was proven; that is a contract bug, not a pass.
  if (canaries.length === 0) {
    stopServer();
    throw new ModelUnavailable("contract.json has no canaries; regenerate it with --model-sha256");
  }
  for (const c of canaries) {
    const v = await classify(c.body, { baseUrl: baseUrl(), apiKey });
    const got = CONTRACT.severity.bucket[v.severity];
    if (got !== c.expect) {
      stopServer();
      throw new ModelUnavailable(`model self-test failed on ${c.id}: expected ${c.expect}, got ${got} ` +
        `(severity ${v.severity}). The loaded model is not the classifier this contract expects.`);
    }
  }
  verified = true;
}

let starting: Promise<void> | null = null;

/** Start (or reuse) the verified server. Concurrent callers share one start:
 *  two launches would race for the port, and the loser would be mistaken for a
 *  foreign server and kill the winner. */
export function startServer(): Promise<void> {
  if (!starting) {
    const p = launch();
    starting = p;
    const clear = () => { if (starting === p) starting = null; };
    p.then(clear, clear);
  }
  return starting;
}

async function launch(): Promise<void> {
  if (proc && verified && (await isHealthy())) return;
  if (!existsSync(SERVER_EXE)) throw new ModelUnavailable("llama-server is not installed");
  if (!existsSync(MODEL_PATH)) throw new ModelUnavailable("the classifier model is not installed");
  await assertModelChecksum();
  // A fresh key per launch. llama-server otherwise accepts requests from any
  // origin, so any web page open in a browser could drive the model through
  // localhost; only OSAVA's backend knows this key.
  apiKey = randomBytes(24).toString("hex");
  const args = ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT),
    "-c", "4096", "-np", "1", "-ngl", "99", "--no-ui", "--api-key", apiKey];
  if (DEVICE) args.push("--device", DEVICE);
  const mine = spawn(SERVER_EXE, args, { cwd: SERVER_DIR, windowsHide: true, stdio: "ignore" });
  proc = mine;
  // Identity check: a stopped server's exit can arrive after the next one has
  // started, and must not make us forget (and so never kill) the new one.
  mine.on("exit", () => { if (proc === mine) proc = null; });
  // A spawn that fails (antivirus blocking the exe, say) is an 'error' event,
  // and an unhandled one would take the whole backend down with it.
  let spawnError = "";
  mine.on("error", (e) => { spawnError = e.message; if (proc === mine) proc = null; });
  for (let i = 0; i < 60; i++) {
    if (!proc) {
      throw new ModelUnavailable(spawnError
        ? `llama-server could not be started: ${spawnError}`
        : `llama-server exited during startup (is port ${PORT} in use?)`);
    }
    if (await isHealthy()) {
      // Something answering /health is not proof it is our process: if the
      // port was already taken, ours has failed to bind and is about to exit.
      if (!(await isOurs())) {
        stopServer();
        throw new ModelUnavailable(`port ${PORT} is answered by a llama-server OSAVA did not start`);
      }
      return selfTest();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopServer();
  throw new ModelUnavailable("llama-server did not become healthy within 60s");
}

export function stopServer(): void {
  proc?.kill();
  proc = null;
  verified = false;
}
