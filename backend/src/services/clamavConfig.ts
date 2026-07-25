import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CLAMDB_DIR, FRESHCLAM_CONF } from "../config";

/**
 * Ensure ClamAV's writable data exists: the database directory freshclam
 * downloads into, and freshclam.conf. Both live under the user profile
 * (~/.osava), so this needs NO admin rights and works on any machine.
 *
 * It's idempotent and cheap, so we call it before every update/scan — which
 * means it also self-heals an install where this setup was skipped or where
 * ClamAV was installed some other way.
 */
export function ensureClamConfig(): void {
  fs.mkdirSync(CLAMDB_DIR, { recursive: true });

  if (!fs.existsSync(FRESHCLAM_CONF)) {
    const logPath = path.join(os.homedir(), ".osava", "freshclam.log");
    const content =
      `DatabaseDirectory "${CLAMDB_DIR}"\n` +
      "DatabaseMirror database.clamav.net\n" +
      `UpdateLogFile "${logPath}"\n` +
      "LogTime yes\n";
    fs.writeFileSync(FRESHCLAM_CONF, content, "utf-8");
  }
}
