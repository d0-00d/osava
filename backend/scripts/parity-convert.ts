// Parity test: OSAVA's event -> contract conversion and behaviour signature
// against the Python that built the training data.
//
//   python3 parity/make_fixture.py --out /tmp/fixture.json   (in osava-slm)
//   npm run parity -- /tmp/fixture.json
//
// Every record must match byte for byte. The fixture holds real telemetry and
// lives outside the repo; never commit it.
import { readFileSync } from "node:fs";
import { parseRecord, render } from "../src/services/behaviour/convert";
import { parseBody, signature } from "../src/services/behaviour/signature";

type Case = { eid: number; data: Record<string, string | null>; body: string | null; signature: string | null };
const cases: Case[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));

let body = 0, sig = 0, rejectAgree = 0;
const bad: string[] = [];
for (const c of cases) {
  const f = parseRecord({ eid: c.eid, data: c.data });
  const ts = f ? render(f) : null;
  if (ts === c.body) {
    body++;
    if (ts === null) { rejectAgree++; sig++; continue; }
    const s = signature(parseBody(ts));
    if (s === c.signature) sig++;
    else if (bad.length < 6) bad.push(`SIGNATURE eid=${c.eid}\n  py: ${c.signature}\n  ts: ${s}`);
  } else if (bad.length < 6) {
    bad.push(`BODY eid=${c.eid}\n  py: ${JSON.stringify(c.body)?.slice(0, 300)}\n  ts: ${JSON.stringify(ts)?.slice(0, 300)}`);
  }
}
console.log(`records ${cases.length}`);
console.log(`  body identical      ${body}/${cases.length}   (rejections agreed: ${rejectAgree})`);
console.log(`  signature identical ${sig}/${cases.length}`);
bad.forEach((b) => console.log("\n" + b));
process.exit(body === cases.length && sig === cases.length ? 0 : 1);
