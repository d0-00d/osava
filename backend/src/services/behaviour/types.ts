export type Severity = "none" | "low" | "medium" | "high" | "critical";

/** A verdict: severity from the model, the rest computed from the event (explain.ts). */
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
  /** true when the model gave no usable severity and the verdict failed open (medium) */
  failedOpen: boolean;
  modelSha256: string | undefined;
}
