import http from "node:http";
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

dotenv.config();

const app = express();
app.use(cors());

app.use(systemRoutes);
app.use(installRoutes);
app.use(avRoutes);
app.use(bootRoutes);
app.use(behaviourRoutes);

// never leave llama-server running after the backend exits (stop() releases it)
for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => { monitor.stop(); if (sig !== "exit") process.exit(0); });

// Loopback only: nothing on the network has a reason to reach this API, and a
// wildcard bind is also what makes Windows ask the user to allow the app
// through the firewall. Both address families, because "localhost" resolves to
// ::1 first on Windows and a connection refused there costs two seconds before
// the client falls back to IPv4 -- on every fresh connection.
for (const host of ["127.0.0.1", "::1"]) {
  const server = http.createServer(app);
  server.on("error", (e: NodeJS.ErrnoException) => {
    // IPv6 may be disabled (EADDRNOTAVAIL); losing ::1 only costs the fallback delay.
    if (host === "::1") console.warn(`not listening on [::1]:${API_PORT} (${e.code})`);
    else throw e;
  });
  server.listen(API_PORT, host, () => console.log(`backend running on ${host === "::1" ? "[::1]" : host}:${API_PORT}`));
}