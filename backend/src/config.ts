import path from "node:path";
import { ChildProcess } from "node:child_process";

export const CLAMAV_DIR = "C:\\Program Files\\ClamAV";
export const CLAMDB_DIR = path.join(CLAMAV_DIR, "database");
export const FRESHCLAM_CONF = path.join(CLAMAV_DIR, "freshclam.conf");

/**
 * Shared mutable state for the currently-running scan process.
 * Passed by reference to the routes that need it.
 */
export const currentScan: { currentScan: ChildProcess | null } = { currentScan: null };
