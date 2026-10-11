// One verdict per behaviour signature, persisted under ~/.osava like the rest
// of OSAVA's state. The bookmark is the last event-log RecordId processed.

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Verdict } from "./types";

// OSAVA_STATE_FILE exists so tests and screenshots never touch the real state.
const FILE = process.env["OSAVA_STATE_FILE"] ?? path.join(os.homedir(), ".osava", "behaviour.json");

/** A person looked at a verdict and said the behaviour is normal on this PC. */
export interface Expected {
  at: string;
  /** the model whose verdict they accepted: a different model's verdict is new, and is looked at again */
  modelSha256: string;
  /** what that model said, kept so the row can say what was accepted */
  severity: string;
}

export interface BehaviourRecord extends Verdict {
  signature: string;
  /** the event the model judged for this behaviour, exactly as it saw it */
  sample: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  expected?: Expected;
}

/**
 * Marked as expected, by a person, for the verdict it carries now. The verdict itself is unchanged -- a High stays
 * High -- it only stops asking for review.
 */
export const isExpected = (v: BehaviourRecord): boolean =>
  !!v.expected && v.expected.modelSha256 === (v.modelSha256 ?? "");

export interface BehaviourState {
  /** last Sysmon RecordId processed */
  bookmark: number;
  /**
   * Last Security-log RecordId processed. Kept apart from `bookmark` because RecordIds are numbered per
   * channel: sharing one would skip or re-read events. Optional so a state file written before logons
   * were read still loads.
   */
  securityBookmark?: number;
  /** keyed by behaviour signature */
  verdicts: Record<string, BehaviourRecord>;
  /** events skipped because the model was not trained on their EventID */
  outOfDomain: number;
}

export async function readState(): Promise<BehaviourState> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf-8"));
  } catch {
    return { bookmark: 0, verdicts: {}, outOfDomain: 0 };
  }
}

export async function writeState(s: BehaviourState): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s), "utf-8");
  await fs.rename(tmp, FILE);   // atomic: a crash mid-write never leaves a torn file
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` once every earlier call has finished. Whatever reads the state, changes it and writes it back goes
 * through here, so a scan (which holds the state for as long as the model takes) and a person marking a verdict
 * never write over each other's change.
 */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = tail.then(fn, fn);
  tail = p.catch(() => undefined);
  return p;
}

const setExpected = (v: BehaviourRecord, on: boolean, at: string) => {
  if (on) v.expected = { at, modelSha256: v.modelSha256 ?? "", severity: v.severity };
  else delete v.expected;
};

/** Marks (or unmarks) one behaviour as expected. Null when there is no such behaviour. */
export function markExpected(signature: string, on: boolean): Promise<BehaviourRecord | null> {
  return exclusive(async () => {
    const st = await readState();
    const v = st.verdicts[signature];
    if (!v) return null;
    setExpected(v, on, new Date().toISOString());
    await writeState(st);
    return v;
  });
}

/** The same for every behaviour `pick` selects, in one write. Returns how many it changed. */
export function markExpectedWhere(pick: (v: BehaviourRecord) => boolean, on: boolean): Promise<number> {
  return exclusive(async () => {
    const st = await readState();
    const at = new Date().toISOString();
    const hit = Object.values(st.verdicts).filter(pick);
    for (const v of hit) setExpected(v, on, at);
    if (hit.length) await writeState(st);
    return hit.length;
  });
}
