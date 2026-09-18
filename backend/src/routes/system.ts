import { Router } from "express";
import os from "node:os";
import { readCachedStatus, refreshStatus, refreshStatusInBackground } from "../services/systemStatus";
import { readHistoryFile } from "../services/statusFile";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/api/homedir", (_req, res) => {
  res.json({ homedir: os.homedir() });
});

// ?refresh=true waits for fresh data. Otherwise the cached copy is returned
// straight away and a refresh runs behind it, so the dashboard never blocks on
// PowerShell.
router.get("/api/system-status", async (req, res) => {
  try {
    if (req.query.refresh === "true") {
      return res.json(await refreshStatus());
    }

    const cached = await readCachedStatus();
    if (cached) {
      refreshStatusInBackground();
      return res.json({ ...cached, fromCache: true });
    }

    // Nothing cached yet (first run), so there's no choice but to wait.
    res.json(await refreshStatus());
  } catch (error) {
    console.error("Error fetching system status:", error);
    res.status(500).json({ error: "Failed to fetch system status" });
  }
});

router.get("/api/stats", async (_req, res) => {
  try {
    const history = await readHistoryFile();
    const sum = (pick: (r: (typeof history)[number]) => number) =>
      history.reduce((total, r) => total + pick(r), 0);

    res.json({
      uptimeSeconds: Math.floor(process.uptime()),
      totalScans: history.length,
      // Every detection ever recorded, vs just the most recent scan's.
      totalThreats: sum((r) => r.infectedFiles?.length ?? 0),
      currentThreats: history[0]?.infectedFiles?.length ?? 0,
      scannedDirectories: sum((r) => r.scannedDirs ?? 0),
      scannedFiles: sum((r) => r.scannedFiles ?? 0),
      lastScanAt: history[0]?.finishedAt ?? null,
    });
  } catch (error) {
    console.error("Error building stats:", error);
    res.status(500).json({ error: "Failed to build stats" });
  }
});

export default router;
