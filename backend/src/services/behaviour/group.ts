// ─────────────────────────────────────────────────────────────
// Bursts: many behaviours that are one thing a person did.
//
// A behaviour's signature includes the file or registry path it wrote, and it
// has to: if every file written into one folder were one behaviour, a payload
// dropped beside harmless files would count as already known and never be
// judged. So each file stays its own behaviour and is judged on its own. But one
// app update unpacking its runtime wrote 2,078 files on the development PC, and
// the Behaviour tab listed 2,078 rows. This groups them for display only: the
// writes of one program under one folder (or registry key) become one row that
// says how many there are and how they were judged, worst first.
// ─────────────────────────────────────────────────────────────

import { basename, dirname, normalise, parseBody } from "./signature";

/** Fewer writes than this under one place are listed one by one. */
export const MIN_GROUP = 3;
/** How deep a path is cut to name the place: c:\program files (x86)\microsoft\edgecore, <profile>\.cache\x\y. */
const DEPTH = 4;

export interface Groupable {
  signature: string;
  sample: string;
  severity: string;
  needsReview: boolean;
  firstSeen: string;
  lastSeen: string;
  expected?: unknown;
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/** Worst first: what needs review, then severity, then the most recent. */
export const byConcern = (a: Groupable, b: Groupable): number =>
  Number(b.needsReview) - Number(a.needsReview) ||
  (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) ||
  b.lastSeen.localeCompare(a.lastSeen);

/**
 * The place a file or registry write went, cut to DEPTH levels, normalised like a signature (profile, GUIDs,
 * versions). A registry write under a Classes root is cut at the root, because each file type an installer
 * registers is its own key there. Null for anything that is not a file or registry write.
 */
export function placeOf(sample: string): { what: "file" | "registry"; key: string; image: string; place: string } | null {
  const f = parseBody(sample);
  const eid = f["EventID"];
  if (eid !== "11" && eid !== "12" && eid !== "13") return null;
  const parts = normalise(f["TargetFilename"]).split("\\").filter(Boolean).slice(0, -1);   // drop the file / value name
  if (!parts.length) return null;
  let depth = DEPTH;
  if (eid !== "11") {
    const classes = parts.findIndex((p, i) => p.endsWith("_classes") || (p === "classes" && parts[i - 1] === "software"));
    if (classes >= 0) depth = Math.min(depth, classes + 1);
  }
  const place = parts.slice(0, depth).join("\\");
  const what = eid === "11" ? "file" : "registry";
  return { what, key: [what, basename(f["Image"]), dirname(f["Image"]), place].join("|"), image: f["Image"] ?? "", place };
}

export interface Group<T extends Groupable> {
  kind: "group";
  key: string;
  what: "file" | "registry";
  /** the writing program, as the newest member names it */
  image: string;
  /** where, normalised: `<profile>\.cache\codex-runtimes\...` */
  place: string;
  count: number;
  bySeverity: Record<string, number>;
  needsReview: number;
  expected: number;
  firstSeen: string;
  lastSeen: string;
  /** the member that matters most, which is what the row shows */
  top: T;
}

export type Item<T extends Groupable> = (T & { kind: "behaviour" }) | Group<T>;

/**
 * One row per behaviour, except writes by one program under one place, MIN_GROUP or more of them. Groups are
 * formed from everything in `list`; `show` says which behaviours the view wants (Needs review, say). A group is
 * shown when any member is, so "2 of 1,038 need review" keeps its context instead of becoming two loose rows.
 */
export function groupBursts<T extends Groupable>(list: T[], show: (v: T) => boolean = () => true): Item<T>[] {
  const buckets = new Map<string, T[]>();
  const single: T[] = [];
  for (const v of list) {
    const p = placeOf(v.sample);
    if (!p) { single.push(v); continue; }
    const b = buckets.get(p.key);
    if (b) b.push(v); else buckets.set(p.key, [v]);
  }
  const items: Item<T>[] = single.filter(show).map((v) => ({ ...v, kind: "behaviour" as const }));
  for (const [key, members] of buckets) {
    if (members.length < MIN_GROUP) {
      for (const v of members) if (show(v)) items.push({ ...v, kind: "behaviour" as const });
      continue;
    }
    if (!members.some(show)) continue;
    members.sort(byConcern);
    const top = members[0]!;
    const bySeverity: Record<string, number> = {};
    for (const m of members) bySeverity[m.severity] = (bySeverity[m.severity] ?? 0) + 1;
    const place = placeOf(top.sample)!;
    items.push({
      kind: "group", key, what: place.what, image: place.image, place: place.place, count: members.length, bySeverity,
      needsReview: members.filter((m) => m.needsReview).length,
      expected: members.filter((m) => m.expected).length,
      firstSeen: members.reduce((a, m) => (m.firstSeen < a ? m.firstSeen : a), top.firstSeen),
      lastSeen: members.reduce((a, m) => (m.lastSeen > a ? m.lastSeen : a), top.lastSeen),
      top,
    });
  }
  // a group sorts where its most concerning member would
  return items.sort((a, b) => byConcern(a.kind === "group" ? a.top : a, b.kind === "group" ? b.top : b));
}

/** The members of one group, worst first. */
export function membersOf<T extends Groupable>(list: T[], key: string): T[] {
  return list.filter((v) => placeOf(v.sample)?.key === key).sort(byConcern);
}
