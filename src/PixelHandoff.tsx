import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createPixelWipe,
  PIXEL_WIPE_DEFAULTS,
  type PixelWipeDirection,
  type PixelWipeHandle,
} from "./pixelWipe";

export interface PixelHandoffProps {
  /** Flip to true to play the handoff. */
  active: boolean;
  /** Shown until the curtain has covered the screen. */
  firstContent: ReactNode;
  /** Shown from the moment the curtain covers the screen. */
  secondContent: ReactNode;
  /** Fires once the curtain has fully lifted. */
  onComplete?: () => void;
  /** Fires at the swap, while the screen is covered. */
  onCover?: () => void;
  /** Whole handoff, in ms. */
  durationMs?: number;
  /** CSS px per pixel. Match the flow backdrop. */
  pixelSize?: number;
  direction?: PixelWipeDirection;
  background?: string;
  accent?: string;
  highlight?: string;
  seed?: number;
  maxDpr?: number;
}

/**
 * Swaps one screen for another behind a dithered pixel curtain, in the same
 * visual language as the flow backdrop. Drop-in replacement for a grid-based
 * pixel transition.
 *
 * The curtain is an overlay: whatever sits behind both screens (a persistent
 * backdrop canvas, say) is never unmounted, so it does not restart mid-handoff.
 */
export default function PixelHandoff({
  active,
  firstContent,
  secondContent,
  onComplete,
  onCover,
  durationMs = 1000,
  pixelSize = 2,
  direction = "down",
  background = PIXEL_WIPE_DEFAULTS.background,
  accent = PIXEL_WIPE_DEFAULTS.accent,
  highlight = PIXEL_WIPE_DEFAULTS.highlight,
  seed = PIXEL_WIPE_DEFAULTS.seed,
  maxDpr = PIXEL_WIPE_DEFAULTS.maxDpr,
}: PixelHandoffProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wipeRef = useRef<PixelWipeHandle | null>(null);
  const rafRef = useRef(0);

  // Callbacks are read through a ref so the animation effect depends only on
  // `active` and never restarts because a parent re-rendered.
  const cbRef = useRef({ onComplete, onCover });
  cbRef.current = { onComplete, onCover };

  const [swapped, setSwapped] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: PixelWipeHandle | null = null;
    try {
      handle = createPixelWipe(canvas, {
        pixelSize, direction, background, accent, highlight, seed, maxDpr,
      });
    } catch (err) {
      console.error(err);
    }
    wipeRef.current = handle;
    return () => {
      handle?.destroy();
      wipeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;

    const wipe = wipeRef.current;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // No curtain available, or motion is turned down: swap and be done.
    if (!wipe || !wipe.supported || reduced) {
      setSwapped(true);
      cbRef.current.onCover?.();
      cbRef.current.onComplete?.();
      return;
    }

    setRunning(true);
    const start = performance.now();
    let covered = false;

    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / Math.max(1, durationMs));
      wipe.render(t);

      if (!covered && t >= PIXEL_WIPE_DEFAULTS.coverEnd) {
        covered = true;
        setSwapped(true);
        cbRef.current.onCover?.();
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      rafRef.current = 0;
      wipe.clear();
      setRunning(false);
      cbRef.current.onComplete?.();
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [active, durationMs]);

  return (
    <>
      {swapped ? secondContent : firstContent}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          display: running ? "block" : "none",
          pointerEvents: "none",
          zIndex: 999,
          background: "transparent",
        }}
      />
    </>
  );
}
