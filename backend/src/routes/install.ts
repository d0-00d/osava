import { Router } from "express";
import { readStatusFile, writeStatusFile } from "../services/statusFile";
import { getClamAvDownloadUrl, installClamAV, getInstalledProductCode, uninstallClamAV } from "../services/clamavInstall";

const router = Router();

router.get("/api/install-status", async (_req, res) => {
  try {
    const status = await readStatusFile();
    res.json(status);
  } catch (error) {
    console.error("Error reading install status:", error);
    res.status(500).json({ error: "Failed to read install status" });
  }
});

router.post("/api/install-status", async (_req, res) => {
  try {
    const url = await getClamAvDownloadUrl();
    const { installPath, productCode } = await installClamAV(url);
    await writeStatusFile({
      installed: true,
      engine: "clamav",
      productCode,
      installedAt: new Date().toISOString(),
    });
    res.json({ success: true, message: "ClamAV installed", installPath, productCode });
  } catch (error: any) {
    if (error.code === 3010) {
      const productCode = await getInstalledProductCode("ClamAV");
      await writeStatusFile({
        installed: true,
        engine: "clamav",
        productCode,
        installedAt: new Date().toISOString(),
      });
      res.json({ success: true, message: "ClamAV installed (reboot required)" });
      return;
    }
    if (error.code === 1223) {
      // UAC elevation was denied — msiexec never ran, nothing changed on disk.
      // Do NOT write install-status.json; report an honest, distinct failure.
      return res.status(403).json({
        error: "Elevation was denied — the install was cancelled.",
        code: "ELEVATION_DENIED",
      });
    }
    console.error("Install failed:", error);
    res.status(500).json({ error: error.message || "Failed to install ClamAV" });
  }
});

router.post("/api/uninstall", async (_req, res) => {
  try {
    const status = await readStatusFile();
    if (!status.installed) {
      return res.status(400).json({ error: "Nothing installed" });
    }
    let productCode = status.productCode;
    if (!productCode) productCode = await getInstalledProductCode("ClamAV");
    if (!productCode) {
      return res.status(400).json({ error: "Could not determine product code" });
    }
    await uninstallClamAV(productCode);
    await writeStatusFile({ installed: false, engine: null, installedAt: null, productCode: null });
    res.json({ success: true, message: "ClamAV uninstalled" });
  } catch (error: any) {
    if (error.code === 3010) {
      await writeStatusFile({ installed: false, engine: null, installedAt: null, productCode: null });
      res.json({ success: true, message: "ClamAV uninstalled (reboot required)" });
      return;
    }
    if (error.code === 1223) {
      // UAC elevation was denied — msiexec never ran, ClamAV is still installed.
      // Do NOT write install-status.json; report an honest, distinct failure.
      return res.status(403).json({
        error: "Elevation was denied — the uninstall was cancelled.",
        code: "ELEVATION_DENIED",
      });
    }
    console.error("Uninstall failed:", error);
    res.status(500).json({ error: error.message || "Failed to uninstall ClamAV" });
  }
});

export default router;
