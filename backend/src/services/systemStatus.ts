import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function decodeProductState(state: number) {
  const hexState = state.toString(16).padStart(6, "0");
  const protectionBytes = hexState.substring(2, 4);
  const defBytes = hexState.substring(4, 6);
  return {
    isEnabled: protectionBytes === "10" || protectionBytes === "11",
    isUpToDate: defBytes === "00",
  };
}

export async function queryProducts(className: string) {
  const { stdout } = await execAsync(
    `powershell -Command "Get-CimInstance -Namespace root\\\\SecurityCenter2 -ClassName ${className} | ConvertTo-Json"`
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item: any) => ({
    displayName: item.displayName,
    ...decodeProductState(item.productState),
  }));
}

export async function queryFirewallProfiles() {
  const { stdout } = await execAsync(
    'powershell -Command "Get-NetFirewallProfile | ConvertTo-Json"'
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((profile: any) => ({
    displayName: `${profile.Name} Firewall Profile`,
    isEnabled:
      profile.Enabled === true ||
      profile.Enabled === 1 ||
      String(profile.Enabled).toLowerCase() === "true",
    isUpToDate: true,
  }));
}
