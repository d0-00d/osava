import { Router } from "express";
import { updateDefinitions, startScan, cancelScan } from "../services/avService";

const router = Router();

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

export default router;
