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
};