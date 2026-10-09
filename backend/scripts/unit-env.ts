// Imported FIRST by unit.ts: store.ts and runtime.ts read these at import time.
// The state file is a throwaway and the "model" is a fake server on its own
// port, so a test run can never touch ~/.osava or a real llama-server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osava-unit-"));
process.env["OSAVA_STATE_FILE"] = path.join(dir, "behaviour.json");
process.env["OSAVA_LLM_PORT"] = "18089";
