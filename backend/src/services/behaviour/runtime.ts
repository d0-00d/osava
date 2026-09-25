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

export const LLAMA_BUILD = "b11177";
const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`;
const LLAMA_SHA256 = "6e4e7a8cea0d2dbd0a745b55f6b42d46d8130f8df4791938802f8269dfc205d5";
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;

const LLM_DIR = path.join(os.homedir(), ".osava", "llm");
const SERVER_DIR = path.join(LLM_DIR, LLAMA_BUILD);
export const SERVER_EXE = path.join(SERVER_DIR, "llama-server.exe");
export const MODEL_PATH = path.join(LLM_DIR, "osava-smollm-q4.gguf");
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

/** Get the model onto disk from the cheapest source that verifies. */
export async function installModel(): Promise<"present" | "ollama" | "download"> {
  const want = CONTRACT.model.gguf_sha256;
  if (!want) throw new Error("contract.json has no model checksum; regenerate it with --model-sha256");
  if (existsSync(MODEL_PATH) && (await sha256File(MODEL_PATH)) === want) return "present";

  // Ollama stores models content-addressed: the blob's name IS its sha256.
  const blob = path.join(OLLAMA_BLOBS, `sha256-${want}`);
  if (existsSync(blob)) {
    await fs.mkdir(LLM_DIR, { recursive: true });
    await fs.copyFile(blob, MODEL_PATH);
    if ((await sha256File(MODEL_PATH)) === want) return "ollama";
  }
  if (!MODEL_URL) {
    throw new Error("The classifier model is not installed and OSAVA_MODEL_URL is not set.");
  }
  await download(MODEL_URL, MODEL_PATH);
  const got = await sha256File(MODEL_PATH);
  if (got !== want) {
    await fs.rm(MODEL_PATH, { force: true });
    throw new Error(`model checksum mismatch: expected ${want}, got ${got}`);
  }
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
    throw new Error("contract.json has no canaries; regenerate it with --model-sha256");
  }
  for (const c of canaries) {
    const v = await classify(c.body, { baseUrl: baseUrl(), apiKey });
    const got = CONTRACT.severity.bucket[v.severity];
    if (got !== c.expect) {
      stopServer();
      throw new Error(`model self-test failed on ${c.id}: expected ${c.expect}, got ${got} ` +
        `(severity ${v.severity}). The loaded model is not the classifier this contract expects.`);
    }
  }
  verified = true;
}

export async function startServer(): Promise<void> {
  if (proc && verified && (await isHealthy())) return;
  if (!existsSync(SERVER_EXE)) throw new Error("llama-server is not installed");
  if (!existsSync(MODEL_PATH)) throw new Error("the classifier model is not installed");
  // A fresh key per launch. llama-server otherwise accepts requests from any
  // origin, so any web page open in a browser could drive the model through
  // localhost; only OSAVA's backend knows this key.
  apiKey = randomBytes(24).toString("hex");
  const args = ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT),
    "-c", "4096", "-np", "1", "-ngl", "99", "--no-ui", "--api-key", apiKey];
  if (DEVICE) args.push("--device", DEVICE);
  proc = spawn(SERVER_EXE, args, { cwd: SERVER_DIR, windowsHide: true, stdio: "ignore" });
  proc.on("exit", () => { proc = null; });
  for (let i = 0; i < 60; i++) {
    if (!proc) throw new Error(`llama-server exited during startup (is port ${PORT} in use?)`);
    if (await isHealthy()) {
      // Something answering /health is not proof it is our process: if the
      // port was already taken, ours has failed to bind and is about to exit.
      if (!(await isOurs())) {
        stopServer();
        throw new Error(`port ${PORT} is answered by a llama-server OSAVA did not start`);
      }
      return selfTest();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopServer();
  throw new Error("llama-server did not become healthy within 60s");
}

export function stopServer(): void {
  proc?.kill();
  proc = null;
  verified = false;
}
