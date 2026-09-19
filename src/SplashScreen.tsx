import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PixelFlowBackground from "./PixelFlowBackground";
import type { PixelFlowHandle } from "./pixelFlow";
import "./splash.css";

/**
 * "pending" is for a subsystem the backend knows about but has not wired up
 * yet (smolLM). It reads as a placeholder: never blocks the launch, never
 * counts as a failure.
 */
type LineType = "log" | "ok" | "warn" | "pending" | "done";

type TerminalLine = {
  text: string;
  type: LineType;
};

const LINE_TYPES: LineType[] = ["log", "ok", "warn", "pending", "done"];

type SplashCompleteData = {
  installStatus: any;
  hasHistory: boolean;
};

type SplashProps = {
  onComplete: (data: SplashCompleteData) => void;
  /** Shown once the wordmark has resolved. */
  tagline?: string;
  /** Bottom-left strip. */
  footer?: string;
  /** Label on the button that hands off to the app. */
  launchLabel?: string;
};

/** Boot stages, in order. Each one unlocks the next piece of the screen. */
type Stage = "dark" | "wordmark" | "tagline" | "booting";

const STAGE_AT: Record<Exclude<Stage, "dark">, number> = {
  wordmark: 420,
  tagline: 1350,
  booting: 1750,
};

const WORDMARK = "OSAVA";
const MASK_FONT = '"Pixelify Sans", "Segoe UI", system-ui, sans-serif';
/** How fast queued log lines are released, in ms per line. */
const LINE_INTERVAL = 45;

export default function SplashScreen({
  onComplete,
  tagline = "Security Suite",
  footer = "OSAVA v1.0.0",
  launchLabel = "Launch",
}: SplashProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [allDone, setAllDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const [stage, setStage] = useState<Stage>("dark");
  const [maskSeed, setMaskSeed] = useState(3);
  const [maskAmount, setMaskAmount] = useState(0);
  const [maskEase, setMaskEase] = useState(1200);
  const [visibleCount, setVisibleCount] = useState(0);
  const [taglineLen, setTaglineLen] = useState(0);

  const flowRef = useRef<PixelFlowHandle | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLButtonElement>(null);

  const mask = useWordmarkMask(WORDMARK);
  const maskRect = useMaskRect(slotRef, stage !== "dark");

  const reduced = usePrefersReducedMotion();
  const lit = stage !== "dark";
  const booting = stage === "booting";

  /* ── Timeline ───────────────────────────────────────────────── */
  useEffect(() => {
    if (reduced) {
      // No staged build-up: show the finished screen straight away.
      setStage("booting");
      setTaglineLen(tagline.length);
      return;
    }
    setStage("wordmark");
    flowRef.current?.transition(1);
    const timers = [
      window.setTimeout(() => setStage("tagline"), STAGE_AT.tagline - STAGE_AT.wordmark),
      window.setTimeout(() => setStage("booting"), STAGE_AT.booting - STAGE_AT.wordmark),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [reduced, tagline.length]);

  // Tagline types out one character at a time.
  useEffect(() => {
    if (stage !== "tagline" && stage !== "booting") return;
    if (taglineLen >= tagline.length) return;
    const id = window.setTimeout(() => setTaglineLen((n) => n + 1), 55);
    return () => window.clearTimeout(id);
  }, [stage, taglineLen, tagline.length]);

  // Log lines are released on a steady beat, so the console always reads as
  // typed even when the backend delivers a burst of lines at once.
  useEffect(() => {
    if (!booting || visibleCount >= lines.length) return;
    const id = window.setTimeout(
      () => setVisibleCount((n) => Math.min(n + 1, lines.length)),
      reduced ? 0 : LINE_INTERVAL,
    );
    return () => window.clearTimeout(id);
  }, [booting, visibleCount, lines.length, reduced]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleCount]);

  /* ── Wordmark reveal ────────────────────────────────────────── */
  useEffect(() => {
    if (!mask || stage === "dark") return;
    setMaskAmount(1);
  }, [mask, stage]);

  // Clicking the wordmark replays the dissolve with a new scatter pattern.
  const replayTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(replayTimer.current), []);

  const replayWordmark = useCallback(() => {
    if (reduced || !mask) return;
    window.clearTimeout(replayTimer.current);
    setMaskEase(240);
    setMaskAmount(0);
    replayTimer.current = window.setTimeout(() => {
      setMaskSeed((n) => (n % 89) + 7);
      setMaskEase(900);
      setMaskAmount(1);
    }, 260);
  }, [reduced, mask]);

  /* ── Backend boot stream (unchanged contract) ───────────────── */
  useEffect(() => {
    // StrictMode double-invokes this effect in dev. Without a cancel flag the
    // first run keeps polling and opens a second EventSource, which is why the
    // boot log used to print every line twice.
    let cancelled = false;
    let eventSource: EventSource | null = null;

    function addLine(text: string, type: LineType) {
      if (cancelled) return;
      setLines((prev) => [...prev, { text, type }]);
    }

    async function waitForBackend() {
      addLine("osava splash // connecting to backend...", "log");
      addLine("", "log");

      let attempts = 0;
      const maxAttempts = 30; // ~15 seconds

      const tryConnect = async (): Promise<boolean> => {
        try {
          const r = await fetch("http://localhost:4000/health", {
            signal: AbortSignal.timeout(2000),
          });
          const d = await r.json();
          return d.status === "ok";
        } catch {
          return false;
        }
      };

      while (attempts < maxAttempts) {
        if (cancelled) return false;
        attempts++;
        const ok = await tryConnect();
        if (cancelled) return false;
        if (ok) {
          addLine(`> Backend reached after ${attempts} attempt(s)`, "ok");
          addLine("", "log");
          return true;
        }
        addLine(`  attempt ${attempts}... waiting`, "log");
        await new Promise((res) => setTimeout(res, 500));
      }

      addLine("> Could not reach backend after 15s", "warn");
      addLine("  Start the backend with: cd backend && npm run dev", "warn");
      if (!cancelled) {
        setFailed(true);
        setAllDone(true);
      }
      return false;
    }

    async function streamBoot() {
      const reached = await waitForBackend();
      if (cancelled || !reached) return;

      addLine("> Streaming backend initialization...", "log");
      addLine("", "log");

      eventSource = new EventSource("http://localhost:4000/api/boot");

      eventSource.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data);
          const type = toLineType(data.type);
          const text = data.text as string;

          addLine(text, type);

          if (type === "done") {
            eventSource?.close();
            setAllDone(true);
          }
        } catch {
          // ignore malformed events
        }
      };

      eventSource.onerror = () => {
        if (cancelled) return;
        eventSource?.close();
        addLine("> Connection to boot stream lost", "warn");
        setFailed(true);
        setAllDone(true);
      };
    }

    streamBoot();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, []);

  const drained = visibleCount >= lines.length;
  const ready = allDone && drained;

  function launch() {
    flowRef.current?.transition(1);
    onComplete({ installStatus: null, hasHistory: false });
  }

  const shown = lines.slice(0, visibleCount);

  return (
    <div className={`splash${lit ? " is-lit" : ""}${booting ? " is-booting" : ""}`}>
      <PixelFlowBackground
        className="splash-flow"
        controlRef={flowRef}
        mode="dither"
        pixelSize={2}
        scale={1.15}
        speed={0.8}
        packets={0.35}
        glitch={0.2}
        intensity={0.6}
        vignette={0.7}
        alert={failed ? 1 : 0}
        mask={mask}
        maskAmount={maskAmount}
        maskEaseMs={maskEase}
        maskRect={maskRect}
        maskSeed={maskSeed}
        seed={5}
      />

      <div className="splash-stage">
        <h1 className="splash-sr-only">{WORDMARK}</h1>

        {/* Reserves the wordmark's space; the shader paints inside it. */}
        <button
          ref={slotRef}
          type="button"
          className="splash-wordmark"
          style={mask ? { aspectRatio: `${mask.width} / ${mask.height}` } : undefined}
          onClick={replayWordmark}
          aria-label="Replay the wordmark animation"
          title="Click to replay"
        />

        <p className="splash-tagline">
          {tagline.slice(0, taglineLen)}
          {taglineLen < tagline.length && <span className="caret">_</span>}
        </p>

        <section className="splash-console" aria-label="Boot log">
          <div className="splash-console-bar">
            <span
              className={`splash-dot${failed ? " is-warn" : ready ? " is-done" : ""}`}
              aria-hidden="true"
            />
            <span>{failed ? "Backend unreachable" : ready ? "Ready" : "Starting services"}</span>
            <span className="spacer">{shown.length.toString().padStart(2, "0")}</span>
          </div>

          <div className="splash-log" ref={logRef} role="log" aria-live="polite">
            {shown.map((line, i) => {
              const isPrompt = line.text.startsWith(">");
              const body = isPrompt ? line.text.slice(1).trimStart() : line.text;
              // Pending subsystems get their own gutter mark so they read as
              // "queued" at a glance, next to the > of a step and the blank
              // gutter of its results.
              const gutter = isPrompt ? ">" : line.type === "pending" ? "~" : " ";
              return (
                <div key={i} className={`splash-line is-${line.type}`}>
                  <span className="gutter" aria-hidden="true">
                    {gutter}
                  </span>
                  <span className="body">{body === "" ? " " : body}</span>
                </div>
              );
            })}
            {!ready && (
              <div className="splash-line">
                <span className="gutter" aria-hidden="true" />
                <span className="splash-caret">_</span>
              </div>
            )}
          </div>
        </section>

        <div className="splash-actions">
          {ready && (
            <button type="button" className="splash-launch" onClick={launch} autoFocus>
              {launchLabel}
            </button>
          )}
        </div>
      </div>

      <div className="splash-footer">{footer}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ hooks */

type Mask = HTMLCanvasElement;

/** Anything the backend sends that we don't style falls back to a plain log line. */
function toLineType(value: unknown): LineType {
  return LINE_TYPES.includes(value as LineType) ? (value as LineType) : "log";
}

/**
 * Draws the wordmark into an offscreen canvas for the shader to carve out of
 * the flow. Waits for the display font so the shape matches the app's type.
 */
function useWordmarkMask(text: string): Mask | null {
  const [mask, setMask] = useState<Mask | null>(null);

  useEffect(() => {
    let cancelled = false;

    function build() {
      if (cancelled) return;
      const size = 220;
      const pad = Math.round(size * 0.18);
      const probe = document.createElement("canvas").getContext("2d");
      if (!probe) return;
      probe.font = `700 ${size}px ${MASK_FONT}`;
      probe.letterSpacing = `${Math.round(size * 0.1)}px`;
      const w = Math.ceil(probe.measureText(text).width) + pad * 2;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, w);
      canvas.height = Math.round(size * 1.16);
      const g = canvas.getContext("2d");
      if (!g) return;
      g.fillStyle = "#000";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#fff";
      g.font = `700 ${size}px ${MASK_FONT}`;
      g.letterSpacing = `${Math.round(size * 0.1)}px`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, canvas.width / 2, canvas.height / 2);
      setMask(canvas);
    }

    // Build once with whatever font is available, then again if the display
    // face arrives later, so the shape is never missing.
    build();
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.load) {
      fonts
        .load(`700 220px ${MASK_FONT}`, text)
        .then(() => fonts.ready)
        .then(build)
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [text]);

  return mask;
}

/**
 * Reports where the reserved element sits, as the shader's maskRect
 * (width fraction of the canvas, then center x and y). Keeps the shader
 * wordmark locked to the CSS layout through resizes.
 */
function useMaskRect(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
): [number, number, number] {
  const [rect, setRect] = useState<[number, number, number]>([0.5, 0.5, 0.34]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const b = el.getBoundingClientRect();
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      if (!b.width || !b.height) return;
      setRect([b.width / vw, (b.left + b.width / 2) / vw, (b.top + b.height / 2) / vh]);
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, active]);

  return rect;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}
