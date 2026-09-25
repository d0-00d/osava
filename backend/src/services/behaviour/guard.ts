// ─────────────────────────────────────────────────────────────
// Output guard — the model proposes, the host verifies.
// Ported from HIRA backend/src/ollama/outputGuard.ts; keep the two in step.
//
// Measured on 138 held-out events (osava-ft/hallucination_check.py), the
// fine-tune never invents a severity and never contradicts its own verdict.
// What it does do:
//
//   * cite only reassuring evidence for an alert — 49 of 73 alerts said, in
//     effect, "signed by Microsoft, runs from System32, therefore malicious".
//     The verdict was usually right; the stated reason was worthless, and an
//     analyst reading it learns to distrust the tool. This was trained in:
//     56% of the training targets pair a threat verdict with only exculpatory
//     indicators.
//   * occasionally reach for an indicator key outside the closed vocabulary
//     (1 in 138 — `remote_command`, for a netcat reverse shell the vocabulary
//     has no key for), or quote evidence that is not in the event (1 in 138).
//
// None of these change the verdict, so none of them are allowed to either.
// The severity passes through untouched; what is removed is explanation the
// event does not support. Everything removed is recorded on `guard` so the
// audit trail shows what the model said, not only what survived.
// ─────────────────────────────────────────────────────────────

import type { Classification } from "./types";
import { CONTRACT } from "./contract";

const INDICATOR_VOCAB = new Set(CONTRACT.indicators);
const EXCULPATORY = new Set(CONTRACT.exculpatory_indicators);
const THREAT_TYPES = new Set(CONTRACT.threat_types);
const bucketOf = (s: string) => CONTRACT.severity.bucket[s] ?? "benign";

export interface GuardReport {
  droppedKeys: string[];
  ungroundedValues: string[];
  threatTypeReset: string | null;
  unsupportedVerdict: boolean;
  originalReasoning?: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is this indicator value actually present in the event?
 *
 * Mirrors osava-ft/hallucination_check.grounded(), which was validated with
 * zero false positives against all 1,993 training targets. Values come in a
 * few derived shapes — a verbatim field, `parent -> child`, `ip:port`, a
 * lowercased directory, text clipped with an ellipsis — and each is checked.
 * `-` is the no-evidence sentinel, not a claim.
 */
export function isGrounded(value: unknown, event: string): boolean {
  let v = String(value).trim();
  if (v === "" || v === "-") return true;
  v = v.replace(/…+$/, "").trimEnd();
  const ev = norm(event);
  const parts = v.includes("->") ? v.split(/\s*->\s*/) : [v];
  return parts.every((raw) => {
    const p = norm(raw);
    if (!p || ev.includes(p)) return true;
    const m = /^(.+):(\d+)$/.exec(p);
    return !!m && ev.includes(m[1]!) && ev.includes(m[2]!);
  });
}

const UNSUPPORTED_NOTE =
  "Flagged by the intake classifier, but no field in this event explains the " +
  "verdict on its own. Review the full event; do not treat the listed " +
  "indicators as the reason for the alert.";

/** Remove explanation the event does not support. Never changes severity. */
export function guardClassification(
  c: Classification,
  event: string
): Classification & { guard: GuardReport } {
  const report: GuardReport = {
    droppedKeys: [],
    ungroundedValues: [],
    threatTypeReset: null,
    unsupportedVerdict: false,
  };

  const indicators: Classification["indicators"] = {};
  for (const [k, v] of Object.entries(c.indicators ?? {})) {
    if (!INDICATOR_VOCAB.has(k)) { report.droppedKeys.push(k); continue; }
    if (!isGrounded(v, event)) { report.ungroundedValues.push(k); continue; }
    indicators[k] = v;
  }

  let threatType = c.threatType;
  if (threatType !== null && !THREAT_TYPES.has(threatType)) {
    report.threatTypeReset = threatType;
    threatType = "unknown";
  }

  let reasoning = c.reasoning;
  const isAlert = ["malicious", "suspicious"].includes(bucketOf(c.severity));
  const incriminating = Object.keys(indicators).some((k) => !EXCULPATORY.has(k));
  if (isAlert && !incriminating) {
    report.unsupportedVerdict = true;
    report.originalReasoning = c.reasoning;
    reasoning = UNSUPPORTED_NOTE;
  }

  const touched =
    report.droppedKeys.length || report.ungroundedValues.length ||
    report.threatTypeReset || report.unsupportedVerdict;
  if (touched) {
    console.warn("[OutputGuard]", JSON.stringify(report));
  }
  return { ...c, indicators, threatType, reasoning, guard: report };
}
