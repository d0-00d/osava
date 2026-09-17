import { Router } from "express";
import { updateDefinitions, startScan, cancelScan } from "../services/avService";
import { runCommand, getPresetCommands, CommandError } from "../services/shellService";
import { readHistoryFile } from "../services/statusFile";
import fs from "node:fs/promises";
import { CLAMDB_DIR, currentScan } from "../config";

const router = Router();

router.get("/api/av/commands", (_req, res) => {
  res.json(getPresetCommands());
});

router.post("/api/av/exec", (req, res) => {
  const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
  if (!command) {
    return res.status(400).json({ error: "No command provided." });
  }
  if (currentScan.currentScan) {
    return res.status(409).json({ error: "Another command is already running.", code: "BUSY" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type: string, data: string) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  let child;
  try {
    child = runCommand(command, sendEvent, () => res.end());
  } catch (error: any) {
    // A rejected command is normal console usage, not a server fault — report
    // it in the stream so it lands in the terminal like any other output.
    sendEvent("error", error instanceof CommandError ? error.message : "Failed to run command");
    sendEvent("done", "");
    return res.end();
  }

  // Must be res, not req: on a POST the request stream closes as soon as the
  // body is read, which would kill the child immediately.
  res.on("close", () => child.kill());
});

router.get("/api/av/update-definitions", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type: string, data: string) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  const freshclam = updateDefinitions(
    sendEvent,
    () => res.end()
  );

  req.on("close", () => freshclam.kill());
});

router.get("/api/av/scan", (req, res) => {
  const scanPath = req.query.path as string;

  if (!scanPath) {
    res.status(400).json({ error: "No path provided." });
    return;
  }
  const verbose = req.query.verbose === "true";
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type: string, data: string) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  const clamscan = startScan(
    scanPath,
    verbose,
    sendEvent,
    () => res.end()
  );

  req.on("close", () => clamscan.kill());
});

router.post("/api/av/cancelscan", (req, res) => {
  const result = cancelScan();
  if (!result.success) {
    return res.status(result.error === "No scan is currently running!" ? 409 : 500).json(result);
  }
  return res.status(200).json(result);
});

router.get("/api/av/history", async(_req, res) => {
  try{
    const history = await readHistoryFile();
    res.status(200).json(history);
  } catch (error) {
    console.error("Error reading history file:", error);
    res.status(500).json({ error: "Failed to read history file." });
  }
  });

router.get("/definitions-status", async (_req, res) => {
  try {
    const files = await fs.readdir(CLAMDB_DIR);
    const hasDb = files.some(f => f.endsWith(".cvd") || f.endsWith(".cld"));
    res.json({ ready: hasDb });
  } catch {
    res.json({ ready: false });
  }
});
  
export default router;
