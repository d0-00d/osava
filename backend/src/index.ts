import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import systemRoutes from "./routes/system";
import installRoutes from "./routes/install";
import avRoutes from "./routes/av";
import bootRoutes from "./routes/boot";
import behaviourRoutes from "./routes/behaviour";
import { API_PORT } from "./config";
import { monitor } from "./services/behaviour/instance";
import { watchParent } from "./parentWatch";

dotenv.config();

// The window starts this process and cannot see why it died: its output is not captured. A line in a
// file the user can find turns "OSAVA shows nothing" into "port 4000 is in use".
const LOG = path.join(os.homedir(), ".osava", "backend.log");
function note(msg: string): void {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200_000) fs.rmSync(LOG);   // a trail, not an archive
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* nowhere to write it: nothing more to do */ }
}
process.on("uncaughtException", (e) => { note(`crashed: ${e.stack ?? e}`); process.exit(1); });

const app = express();
app.use(cors());

app.use(systemRoutes);
app.use(installRoutes);
app.use(avRoutes);
app.use(bootRoutes);
app.use(behaviourRoutes);

// never leave llama-server running after the backend exits (stop() releases it)
for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => { monitor.stop(); if (sig !== "exit") process.exit(0); });

// Started by the window, which tells us who it is. If it is killed instead of closed, nothing else
// will ever stop us (exit runs monitor.stop(), which releases llama-server).
const parent = Number(process.env["OSAVA_PARENT_PID"]);
if (Number.isInteger(parent) && parent > 0) {
  watchParent(parent, () => { note(`the window (pid ${parent}) is gone: stopping`); process.exit(0); });
}

// Loopback only: nothing on the network has a reason to reach this API, and a
// wildcard bind is also what makes Windows ask the user to allow the app
// through the firewall. Both address families, because "localhost" resolves to
// ::1 first on Windows and a connection refused there costs two seconds before
// the client falls back to IPv4 -- on every fresh connection.
for (const host of ["127.0.0.1", "::1"]) {
  const server = http.createServer(app);
  server.on("error", (e: NodeJS.ErrnoException) => {
    // IPv6 may be disabled (EADDRNOTAVAIL); losing ::1 only costs the fallback delay.
    if (host === "::1") { console.warn(`not listening on [::1]:${API_PORT} (${e.code})`); return; }
    note(e.code === "EADDRINUSE"
      ? `cannot start: port ${API_PORT} is already in use by another program (close it, or another copy of OSAVA, and start OSAVA again)`
      : `cannot start: ${e.message}`);
    process.exit(1);
  });
  server.listen(API_PORT, host, () => {
    console.log(`backend running on ${host === "::1" ? "[::1]" : host}:${API_PORT}`);
    if (host !== "::1") note(`started on port ${API_PORT} (pid ${process.pid})`);
  });
}