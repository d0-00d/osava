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
//
// This has to work on machines nobody tested. So: downloads resume and report
// progress (download.ts), the unpack is atomic, the model is re-verified at
// every start, and if the GPU path crashes, hangs or computes nonsense the
// server is started again on the CPU instead of giving up.
// ─────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONTRACT } from "./contractSpec";
import { classify } from "./classifier";
import { download, DownloadError } from "./download";

const execFileAsync = promisify(execFile);

/** Quote a value for a PowerShell single-quoted string: a user called O'Brien must not break the command. */
export const psq = (s: string): string => s.replace(/'/g, "''");

/** The model or its server cannot be used as-is: missing, not the file the
 *  contract names, failed its self-test, or its port is taken. Retrying will
 *  not help; the user has to fix something. */
export class ModelUnavailable extends Error {}

/** The server would not start, stay up, or answer correctly on this device
 *  (a driver crash, a hang, wrong numbers). Another device may still work. */
export class DeviceFailure extends ModelUnavailable {}

export const LLAMA_BUILD = "b11177";
export const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`;
export const LLAMA_SHA256 = "6e4e7a8cea0d2dbd0a745b55f6b42d46d8130f8df4791938802f8269dfc205d5";
export const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;

export const LLM_DIR = path.join(os.homedir(), ".osava", "llm");
const SERVER_DIR = path.join(LLM_DIR, LLAMA_BUILD);
export const SERVER_EXE = path.join(SERVER_DIR, "llama-server.exe");
export const MODEL_PATH = path.join(LLM_DIR, "osava-smollm-q4.gguf");
const VERIFIED_FILE = path.join(LLM_DIR, "model.verified.json");
const OLLAMA_BLOBS = path.join(os.homedir(), ".ollama", "models", "blobs");

/** "none" forces the CPU, "Vulkan0" pins the iGPU; unset lets llama.cpp choose (and fall back to the CPU). */
const DEVICE = process.env["OSAVA_LLM_DEVICE"];
const PORT = Number(process.env["OSAVA_LLM_PORT"] ?? 8089);
/**
 * How long a freshly started server gets to answer. The first start on a machine
 * is slow: measured at 59 s on a clean install, against 8 s afterwards, because
 * Windows scans the just-downloaded, unsigned llama-server and its DLLs before
 * it will run them. A limit near that would make the first run give up (or fall
 * back to the CPU) exactly where it is most likely to be someone's first impression.
 */
const HEALTH_WAIT_S = 120;

/** Progress and cancellation for an install. `report` is told what is happening and how far along it is. */
export interface InstallHooks {
  signal?: AbortSignal;
  report?: (label: string, done: number, total: number | null) => void;
}

export async function sha256File(p: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<string> {
  const h = createHash("sha256");
  let n = 0;
  for await (const chunk of createReadStream(p)) {
    if (signal?.aborted) throw new DownloadError("CANCELLED", "Cancelled.");
    h.update(chunk as Buffer);
    n += (chunk as Buffer).length;
    onBytes?.(n);
  }
  return h.digest("hex");
}

export async function installServer(hooks: InstallHooks = {}): Promise<void> {
  if (existsSync(SERVER_EXE)) return;
  const zip = path.join(LLM_DIR, LLAMA_ASSET);
  // A zip left by an earlier attempt that failed while unpacking need not be fetched again.
  if (!(existsSync(zip) && (await sha256File(zip)) === LLAMA_SHA256)) {
    hooks.report?.("Downloading llama.cpp", 0, null);
    await download(LLAMA_URL, zip, {
      signal: hooks.signal, onProgress: (r, t) => hooks.report?.("Downloading llama.cpp", r, t),
    });
    const got = await sha256File(zip);
    if (got !== LLAMA_SHA256) {
      await fs.rm(zip, { force: true });
      throw new Error(`llama.cpp checksum mismatch: expected ${LLAMA_SHA256}, got ${got}`);
    }
  }
  hooks.report?.("Unpacking llama.cpp", 0, null);
  // Unpack beside the target and rename, so an interrupted unpack never leaves a
  // directory that has llama-server.exe but not the DLLs it needs, which
  // `existsSync(SERVER_EXE)` would then call "installed" forever.
  const tmp = `${SERVER_DIR}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath '${psq(zip)}' -DestinationPath '${psq(tmp)}' -Force`], { windowsHide: true });
  if (!existsSync(path.join(tmp, "llama-server.exe"))) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error("the llama.cpp download does not contain llama-server.exe");
  }
  await fs.rm(SERVER_DIR, { recursive: true, force: true });
  await fs.rename(tmp, SERVER_DIR);
  await fs.rm(zip, { force: true });
}

/** Does the file at MODEL_PATH carry the record that says it hashed to the contract's checksum? */
async function verifiedMatches(): Promise<boolean> {
  const want = CONTRACT.model.gguf_sha256;
  if (!want) return false;
  try {
    const st = await fs.stat(MODEL_PATH);
    const rec = JSON.parse(await fs.readFile(VERIFIED_FILE, "utf-8"));
    return rec.sha256 === want && rec.size === st.size && rec.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

/** Is the model file present AND known to be the right one? (A file someone copied in by hand is
 *  present but not yet verified; installModel() checks it.) */
export const modelVerified = verifiedMatches;

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
  if (await verifiedMatches()) return;
  const got = await sha256File(MODEL_PATH);
  if (got !== want) {
    throw new ModelUnavailable(`the model file is not the one this OSAVA expects ` +
      `(sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…)`);
  }
  await recordVerified();
}

/** Where to fetch the model: OSAVA_MODEL_URL overrides (a mirror, a test), otherwise the contract names it. */
export const modelUrl = (): string | undefined => process.env["OSAVA_MODEL_URL"] || CONTRACT.model.url;

/** Get the model onto disk from the cheapest source that verifies. */
export async function installModel(hooks: InstallHooks = {}): Promise<"present" | "ollama" | "download"> {
  const want = CONTRACT.model.gguf_sha256;
  if (!want) throw new Error("contract.json has no model checksum; regenerate it with --model-sha256");
  const size = CONTRACT.model.gguf_bytes ?? null;
  const matches = async (): Promise<boolean> => {
    hooks.report?.("Checking the model file", 0, size);
    return (await sha256File(MODEL_PATH, (n) => hooks.report?.("Checking the model file", n, size), hooks.signal)) === want;
  };

  if (await verifiedMatches()) return "present";
  if (existsSync(MODEL_PATH) && (await matches())) {
    await recordVerified();
    return "present";
  }

  // Ollama stores models content-addressed: the blob's name IS its sha256.
  const blob = path.join(OLLAMA_BLOBS, `sha256-${want}`);
  if (existsSync(blob)) {
    hooks.report?.("Copying the model from Ollama", 0, size);
    await fs.mkdir(LLM_DIR, { recursive: true });
    await fs.copyFile(blob, MODEL_PATH);
    if (await matches()) {
      await recordVerified();
      return "ollama";
    }
  }

  const url = modelUrl();
  if (!url) {
    throw new ModelUnavailable(
      `The classifier model is not installed. Put osava-smollm-q4.gguf (sha256 ${want.slice(0, 12)}…) in ` +
      `${LLM_DIR}, or set OSAVA_MODEL_URL to a download for it.`);
  }
  await download(url, MODEL_PATH, {
    signal: hooks.signal, onProgress: (r, t) => hooks.report?.("Downloading the model", r, t ?? size),
  });
  if (!(await matches())) {
    await fs.rm(MODEL_PATH, { force: true });
    throw new Error("The downloaded model did not match its checksum and was deleted. Try again; if it keeps " +
      "happening, the copy on the server is not the one this OSAVA was built for.");
  }
  await recordVerified();
  return "download";
}

let proc: ChildProcess | null = null;
let apiKey = "";
let device: "gpu" | "cpu" | null = null;
/** Once the GPU path has failed, later starts go straight to the CPU rather than failing the same way again. */
let cpuOnly = DEVICE === "none";
export const baseUrl = () => `http://127.0.0.1:${PORT}`;
export const currentApiKey = () => apiKey;
/** Which device the running (or last) server used; null before the first start. */
export const deviceUsed = () => device;

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

/** Can we bind the port? Checked first so a taken port is reported as that, not as a mystery exit. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

let verified = false;

/**
 * Prove the loaded model is the classifier this contract belongs to. Returns
 * what went wrong, or null.
 *
 * A checksum proves which FILE is loaded, not that it is the right one: this
 * integration once pinned, with full confidence, the checksum of an untrained
 * base SmolLM3 that sat in an Ollama store under a classifier-like name. Same
 * architecture, same size to within 128 bytes; it answered "none" on a PsExec
 * service binary. Canaries are held-out events the real model gets right
 * with a wide margin; if any comes back wrong, refuse to classify. This also
 * catches a future llama.cpp build that mishandles the architecture -- or a
 * GPU driver that computes wrong numbers.
 */
async function canaryFailure(): Promise<string | null> {
  const canaries = CONTRACT.canaries ?? [];
  // No canaries means nothing was proven; that is a contract bug, not a pass.
  if (canaries.length === 0) return "contract.json has no canaries; regenerate it with --model-sha256";
  for (const c of canaries) {
    const v = await classify(c.body, { baseUrl: baseUrl(), apiKey });
    const got = CONTRACT.severity.bucket[v.severity];
    if (got !== c.expect) {
      return `model self-test failed on ${c.id}: expected ${c.expect}, got ${got} ` +
        `(severity ${v.severity}). The loaded model is not the classifier this contract expects.`;
    }
  }
  return null;
}

export async function selfTest(): Promise<void> {
  const failure = await canaryFailure();
  if (failure) {
    stopServer();
    throw new ModelUnavailable(failure);
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
  // An explicit OSAVA_LLM_DEVICE is taken at its word. Otherwise let llama.cpp
  // choose, and if that device misbehaves -- some Vulkan drivers crash, hang or
  // compute garbage, and nobody can test them all -- start again on the CPU.
  await startServerWith(DEVICE ? [DEVICE] : cpuOnly ? ["none"] : [null, "none"]);
}

/**
 * Try each device in turn: `null` lets llama.cpp choose, "none" is the CPU. A
 * failure that is the device's (DeviceFailure) moves on to the next; anything
 * else, and any failure on the CPU, is final. Exported so the fallback can be
 * exercised on purpose (`["Vulkan9", "none"]`) without needing a broken driver.
 */
export async function startServerWith(candidates: (string | null)[]): Promise<void> {
  if (!(await portFree(PORT))) {
    throw new ModelUnavailable(`port ${PORT} is already in use by another program ` +
      `(set OSAVA_LLM_PORT to give the model server a different one)`);
  }
  let last: unknown;
  for (const dev of candidates) {
    try {
      await launchOn(dev);
      device = dev === "none" ? "cpu" : "gpu";
      if (dev === "none" && candidates.length > 1) cpuOnly = true;
      return;
    } catch (e) {
      last = e;
      stopServer();
      if (!(e instanceof DeviceFailure) || dev === "none") throw e;
      // The killed server may still hold the port for a moment; the next attempt must not trip over it.
      for (let i = 0; i < 50 && !(await portFree(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

async function launchOn(dev: string | null): Promise<void> {
  // A fresh key per launch. llama-server otherwise accepts requests from any
  // origin, so any web page open in a browser could drive the model through
  // localhost; only OSAVA's backend knows this key.
  apiKey = randomBytes(24).toString("hex");
  const args = ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT),
    "-c", "4096", "-np", "1", "-ngl", "99", "--no-ui", "--api-key", apiKey];
  if (dev) args.push("--device", dev);
  const mine = spawn(SERVER_EXE, args, { cwd: SERVER_DIR, windowsHide: true, stdio: "ignore" });
  proc = mine;
  // Identity check: a stopped server's exit can arrive after the next one has
  // started, and must not make us forget (and so never kill) the new one.
  mine.on("exit", () => { if (proc === mine) proc = null; });
  // A spawn that fails (antivirus blocking the exe, say) is an 'error' event,
  // and an unhandled one would take the whole backend down with it.
  let spawnError = "";
  mine.on("error", (e) => { spawnError = e.message; if (proc === mine) proc = null; });
  const where = dev === "none" ? "on the CPU" : dev ? `on ${dev}` : "on the default device";
  for (let i = 0; i < HEALTH_WAIT_S; i++) {
    if (!proc) {
      if (spawnError) throw new ModelUnavailable(`llama-server could not be started: ${spawnError}`);
      throw new DeviceFailure(`llama-server exited during startup ${where}`);
    }
    if (await isHealthy()) {
      // Something answering /health is not proof it is our process: if the
      // port was already taken, ours has failed to bind and is about to exit.
      if (!(await isOurs())) {
        stopServer();
        throw new ModelUnavailable(`port ${PORT} is answered by a llama-server OSAVA did not start`);
      }
      const failure = await canaryFailure();
      if (failure) {
        // Wrong answers from a GPU are a driver problem worth a CPU retry; wrong answers from the CPU are the model.
        throw dev === "none" ? new ModelUnavailable(failure) : new DeviceFailure(`${failure} (${where})`);
      }
      verified = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new DeviceFailure(`llama-server did not become healthy within ${HEALTH_WAIT_S} s ${where}`);
}

export function stopServer(): void {
  proc?.kill();
  proc = null;
  verified = false;
}
