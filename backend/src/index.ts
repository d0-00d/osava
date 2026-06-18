import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());

app.get("/api/check-email/:email", async(req, res) => {
  const email = encodeURIComponent(req.params.email);
  const response = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${email}`, {
    headers: {
      "hibp-api-key": process.env.HIBP_API_KEY || "",
      "user-agent": "osava"
    }
  });
  if (response.status === 404) {
    return res.json({ breached: false });
  } 
  if (!response.ok) {
    const errorBody = await response.text();
    return res.status(response.status).json({ error: `HIBP returned ${response.status}: ${errorBody}` });
  }
  const data = await response.json();
  res.json({ breached: true, breaches: data });
});
if (!process.env.HIBP_API_KEY) {
  console.error("Server misconfigured: missing API key");
}
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(4000, () => console.log("backend running on port 4000"));  