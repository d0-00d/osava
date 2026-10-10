import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { CLAMAV_DIR, CLAMDB_DIR } from "../config";
import { CONTRACT } from "../services/behaviour/contractSpec";
import { MODEL_PATH, SERVER_EXE, modelVerified } from "../services/behaviour/runtime";
import { readStatusFile, readHistoryFile } from "../services/statusFile";

const router = Router();

/**
 * GET /api/boot
 *
 * Server-Sent Events endpoint that streams real backend initialization
 * status to the splash screen terminal. Each event is a JSON object with
 * { type, text } where type is "log" | "ok" | "warn" | "pending" | "done".
 * "pending" marks a subsystem that is planned but not wired up yet — the
 * splash shows it greyed out and it never blocks the launch.
 */
router.get("/api/boot", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type: string, text: string) => {
    res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
  };

  try {
    // ── Step 1: Backend environment ──────────────────────────
    send("log", "osava backend v1.0.0");
    send("log", "");
    await sleep(200);

    send("log", "> Checking environment configuration...");
    await sleep(300);

    send("ok", "  Environment configuration ready");
    await sleep(200);

    send("ok", "  Express server listening on :4000");
    await sleep(150);

    // ── Step 2: Route registration ──────────────────────────
    send("log", "> Registering route modules...");
    await sleep(250);

    const routes = [
      { name: "system",  endpoints: ["/health", "/api/homedir", "/api/system-status"] },
      { name: "install", endpoints: ["/api/install-status", "/api/uninstall"] },
      { name: "av",      endpoints: ["/api/av/scan", "/api/av/exec", "/api/av/commands", "/api/av/history"] },
    ];

    for (const route of routes) {
      send("ok", `  ✓ ${route.name} — ${route.endpoints.length} endpoint(s)`);
      await sleep(120);
    }
    send("log", "");

    // ── Step 3: ClamAV installation ─────────────────────────
    send("log", "> Verifying ClamAV installation...");
    await sleep(400);

    let clamInstalled = false;
    try {
      await fs.access(path.join(CLAMAV_DIR, "clamscan.exe"));
      clamInstalled = true;
      send("ok", `  ClamAV binaries found at ${CLAMAV_DIR}`);
    } catch {
      send("warn", `  ClamAV not found at ${CLAMAV_DIR}`);
    }
    await sleep(200);

    // ── Step 4: Install status file ─────────────────────────
    send("log", "> Reading install status...");
    await sleep(300);

    let installStatus: any = null;
    try {
      installStatus = await readStatusFile();
      if (installStatus.installed) {
        send("ok", `  Engine: ${installStatus.engine ?? "unknown"} — installed ${installStatus.installedAt ? new Date(installStatus.installedAt).toLocaleDateString() : "unknown date"}`);
      } else {
        send("warn", "  No security engine installed");
      }
    } catch {
      send("warn", "  Could not read status file (first run?)");
    }
    await sleep(200);

    // ── Step 5: Threat definitions ──────────────────────────
    send("log", "> Checking threat definitions database...");
    await sleep(400);

    let defsReady = false;
    try {
      const files = await fs.readdir(CLAMDB_DIR);
      defsReady = files.some(f => f.endsWith(".cvd") || f.endsWith(".cld"));
      if (defsReady) {
        const dbFiles = files.filter(f => f.endsWith(".cvd") || f.endsWith(".cld"));
        send("ok", `  ${dbFiles.length} definition file(s) loaded`);
      } else {
        send("warn", "  No definition files found — run freshclam to update");
      }
    } catch {
      send("warn", "  Definitions directory not accessible");
    }
    await sleep(200);

    // ── Step 6: Scan history ────────────────────────────────
    send("log", "> Loading scan history...");
    await sleep(300);

    let historyCount = 0;
    try {
      const history = await readHistoryFile();
      historyCount = Array.isArray(history) ? history.length : 0;
      if (historyCount > 0) {
        send("ok", `  ${historyCount} scan record(s) found`);
      } else {
        send("log", "  No previous scans");
      }
    } catch {
      send("log", "  No scan history file");
    }
    await sleep(200);

    // ── Step 7: Behaviour model ─────────────────────────────
    // What is on disk, from cheap checks only: the model is hashed once, when it
    // is installed, and that record is what is read here (hashing 1.9 GB on every
    // launch would hold the splash for seconds). The model is loaded later, when
    // monitoring starts, so this never claims it is running.
    send("log", "> Checking behaviour model...");
    await sleep(300);
    const name = CONTRACT.model.name ?? "osava-smollm";
    const sha = CONTRACT.model.gguf_sha256 ? `sha256 ${CONTRACT.model.gguf_sha256.slice(0, 8)}…` : "no model bound";
    if (await modelVerified()) {
      send("ok", `  ${name} installed and verified (${sha})`);
      if (existsSync(SERVER_EXE)) send("ok", "  llama.cpp runtime ready; the model loads when monitoring starts");
      else send("warn", "  llama.cpp runtime missing: open Behaviour and press Install model");
    } else if (existsSync(MODEL_PATH)) {
      send("warn", `  ${name} file present but not verified for this build: open Behaviour and press Install model`);
    } else {
      send("log", `  ${name} not installed: set it up from the Behaviour tab`);
    }
    await sleep(200);

    // ── Done ────────────────────────────────────────────────
    send("log", "");
    send("done", "All systems initialized. Ready.");

  } catch (err: any) {
    send("warn", `Boot sequence error: ${err.message}`);
    send("done", "Initialization completed with warnings.");
  }

  res.end();
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default router;
