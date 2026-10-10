import path from "node:path";
import os from "node:os";
import { ChildProcess } from "node:child_process";

// The API the OSAVA window talks to. Loopback only: see index.ts and routes/localOnly.ts.
// OSAVA_API_PORT is for tests and for a developer whose 4000 is taken; the window itself still talks to 4000.
export const API_PORT = Number(process.env["OSAVA_API_PORT"] ?? 4000);

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
