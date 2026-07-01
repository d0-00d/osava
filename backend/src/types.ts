import type { ChildProcess } from "node:child_process";

export type InstallStatus = {
  installed: boolean;
  engine: string | null;
  installedAt: string | null;
  productCode: string | null;
};

export type ScanRecord = {
  currentScan: ChildProcess | null;
};
