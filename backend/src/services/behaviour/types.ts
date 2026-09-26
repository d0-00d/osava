export type Severity = "none" | "low" | "medium" | "high" | "critical";

/** The model's output after parsing — before the guard touches it. */
export interface Classification {
  severity: Severity;
  isThreat: boolean;
  threatType: string | null;
  indicators: Record<string, string | number | boolean>;
  reasoning: string;
}

/** What OSAVA stores and shows for one behaviour. */
export interface Verdict extends Classification {
  /** P(severity) from the first generated token — the R7 routing signal. */
  severityProbs: Record<string, number>;
  classProbs: Record<string, number>;
  /** top class probability minus the runner-up; low = the model is unsure */
  margin: number;
  needsReview: boolean;
  guard: import("./guard").GuardReport;
  /** true when the model's output could not be parsed and we failed open */
  failedOpen: boolean;
  modelSha256: string | undefined;
}
