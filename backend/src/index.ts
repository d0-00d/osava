import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import systemRoutes from "./routes/system";
import installRoutes from "./routes/install";
import avRoutes from "./routes/av";
import bootRoutes from "./routes/boot";
import behaviourRoutes from "./routes/behaviour";
import { stopServer } from "./services/behaviour/runtime";

dotenv.config();

const app = express();

// The console can run real AV binaries, so this API is an code-execution
// surface. Without an origin check any page the user visits could drive it,
// and without the loopback bind anyone on the LAN could too.
const ALLOWED_ORIGINS = [
  "http://localhost:1420", // vite dev server
  "http://tauri.localhost", // packaged app (Windows)
  "https://tauri.localhost",
];
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

app.use(systemRoutes);
app.use(installRoutes);
app.use(avRoutes);
app.use(bootRoutes);
app.use(behaviourRoutes);

// never leave llama-server running after the backend exits
for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => { stopServer(); if (sig !== "exit") process.exit(0); });

app.listen(4000, "127.0.0.1", () => console.log("backend running on 127.0.0.1:4000"));