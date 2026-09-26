// End-to-end check of OSAVA's classifier path: contract prompt -> llama-server
// -> parse -> guard, over a held-out eval set of contract bodies.
//
//   npm run eval-llama -- <eval_set.jsonl> <out.json> [baseUrl]
//
// Writes {id: {raw, severity, margin, needsReview, guard, failedOpen}} so the
// output can be scored with osava-slm/hallucination_check.py --responses and
// compared against the bf16 and Ollama numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { classify } from "../src/services/behaviour/classifier";

const [evalPath, outPath, base = "http://127.0.0.1:8089"] = process.argv.slice(2);
const rows = readFileSync(evalPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

(async () => {
  const out: Record<string, unknown> = {};
  const t0 = Date.now();
  for (const [i, r] of rows.entries()) {
    const v = await classify(r.event, { baseUrl: base });
    out[r.id] = { raw: v.raw, severity: v.severity, margin: v.margin, classProbs: v.classProbs,
      needsReview: v.needsReview, failedOpen: v.failedOpen, guard: v.guard };
    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${rows.length}  ${((Date.now() - t0) / (i + 1) / 1000).toFixed(2)} s/event`);
  }
  writeFileSync(outPath!, JSON.stringify(out));
  console.log(`done: ${rows.length} events, ${((Date.now() - t0) / rows.length / 1000).toFixed(2)} s/event`);
})().catch((e) => { console.error(e); process.exit(1); });
