// One verdict per behaviour signature, persisted under ~/.osava like the rest
// of OSAVA's state. The bookmark is the last event-log RecordId processed.

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Verdict } from "./types";

// OSAVA_STATE_FILE exists so tests and screenshots never touch the real state.
const FILE = process.env["OSAVA_STATE_FILE"] ?? path.join(os.homedir(), ".osava", "behaviour.json");

export interface BehaviourRecord extends Verdict {
  signature: string;
  /** the event the model judged for this behaviour, exactly as it saw it */
  sample: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

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
