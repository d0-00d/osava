// ─────────────────────────────────────────────────────────────
// Classifier contract — generated, not authored here.
//
// contract.json comes from osava-slm/export_contract.py and is derived from
// the same code that built the model's training data. Every conversion rule,
// the prompt string, and the model checksum live there. Do not edit it by
// hand; regenerate it, because a converter or prompt that differs from
// training in any detail feeds the model a distribution it never learned.
//
// Why this file is not called contract.ts: contract.json must keep its name
// (osava-slm documents copying it to exactly that path), and a module that
// shares its basename makes `require("./contract")` resolve to the .json first
// under ts-node, so CONTRACT arrives undefined. tsc, esbuild and pkg all prefer
// the .ts, so type-checking, the bundle and every test pass; only
// `npm run dev` (ts-node-dev) crashes. A unit test now refuses any such pair.
// ─────────────────────────────────────────────────────────────

import contractJson from "./contract.json";

export interface Contract {
  schema_version: string;
  model: { name?: string; gguf_sha256?: string; gguf_bytes?: number; quantisation?: string; url?: string };
  input: {
    field_order: string[];
    max_cmdline: number;
    truncation_marker: string;
    supported_event_ids: number[];
  };
  conversion: {
    event_types: Record<string, string>;
    field_map: Record<string, string>;
    null_values: string[];
    signature_eids: number[];
    signature_backfill: {
      vendor_signers: Record<string, string>;
      microsoft_signer: string;
      system_dirs: string[];
      writable_windows_dirs: string[];
      unsigned_prefixes: string[];
    };
  };
  prompt: { template: string; prefill: string; stop: string[] };
  severity: { scale: string[]; bucket: Record<string, string>; classes: string[] };
  routing: {
    escalate_severities: string[];
    escalate_threat_types: string[];
    confidence_from_severity: Record<string, number>;
  };
  indicators: string[];
  exculpatory_indicators: string[];
  threat_types: string[];
  prompt_sha256: string;
  prompt_variant: string;
  /** held-out events with known answers, run at startup to prove the loaded
   *  model is the one this contract belongs to (see runtime.selfTest) */
  canaries?: { id: string; body: string; expect: string }[];
}

export const CONTRACT = contractJson as unknown as Contract;
