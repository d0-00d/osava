// ─────────────────────────────────────────────────────────────
// Classify one contract body with the local model (llama-server).
//
// Why llama-server's raw /completion endpoint and not a chat endpoint:
//   * the prompt is the EXACT string the model was trained on, taken from
//     contract.json. A chat endpoint re-renders it through the GGUF's own
//     template, which injects a date header and /think mode -- the train/serve
//     mismatch that already shipped once through Ollama.
//   * the severity prefix is prefilled, so the first generated token IS the
//     severity, and asking for its top probabilities gives the R7 routing
//     margin. Ollama never exposed that.
// ─────────────────────────────────────────────────────────────

import { CONTRACT } from "./contract";
import { guardClassification } from "./guard";
import type { Classification, Severity, Verdict } from "./types";

/** Below this, the model's top two classes are too close to act on alone. */
export const REVIEW_MARGIN = 0.2;

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

function extractJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(a, b + 1));
}

function parse(text: string): Classification {
  const o = extractJson(text) as Record<string, unknown>;
  const severity = o["severity"];
  if (typeof severity !== "string" || !SCALE.has(severity)) throw new Error(`bad severity ${String(severity)}`);
  const ind = o["indicators"];
  return {
    severity: severity as Severity,
    isThreat: typeof o["isThreat"] === "boolean" ? (o["isThreat"] as boolean)
      : CONTRACT.severity.bucket[severity] !== "benign",
    threatType: typeof o["threatType"] === "string" ? (o["threatType"] as string) : null,
    indicators: ind && typeof ind === "object" && !Array.isArray(ind)
      ? (ind as Classification["indicators"]) : {},
    reasoning: typeof o["reasoning"] === "string" ? (o["reasoning"] as string) : "",
  };
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
      n_predict: 320,
      temperature: 0,          // greedy: the same event always gets the same verdict
      repeat_penalty: 1.0,
      stop: CONTRACT.prompt.stop,
      n_probs: 10,
      cache_prompt: true,      // the ~316-token system prompt is shared by every call
    }),
    signal: AbortSignal.timeout(opt.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`llama-server ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { content?: string; completion_probabilities?: TokenProbs[] };

  const raw = CONTRACT.prompt.prefill + (out.content ?? "");
  const severityProbs = severityDistribution(out.completion_probabilities?.[0]);
  const classProbs = toClassProbs(severityProbs);
  const ranked = Object.values(classProbs).sort((a, b) => b - a);
  const margin = (ranked[0] ?? 0) - (ranked[1] ?? 0);

  let failedOpen = false;
  let parsed: Classification;
  try {
    parsed = parse(raw);
  } catch {
    // Fail OPEN: unparseable output is escalated, never read as "clean". One
    // held-out event in 138 -- malicious -- produced malformed JSON.
    failedOpen = true;
    parsed = {
      severity: "medium", isThreat: true, threatType: "unknown",
      indicators: {}, reasoning: "The classifier's response could not be read; flagged for review.",
    };
  }
  const guarded = failedOpen
    ? { ...parsed, guard: { droppedKeys: [], ungroundedValues: [], threatTypeReset: null, unsupportedVerdict: false } }
    : guardClassification(parsed as any, body);
  const bucket = CONTRACT.severity.bucket[guarded.severity] ?? "benign";

  return {
    ...(guarded as Classification & { guard: Verdict["guard"] }),
    severityProbs, classProbs, margin,
    needsReview: failedOpen || bucket !== "benign" || margin < REVIEW_MARGIN,
    failedOpen,
    modelSha256: CONTRACT.model.gguf_sha256,
    raw,
  };
}
