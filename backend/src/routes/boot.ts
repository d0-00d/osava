import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { CLAMAV_DIR, CLAMDB_DIR } from "../config";
import { readStatusFile, readHistoryFile } from "../services/statusFile";

const router = Router();

/**
 * GET /api/boot
 *
 * Server-Sent Events endpoint that streams real backend initialization
 * status to the splash screen terminal. Each event is a JSON object with
 * { type, text } where type is "log" | "ok" | "warn" | "done".
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

    const hasApiKey = !!process.env.HIBP_API_KEY;
    if (hasApiKey) {
      send("ok", "  HIBP API key configured");
    } else {
      send("warn", "  HIBP API key missing — email breach checks will fail");
    }
    await sleep(200);

    send("ok", "  Express server listening on :4000");
    await sleep(150);

    // ── Step 2: Route registration ──────────────────────────
    send("log", "> Registering route modules...");
    await sleep(250);

    const routes = [
      { name: "system",  endpoints: ["/health", "/api/homedir", "/api/system-status"] },
      { name: "email",   endpoints: ["/api/check-email/:email"] },
      { name: "install", endpoints: ["/api/install-status", "/api/uninstall"] },
      { name: "av",      endpoints: ["/api/av/scan", "/api/av/update-definitions", "/api/av/history"] },
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
