// Parity test: OSAVA's host-side explanation (explain.ts) against the Python
// that built the training targets (osava-slm targets.py).
//
//   python3 parity/make_explain_fixture.py --out /tmp/explain.json [--real /tmp/fixture.json]
//   npm run parity-explain -- /tmp/explain.json
//
// Every case must match byte for byte, indicator order included. With --real
// the fixture holds real telemetry; keep it out of the repo.
import { readFileSync } from "node:fs";
import { explain, type Cls } from "../src/services/behaviour/explain";
import { parseBody } from "../src/services/behaviour/signature";

type Case = { body: string; cls: Cls; isThreat: boolean; threatType: string | null;
  indicators: [string, string][]; reasoning: string };
const cases: Case[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));

let ok = 0;
const fields = { isThreat: 0, threatType: 0, indicators: 0, reasoning: 0 };
const bad: string[] = [];
for (const c of cases) {
  const e = explain(parseBody(c.body), c.cls);
  const diffs: string[] = [];
  if (e.isThreat !== c.isThreat) { fields.isThreat++; diffs.push(`isThreat ${c.isThreat} / ${e.isThreat}`); }
  if (e.threatType !== c.threatType) { fields.threatType++; diffs.push(`threatType ${c.threatType} / ${e.threatType}`); }
  const ti = JSON.stringify(Object.entries(e.indicators));
  if (ti !== JSON.stringify(c.indicators)) {
    fields.indicators++;
    diffs.push(`indicators\n    py: ${JSON.stringify(c.indicators)}\n    ts: ${ti}`);
  }
  if (e.reasoning !== c.reasoning) {
    fields.reasoning++;
    diffs.push(`reasoning\n    py: ${c.reasoning}\n    ts: ${e.reasoning}`);
  }
  if (diffs.length === 0) ok++;
  else if (bad.length < 8) bad.push(`[${c.cls}] ${c.body.slice(0, 160).replace(/\n/g, " | ")}\n  ${diffs.join("\n  ")}`);
}
console.log(`cases ${cases.length}: identical ${ok}`);
console.log(`  mismatches by field: ${JSON.stringify(fields)}`);
bad.forEach((b) => console.log("\n" + b));
process.exit(ok === cases.length ? 0 : 1);
