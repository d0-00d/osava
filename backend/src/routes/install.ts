import { Router } from "express";
import { readStatusFile, writeStatusFile } from "../services/statusFile";
import { getClamAvDownloadUrl, installClamAV, getInstalledProductCode, uninstallClamAV } from "../services/clamavInstall";
import { currentScan } from "../config";
import type { InstallStatus } from "../types";


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
  const current = await readStatusFile();
  if (current.installed) {
    return res.status(409).json({
      error: "ClamAV is already installed",
      code: "ALREADY_INSTALLED",
    });
  }

  let status: InstallStatus;
  let installPath: string | undefined;
  let message: string;

  try {
    const url = await getClamAvDownloadUrl();
    const result = await installClamAV(url);
    status = {
      installed: true,
      engine: "clamav",
      installedAt: new Date().toISOString(),
      productCode: result.productCode,
    };
    installPath = result.installPath;
    message = "ClamAV installed";
  } catch (error: any) {
    if (error.code === 3010) {
      const productCode = await getInstalledProductCode("ClamAV");
      status = {
        installed: true,
        engine: "clamav",
        installedAt: new Date().toISOString(),
        productCode: productCode,
      };
      installPath = "C:\\Program Files\\ClamAV";
      message = "ClamAV installed successfully (reboot required)";
    } else if (error.code === 1223) {
      return res.status(403).json({
        error: "Elevation was denied — the install was cancelled.",
        code: "ELEVATION_DENIED",
      });
    } else {
      console.error("Install failed:", error);
      return res.status(500).json({ error: error.message || "Failed to install ClamAV" });
    }
  }

  await writeStatusFile(status);
  res.json({ success: true, message, installPath, productCode: status.productCode });
});

router.post("/api/uninstall", async (_req, res) => {
  // The status file is the authority on what's installed — the client doesn't
  // have to tell us which engine to remove.
  const current = await readStatusFile();
  if (!current.installed) {
    return res.status(400).json({ error: "Nothing installed" });
  }

  if (currentScan.currentScan != null) {
    return res.status(409).json({ error: "A scan is currently running — cancel it before uninstalling.", code: "SCAN_IN_PROGRESS" });
  }

  let message: string;
  try {
    let productCode = current.productCode;
    if (!productCode) productCode = await getInstalledProductCode("ClamAV");
    if (!productCode) {
      return res.status(400).json({ error: "Could not determine product code" });
    }
    await uninstallClamAV(productCode);
    message = "ClamAV uninstalled";
  } catch (error: any) {
    if (error.code === 3010) {
      // Reboot required, but it IS uninstalled — fall through to the write.
      message = "ClamAV uninstalled (reboot required)";
    } else if (error.code === 1223) {
      // UAC elevation was denied — msiexec never ran, ClamAV is still installed.
      // Do NOT write install-status.json; report an honest, distinct failure.
      return res.status(403).json({
        error: "Elevation was denied — the uninstall was cancelled.",
        code: "ELEVATION_DENIED",
      });
    } else {
      console.error("Uninstall failed:", error);
      return res.status(500).json({ error: error.message || "Failed to uninstall ClamAV" });
    }
  }

  await writeStatusFile({ installed: false, engine: null, installedAt: null, productCode: null });
  res.json({ success: true, message });
});

export default router;
