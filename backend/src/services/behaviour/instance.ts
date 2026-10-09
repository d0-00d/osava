// The one monitor of this backend process, wired to the real log, pipeline and
// model server. (monitor.ts is the logic and takes its dependencies as
// arguments, so its tests need neither PowerShell nor a model.)

import { createMonitor } from "./monitor";
import { scanOnce } from "./pipeline";
import { readSysmon } from "./reader";
import { startServer, stopServer } from "./runtime";

/** Opens the log and asks for nothing: throws LogAccessDenied / LogMissing.
 *  Checked before the model is started so a setup problem is reported in a
 *  moment, not after the model has spent several seconds loading. */
export const probeLog = async (): Promise<void> => { await readSysmon(Number.MAX_SAFE_INTEGER, 1); };

export const monitor = createMonitor({
  probeLog,
  startModel: startServer,
  stopModel: stopServer,
  scan: () => scanOnce(),
});
