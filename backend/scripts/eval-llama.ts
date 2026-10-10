// End-to-end check of OSAVA's classifier path over a held-out eval set of
// contract bodies: start llama-server the way OSAVA does (model checksum,
// canaries), read severity, compute the explanation, time every event.
//
//   npm run eval-llama -- <eval_set.jsonl> <out.json>
//
// Writes {id: {raw, severity, margin, classProbs, needsReview, failedOpen, ms}}.
// `raw` is the full verdict as JSON, so the output can be scored with
// osava-slm/hallucination_check.py --responses like any model's.
import { readFileSync, writeFileSync } from "node:fs";
import { classify } from "../src/services/behaviour/classifier";
import { baseUrl, currentApiKey, startServer, stopServer } from "../src/services/behaviour/runtime";

const [evalPath, outPath] = process.argv.slice(2);
const rows = readFileSync(evalPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

(async () => {
  const t0 = Date.now();
  await startServer();
  console.log(`server up and canaries passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const out: Record<string, unknown> = {};
  const ms: number[] = [];
  try {
    for (const [i, r] of rows.entries()) {
      const t = Date.now();
      const v = await classify(r.event, { baseUrl: baseUrl(), apiKey: currentApiKey() });
      ms.push(Date.now() - t);
      const { severity, isThreat, threatType, indicators, reasoning } = v;
      out[r.id] = { raw: JSON.stringify({ severity, isThreat, threatType, indicators, reasoning }),
        severity, margin: v.margin, classProbs: v.classProbs, needsReview: v.needsReview,
        failedOpen: v.failedOpen, ms: ms[ms.length - 1] };
      if ((i + 1) % 20 === 0) console.log(`${i + 1}/${rows.length}`);
    }
  } finally {
    stopServer();
  }
  writeFileSync(outPath!, JSON.stringify(out));
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  console.log(`done: ${rows.length} events  mean ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0)} ms`
    + `  p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${s[s.length - 1]} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
