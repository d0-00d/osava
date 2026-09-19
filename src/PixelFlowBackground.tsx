import { useEffect, useRef, type CSSProperties } from "react";
import {
  createPixelFlow,
  PIXEL_FLOW_DEFAULTS,
  type PixelFlowHandle,
  type PixelFlowOptions,
} from "./pixelFlow";

export interface PixelFlowBackgroundProps extends Partial<PixelFlowOptions> {
  /**
   * Change this value to play the tab-switch transition. Pass the tab's index
   * (a number) and the sweep follows the direction you moved; a string always
   * sweeps downward.
   */
  burstKey?: string | number;
  /**
   * Receives the engine handle, for calling transition() or kick() directly.
   * Set to null on unmount.
   */
  controlRef?: { current: PixelFlowHandle | null };
  className?: string;
  style?: CSSProperties;
  /** absolute fills the nearest positioned parent (for example .app-bg). */
  position?: "fixed" | "absolute";
}

/**
 * Pixel flow backdrop (dither, rows, or ascii). Decorative only: no pointer
 * capture, hidden from assistive tech. It listens to pointer movement on
 * window for the ripple effect.
 */
export default function PixelFlowBackground({
  burstKey,
  controlRef,
  className,
  style,
  position = "absolute",
  ...options
}: PixelFlowBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<PixelFlowHandle | null>(null);
  const prevKey = useRef<string | number | undefined>(burstKey);

  const o: PixelFlowOptions = { ...PIXEL_FLOW_DEFAULTS, ...stripUndefined(options) };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: PixelFlowHandle | null = null;
    try {
      handle = createPixelFlow(canvas, o);
    } catch (err) {
      console.error(err);
    }
    handleRef.current = handle;
    if (controlRef) controlRef.current = handle;
    return () => {
      handle?.destroy();
      handleRef.current = null;
      if (controlRef) controlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.update(o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    o.mode, o.pixelSize, o.scale, o.speed, o.glitch, o.packets, o.scanlines,
    o.intensity, o.vignette, o.alert, o.interactive, o.transition, o.transitionMs,
    o.accent, o.highlight, o.warn,
    o.background, o.maxDpr, o.fps, o.seed, o.paused,
    o.mask, o.maskAmount, o.maskEaseMs, o.maskSeed, o.maskRect.join(),
  ]);

  useEffect(() => {
    const prev = prevKey.current;
    prevKey.current = burstKey;
    if (prev === burstKey) return;
    const dir = typeof prev === "number" && typeof burstKey === "number" && burstKey < prev ? -1 : 1;
    handleRef.current?.transition(dir);
  }, [burstKey]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        position,
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
        background: o.background,
        ...style,
      }}
    />
  );
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
