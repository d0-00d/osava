import path from "node:path";
import os from "node:os";
import { ChildProcess } from "node:child_process";

// The MSI installs the binaries here (needs admin) — read-only for us.
export const CLAMAV_DIR = "C:\\Program Files\\ClamAV";

// ClamAV's writable data lives under the user profile so it never needs admin:
// freshclam downloads definitions into CLAMDB_DIR and reads FRESHCLAM_CONF.
const OSAVA_DIR = path.join(os.homedir(), ".osava");
export const CLAMDB_DIR = path.join(OSAVA_DIR, "db");
export const FRESHCLAM_CONF = path.join(OSAVA_DIR, "freshclam.conf");

/**
 * Shared mutable state for the currently-running scan process.
 * Passed by reference to the routes that need it.
 */
export const currentScan: { currentScan: ChildProcess | null } = { currentScan: null };
