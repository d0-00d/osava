import express from "express";
import { existsSync } from "node:fs";
import { CONTRACT } from "../services/behaviour/contractSpec";
import { reviewReason } from "../services/behaviour/classifier";
import { monitor, probeLog } from "../services/behaviour/instance";
import { scanOnce, scanning } from "../services/behaviour/pipeline";
import { LogAccessDenied, LogMissing, probeSysmon } from "../services/behaviour/reader";
import {
  MODEL_PATH, ModelUnavailable, SERVER_EXE, installModel, installServer, isHealthy, startServer,
} from "../services/behaviour/runtime";
import { readState } from "../services/behaviour/store";
import { ElevationDenied, installSysmon, sysmonStatus } from "../services/behaviour/sysmonInstall";
import { localOnly } from "./localOnly";

const router = express.Router();
router.use("/api/behaviour", localOnly);

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/** Problems the user can fix get a stable `code` the UI can act on. */
function fail(res: express.Response, e: unknown) {
  if (e instanceof LogAccessDenied) return res.status(403).json({ error: e.message, code: "LOG_ACCESS_DENIED" });
  if (e instanceof ElevationDenied) return res.status(403).json({ error: e.message, code: "ELEVATION_DENIED" });
  if (e instanceof LogMissing) return res.status(409).json({ error: e.message, code: "LOG_MISSING" });
  if (e instanceof ModelUnavailable) return res.status(409).json({ error: e.message, code: "MODEL_UNAVAILABLE" });
  return res.status(500).json({ error: (e as Error).message });
}

// What Sysmon looks like from here costs two PowerShell launches, and the UI
// polls this route. Fresh enough to notice an install or a sign-out/in within
// seconds, cheap enough to leave open.
type SysmonInfo = { installed: boolean; running: boolean; log: Awaited<ReturnType<typeof probeSysmon>> };
let sysmonCache: { at: number; value: SysmonInfo } | null = null;
async function sysmonInfo(): Promise<SysmonInfo> {
  if (sysmonCache && Date.now() - sysmonCache.at < 10_000) return sysmonCache.value;
  const svc = await sysmonStatus();
  const value = { ...svc, log: svc.installed ? await probeSysmon() : ("missing" as const) };
  sysmonCache = { at: Date.now(), value };
  return value;
}

router.get("/api/behaviour/status", async (_req, res) => {
  try {
    const st = await readState();
    const counts = { benign: 0, suspicious: 0, malicious: 0, needsReview: 0 };
    for (const v of Object.values(st.verdicts)) {
      const cls = (CONTRACT.severity.bucket[v.severity] ?? "suspicious") as keyof typeof counts;
      counts[cls]++;
      if (v.needsReview) counts.needsReview++;
    }
    res.json({
      sysmon: await sysmonInfo(),
      runtime: { serverInstalled: existsSync(SERVER_EXE), modelInstalled: existsSync(MODEL_PATH), running: await isHealthy() },
      model: { ...CONTRACT.model, promptVariant: CONTRACT.prompt_variant, contract: CONTRACT.schema_version },
      monitor: monitor.state(),
      scanning: scanning(),
      behaviours: Object.keys(st.verdicts).length,
      counts,
      outOfDomain: st.outOfDomain,
      supportedEventIds: CONTRACT.input.supported_event_ids,
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
    fail(res, e);
  } finally {
    sysmonCache = null;
  }
});

// Two clicks must not start two downloads into the same file.
let runtimeInstall: Promise<{ modelSource: string }> | null = null;
router.post("/api/behaviour/install-runtime", async (_req, res) => {
  try {
    runtimeInstall ??= (async () => {
      await installServer();
      return { modelSource: await installModel() };
    })().finally(() => { runtimeInstall = null; });
    res.json(await runtimeInstall);
  } catch (e) {
    fail(res, e);
  }
});

router.post("/api/behaviour/scan", async (req, res) => {
  try {
    await probeLog();
    await startServer();
    const max = Math.min(Math.max(Math.floor(Number(req.query["max"])) || 25, 1), 200);
    res.json(await scanOnce(max));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/api/behaviour/monitor/start", (req, res) => {
  const raw = Number(req.query["intervalMs"]);
  res.json(monitor.start(Number.isFinite(raw) && raw > 0 ? raw : undefined));
});

router.post("/api/behaviour/monitor/stop", (_req, res) => {
  res.json(monitor.stop());
});

// Stops monitoring and unloads the model (frees its ~2 GB).
router.post("/api/behaviour/stop", (_req, res) => {
  monitor.stop();
  res.json({ stopped: true });
});

router.get("/api/behaviour/verdicts", async (req, res) => {
  const st = await readState();
  const onlyReview = req.query["view"] === "review";
  const limit = Math.min(Math.max(Math.floor(Number(req.query["limit"])) || 200, 1), 1000);
  const list = Object.values(st.verdicts)
    .filter((v) => !onlyReview || v.needsReview)
    .sort((a, b) =>
      Number(b.needsReview) - Number(a.needsReview) ||
      (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) ||
      b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit)
    .map((v) => ({ ...v, reviewReason: reviewReason(v) }));
  res.json(list);
});

export default router;
