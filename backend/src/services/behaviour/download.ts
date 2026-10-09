// ─────────────────────────────────────────────────────────────
// Download a large file so that a bad connection costs seconds, not the file.
//
// The model is 1.9 GB. A download that starts over on every hiccup, shows
// nothing while it runs, and hangs forever on a stalled connection is not
// something to hand to someone on hotel wifi. This one
//
//   * writes to <dest>.part and resumes from it with a Range request, so a
//     dropped connection, a closed laptop or a quit app picks up where it left
//     off (a server that ignores Range just makes it start over);
//   * gives up on an attempt that has produced no bytes for `stallMs`, keeps
//     what it has, and tries again with a growing delay;
//   * counts only failures that made no progress, so a flaky link that keeps
//     moving finishes and a dead one stops after a handful of tries;
//   * checks free space before the first byte, and says so in plain words;
//   * can be cancelled, keeping the partial file.
//
// It does NOT verify what it fetched. The caller checks the hash: a resumed
// file is stitched from several responses, and only the checksum says the
// pieces belong together.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

export type DownloadFailure = "HTTP" | "NETWORK" | "NO_SPACE" | "CANCELLED";

export class DownloadError extends Error {
  constructor(readonly kind: DownloadFailure, message: string, readonly status?: number) {
    super(message);
  }
}

export interface DownloadOptions {
  onProgress?: ((received: number, total: number | null) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** abandon an attempt that has produced no bytes for this long (default 30 s); the partial file is kept */
  stallMs?: number;
  /** consecutive attempts that make no progress before giving up (default 5) */
  attempts?: number;
  /** delay before the first retry, doubling after each (default 1.5 s) */
  retryMs?: number;
  /** free bytes on the drive that will hold `dest`; a seam for tests */
  freeBytes?: (dir: string) => Promise<number>;
  /** space to leave free once the download is done (default 256 MB) */
  reserveBytes?: number;
}

const GB = 1024 ** 3;
const fmt = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.ceil(n / 1024 ** 2)} MB`);

async function sizeOf(p: string): Promise<number> {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Write every byte: FileHandle.write may write less than it was given. */
async function writeAll(fh: fs.FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
}

const retryableStatus = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

const describe = (e: unknown): string => {
  if (e instanceof DownloadError) return e.message;
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "AbortError") return "the connection stalled";
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
};

export async function download(url: string, dest: string, opt: DownloadOptions = {}): Promise<void> {
  const { stallMs = 30_000, attempts = 5, retryMs = 1_500, reserveBytes = 256 * 1024 ** 2 } = opt;
  const freeBytes = opt.freeBytes ?? defaultFreeBytes;
  const part = `${dest}.part`;
  const dir = path.dirname(dest);
  await fs.mkdir(dir, { recursive: true });

  let failures = 0;
  let spaceChecked = false;
  const cancelled = () => new DownloadError("CANCELLED", "The download was cancelled.");

  for (;;) {
    if (opt.signal?.aborted) throw cancelled();
    const have = await sizeOf(part);

    // One controller per attempt: the stall timer and the caller's cancel both abort it.
    const attempt = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => attempt.abort(), stallMs); };
    const cancel = () => attempt.abort();
    opt.signal?.addEventListener("abort", cancel, { once: true });
    let progressed = false;

    try {
      arm();
      const res = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: attempt.signal });

      if (res.status === 416) {
        // Asked for bytes past the end: the partial file is already whole, or it is stale.
        const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]);
        if (have > 0 && total === have) { await fs.rename(part, dest); return; }
        await fs.rm(part, { force: true });
        throw new DownloadError("NETWORK", "the partial download no longer matches the file on the server; starting over");
      }
      if (!res.ok || !res.body) {
        throw new DownloadError("HTTP", `${res.status} ${res.statusText} for ${url}`, res.status);
      }

      // Where does this response begin, and how big is the whole file?
      let start = 0;
      let total: number | null = null;
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
      if (res.status === 206 && range && Number(range[1]) === have) {
        start = have;
        total = range[2] === "*" ? null : Number(range[2]);
      } else {
        // 200: the server ignored Range (or sent the wrong slice). Start over from byte 0.
        if (have > 0) await fs.rm(part, { force: true });
        const len = Number(res.headers.get("content-length"));
        total = Number.isFinite(len) && len > 0 ? len : null;
      }

      if (!spaceChecked && total !== null) {
        spaceChecked = true;
        let free: number | null = null;
        try { free = await freeBytes(dir); } catch { /* cannot tell: do not block on it */ }
        const need = total - start + reserveBytes;
        if (free !== null && free < need) {
          throw new DownloadError("NO_SPACE",
            `Not enough free disk space: this needs about ${fmt(need)} more and the drive has ${fmt(free)} free.`);
        }
      }

      const fh = await fs.open(part, start === 0 ? "w" : "a");
      let received = start;
      // Read by hand and race every read against the abort signal. Relying on the
      // stream to error when the fetch is aborted is not enough: if the abort
      // lands while the loop body (not a pending read) is running, the next read
      // can simply never settle, and a download that cannot be cancelled or
      // timed out is the one failure this module exists to prevent.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const aborted = new Promise<never>((_, reject) => {
        const fire = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (attempt.signal.aborted) fire();
        else attempt.signal.addEventListener("abort", fire, { once: true });
      });
      aborted.catch(() => { /* only awaited through the race below */ });
      try {
        for (;;) {
          const r = await Promise.race([reader.read(), aborted]);
          if (r.done) break;
          arm();
          await writeAll(fh, r.value);
          received += r.value.length;
          progressed = true;
          opt.onProgress?.(received, total);
        }
      } finally {
        void reader.cancel().catch(() => { /* release the connection; never wait on it */ });
        await fh.close();
      }
      if (total !== null && received !== total) {
        throw new DownloadError("NETWORK", `the connection closed after ${fmt(received)} of ${fmt(total)}`);
      }
      await fs.rename(part, dest);
      return;
    } catch (e) {
      if (opt.signal?.aborted) throw cancelled();
      if (e instanceof DownloadError && e.kind === "NO_SPACE") throw e;
      if (e instanceof DownloadError && e.kind === "HTTP" && !retryableStatus(e.status ?? 0)) throw e;
      // A stall, a reset, a DNS failure, a truncated body, a 5xx: all worth another go.
      failures = progressed ? 1 : failures + 1;
      if (failures >= attempts) {
        throw new DownloadError("NETWORK",
          `${describe(e)}. Gave up after ${attempts} tries; what was downloaded is kept and will resume.`);
      }
      await sleep(retryMs * 2 ** (failures - 1), opt.signal);
    } finally {
      clearTimeout(timer);
      opt.signal?.removeEventListener("abort", cancel);
    }
  }
}
