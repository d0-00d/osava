// ─────────────────────────────────────────────────────────────
// Classify one contract body with the local model (llama-server).
//
// The model decides ONE thing: severity. It is read from the probabilities of
// the first token after the prefilled `{"severity": "` -- a single forward
// pass, nothing generated. Everything else in the verdict (indicators,
// threatType, reasoning) is a function of the event and the severity class,
// which is exactly what the model was trained to imitate, so explain.ts
// computes it instead. Generating it took ~300 tokens per event and was where
// the model hallucinated.
//
// Why llama-server's raw /completion endpoint and not a chat endpoint: the
// prompt is the EXACT string the model was trained on, taken from
// contract.json. A chat endpoint re-renders it through the GGUF's own
// template, which injects a date header and /think mode -- the train/serve
// mismatch that already shipped once through Ollama.
// ─────────────────────────────────────────────────────────────

import { CONTRACT } from "./contract";
import { explain, type Cls } from "./explain";
import { parseBody } from "./signature";
import type { Severity, Verdict } from "./types";

/** Below this, the model's top two classes are too close to act on alone. */
export const REVIEW_MARGIN = 0.2;

/** Why a verdict is put in front of a person; null = it is not. */
export type ReviewReason = "no_answer" | "not_benign" | "close_call" | null;

/**
 * The one definition of "needs review", in order of how much it should worry
 * you: the model gave nothing usable (failed open), the verdict is not benign,
 * or it is benign but the top two classes are within REVIEW_MARGIN.
 */
export function reviewReason(v: { failedOpen: boolean; severity: string; margin: number }): ReviewReason {
  if (v.failedOpen) return "no_answer";
  if ((CONTRACT.severity.bucket[v.severity] ?? "suspicious") !== "benign") return "not_benign";
  return v.margin < REVIEW_MARGIN ? "close_call" : null;
}

export interface ClassifierOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

const SCALE = new Set(CONTRACT.severity.scale.concat(["critical"]));

function buildPrompt(body: string): string {
  // A FUNCTION replacement, deliberately. With a string replacement, JS reads
  // $&, $`, $' and $$ in the event as substitution patterns -- and PowerShell
  // command lines are full of `$`. The event would be silently rewritten.
  return CONTRACT.prompt.template.replace("{body}", () => body) + CONTRACT.prompt.prefill;
}

type TopLogprob = { token?: string; tok_str?: string; logprob?: number; prob?: number };
type TokenProbs = { top_logprobs?: TopLogprob[]; probs?: TopLogprob[] };

/** P(severity) from the first generated token's alternatives. */
function severityDistribution(first: TokenProbs | undefined): Record<string, number> {
  const alts = first?.top_logprobs ?? first?.probs ?? [];
  const raw: Record<string, number> = {};
  for (const a of alts) {
    const tok = (a.token ?? a.tok_str ?? "").trim();
    if (!SCALE.has(tok)) continue;
    const p = a.logprob !== undefined ? Math.exp(a.logprob) : (a.prob ?? 0);
    raw[tok] = (raw[tok] ?? 0) + p;
  }
  const z = Object.values(raw).reduce((s, v) => s + v, 0);
  const out: Record<string, number> = {};
  for (const s of CONTRACT.severity.scale) out[s] = z > 0 ? (raw[s] ?? 0) / z : 0;
  return out;
}

function toClassProbs(sev: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(CONTRACT.severity.classes.map((c) => [c, 0]));
  for (const [s, p] of Object.entries(sev)) {
    const c = CONTRACT.severity.bucket[s];
    if (c) out[c] = (out[c] ?? 0) + p;
  }
  return out;
}

export async function classify(body: string, opt: ClassifierOptions): Promise<Verdict & { raw: string }> {
  const res = await fetch(`${opt.baseUrl}/completion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opt.apiKey ? { Authorization: `Bearer ${opt.apiKey}` } : {}),
    },
    body: JSON.stringify({
      prompt: buildPrompt(body),
      n_predict: 1,            // the severity token; nothing else is generated
      temperature: 0,          // greedy: the same event always gets the same verdict
      n_probs: 10,
      cache_prompt: true,      // the ~316-token system prompt is shared by every call
    }),
    signal: AbortSignal.timeout(opt.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`llama-server ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { content?: string; completion_probabilities?: TokenProbs[] };

  const raw = (out.content ?? "").trim();
  const severityProbs = severityDistribution(out.completion_probabilities?.[0]);
  const classProbs = toClassProbs(severityProbs);
  const ranked = Object.values(classProbs).sort((a, b) => b - a);
  const margin = (ranked[0] ?? 0) - (ranked[1] ?? 0);

  // The generated token is the argmax over the whole vocabulary. If it is not
  // a severity, fall back to the most likely severity among the alternatives;
  // if there is none, fail OPEN: escalate, never read silence as "clean".
  const top = Object.entries(severityProbs).sort((a, b) => b[1] - a[1])[0];
  const failedOpen = !SCALE.has(raw) && !(top && top[1] > 0);
  const severity = (failedOpen ? "medium" : SCALE.has(raw) ? raw : top![0]) as Severity;
  const cls = (CONTRACT.severity.bucket[severity] ?? "suspicious") as Cls;

  return {
    severity,
    ...explain(parseBody(body), cls),
    severityProbs, classProbs, margin,
    needsReview: reviewReason({ failedOpen, severity, margin }) !== null,
    failedOpen,
    modelSha256: CONTRACT.model.gguf_sha256,
    raw,
  };
}
