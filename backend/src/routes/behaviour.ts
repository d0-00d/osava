import express from "express";
import { existsSync } from "node:fs";
import { CONTRACT } from "../services/behaviour/contract";
import { scanOnce } from "../services/behaviour/pipeline";
import { LogAccessDenied } from "../services/behaviour/reader";
import {
  MODEL_PATH, SERVER_EXE, installModel, installServer, isHealthy, startServer, stopServer,
} from "../services/behaviour/runtime";
import { readState } from "../services/behaviour/store";
import { installSysmon, sysmonStatus } from "../services/behaviour/sysmonInstall";

const router = express.Router();
const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

router.get("/api/behaviour/status", async (_req, res) => {
  try {
    const st = await readState();
    res.json({
      sysmon: await sysmonStatus(),
      runtime: { serverInstalled: existsSync(SERVER_EXE), modelInstalled: existsSync(MODEL_PATH), running: await isHealthy() },
      model: { ...CONTRACT.model, promptVariant: CONTRACT.prompt_variant, contract: CONTRACT.schema_version },
      behaviours: Object.keys(st.verdicts).length,
      outOfDomain: st.outOfDomain,
      bookmark: st.bookmark,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/api/behaviour/install-sysmon", async (_req, res) => {
  try {
    const r = await installSysmon();
    res.json({ ...r, note: "Sign out and back in once so the new log-reading permission takes effect." });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/api/behaviour/install-runtime", async (_req, res) => {
  try {
    await installServer();
    res.json({ modelSource: await installModel() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/api/behaviour/scan", async (req, res) => {
  try {
    await startServer();
    const max = Math.min(Number(req.query["max"] ?? 25) || 25, 200);
    res.json(await scanOnce(max));
  } catch (e) {
    if (e instanceof LogAccessDenied) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post("/api/behaviour/stop", (_req, res) => {
  stopServer();
  res.json({ stopped: true });
});

router.get("/api/behaviour/verdicts", async (_req, res) => {
  const st = await readState();
  const list = Object.values(st.verdicts).sort((a, b) =>
    Number(b.needsReview) - Number(a.needsReview) ||
    (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) ||
    b.lastSeen.localeCompare(a.lastSeen));
  res.json(list);
});

export default router;
