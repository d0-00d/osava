import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { exec } from "node:child_process";
import { promisify } from "node:util";



const execAsync = promisify(exec);


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

function decodeProductState(state: number) {
  const hexState = state.toString(16).padStart(6, '0');
  const protectionBytes = hexState.substring(2, 4);
  const defBytes = hexState.substring(4, 6);
  return {
    isEnabled: protectionBytes === "10" || protectionBytes === "11",
    isUpToDate: defBytes === "00"
  };
}

async function queryProducts(className: string) {
  const { stdout } = await execAsync(
    `powershell -Command "Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName ${className} | ConvertTo-Json"`
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item: any) => ({
    displayName: item.displayName,
    ...decodeProductState(item.productState)
  }));
}

async function queryFirewallProfiles() {
  const { stdout } = await execAsync('powershell -Command "Get-NetFirewallProfile | ConvertTo-Json"');
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((profile: any) => ({
    displayName: `${profile.Name} Firewall Profile`,
    isEnabled: profile.Enabled === true || profile.Enabled === 1 || String(profile.Enabled).toLowerCase() === "true",
    isUpToDate: true
  }));
}

app.get("/api/system-status", async (_req, res) => {
  try {
    const [antivirus, firewall] = await Promise.all([
      queryProducts("AntiVirusProduct"),
      queryFirewallProfiles()
    ]);
    res.json({ antivirus, firewall });
  } catch (error) {
    console.error("Error fetching system status:", error);
    res.status(500).json({ error: "Failed to fetch system status" });
  }
});
    


app.listen(4000, () => console.log("backend running on port 4000"));  
