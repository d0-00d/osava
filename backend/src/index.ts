import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import emailRoutes from "./routes/email";
import systemRoutes from "./routes/system";
import installRoutes from "./routes/install";
import avRoutes from "./routes/av";
import bootRoutes from "./routes/boot";

dotenv.config();

if (!process.env.HIBP_API_KEY) {
  console.error("Server misconfigured: missing API key");
}

const app = express();
app.use(cors());

app.use(emailRoutes);
app.use(systemRoutes);
app.use(installRoutes);
app.use(avRoutes);
app.use(bootRoutes);

app.listen(4000, () => console.log("backend running on port 4000"));