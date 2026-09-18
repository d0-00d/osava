export type InstallStatus = {
  installed: boolean;
  engine: "clamav" | null;
  installedAt: string | null;
  productCode: string | null;
};

export type ScanRecord = {
  id: string;
  path: string;
  startedAt: string;
  finishedAt: string;
  outcome: "clean" | "infected" | "cancelled" | "error";
  infectedFiles: string[];
  verbose: boolean;
  // Read out of clamscan's SCAN SUMMARY. Optional: records written before this
  // existed don't have them.
  scannedDirs?: number | undefined;
  scannedFiles?: number | undefined;
};