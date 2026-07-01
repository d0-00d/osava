import { Router } from "express";
import os from "node:os";
import { queryProducts, queryFirewallProfiles } from "../services/systemStatus";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/api/homedir", (_req, res) => {
  res.json({ homedir: os.homedir() });
});

router.get("/api/system-status", async (_req, res) => {
  try {
    const [antivirus, firewall] = await Promise.all([
      queryProducts("AntiVirusProduct"),
      queryFirewallProfiles(),
    ]);
    res.json({ antivirus, firewall });
  } catch (error) {
    console.error("Error fetching system status:", error);
    res.status(500).json({ error: "Failed to fetch system status" });
  }
});

export default router;
