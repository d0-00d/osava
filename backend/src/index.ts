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
app.use(cors());

app.use(systemRoutes);
app.use(installRoutes);
app.use(avRoutes);
app.use(bootRoutes);
app.use(behaviourRoutes);

// never leave llama-server running after the backend exits
for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => { stopServer(); if (sig !== "exit") process.exit(0); });

app.listen(4000, () => console.log("backend running on port 4000"));