import { useState, useEffect } from "react";

type ProductStatus = {
  displayName: string;
  isEnabled: boolean;
  isUpToDate: boolean;
};

export default function Dashboard() {
  const [antivirus, setAntivirus] = useState<ProductStatus[]>([]);
  const [firewall, setFirewall] = useState<ProductStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch("http://localhost:4000/api/system-status");
        const data = await response.json();
        setAntivirus(data.antivirus);
        setFirewall(data.firewall);
      } catch (error) {
        console.error("Failed to fetch system status", error);
      } finally {
        setLoading(false);
      }
    }
    fetchStatus();
  }, []);

  return (
    <div>
      <h2>System Health</h2>
      {loading && <p>Checking protection status...</p>}

      {!loading && (
        <>
          <h3>Antivirus</h3>
          {antivirus.length === 0 && <p>No antivirus product detected.</p>}
          {antivirus.map((av) => (
            <div key={av.displayName}>
              <h4>{av.displayName}</h4>
              <p>Real-time protection: {av.isEnabled ? "On" : "Off"}</p>
              <p>Definitions: {av.isUpToDate ? "Up to date" : "Out of date"}</p>
            </div>
          ))}

          <h3>Firewall</h3>
          {firewall.length === 0 && <p>No firewall product detected.</p>}
          {firewall.map((fw) => (
            <div key={fw.displayName}>
              <h4>{fw.displayName}</h4>
              <p>Status: {fw.isEnabled ? "On" : "Off"}</p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}