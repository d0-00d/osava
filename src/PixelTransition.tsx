import { useRef, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { gsap } from "gsap";
import "./PixelTransition.css";

type PixelTransitionProps = {
  /** Shown first. Stays up until the pixel grid has fully covered the screen. */
  firstContent: ReactNode;
  /** Revealed as the pixel grid dissolves away. */
  secondContent: ReactNode;
  /** Flip to true to play the transition. Ignored once it has started. */
  active: boolean;
  /** Fires after the grid has fully dissolved and secondContent is exposed. */
  onComplete?: () => void;
  gridSize?: number;
  pixelColor?: string;
  /** Duration of ONE leg (cover, then uncover). Total runtime is 2x this + hold. */
  animationStepDuration?: number;
  /**
   * Seconds the screen stays fully covered between the two legs. The content
   * swap happens in the middle of this window, so every cell is guaranteed to
   * be covered before the swap — no cells popping straight from first to
   * second content.
   */
  holdDuration?: number;
};

/**
 * Fullscreen two-leg GSAP transition: pixels stagger in to cover the screen,
 * the content swaps under them, then pixels stagger out to reveal it. Driven
 * by the `active` prop and reports back via `onComplete` so the caller can
 * unmount it.
 */
export default function PixelTransition({
  firstContent,
  secondContent,
  active,
  onComplete,
  gridSize = 24,
  pixelColor = "#0c0c0e",
  animationStepDuration = 0.5,
  holdDuration = 0.12,
}: PixelTransitionProps) {
  const pixelGridRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const hasPlayedRef = useRef(false);

  const [showSecond, setShowSecond] = useState(false);

  // Build the grid. Pixels are sized in % so the grid tracks the viewport
  // without needing a resize listener.
  useEffect(() => {
    const pixelGridEl = pixelGridRef.current;
    if (!pixelGridEl) return;

    pixelGridEl.innerHTML = "";

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const pixel = document.createElement("div");
        pixel.classList.add("pixel-transition__pixel");
        pixel.style.backgroundColor = pixelColor;

        const size = 100 / gridSize;
        pixel.style.width = `${size}%`;
        pixel.style.height = `${size}%`;
        pixel.style.left = `${col * size}%`;
        pixel.style.top = `${row * size}%`;
        pixelGridEl.appendChild(pixel);
      }
    }
  }, [gridSize, pixelColor]);

  useEffect(() => {
    if (!active || hasPlayedRef.current) return;

    const pixelGridEl = pixelGridRef.current;
    if (!pixelGridEl) return;

    const pixels = pixelGridEl.querySelectorAll<HTMLDivElement>(
      ".pixel-transition__pixel"
    );
    if (!pixels.length) return;

    hasPlayedRef.current = true;

    const staggerDuration = animationStepDuration / pixels.length;
    const uncoverAt = animationStepDuration + holdDuration;
    const tl = gsap.timeline();

    gsap.set(pixels, { display: "none" });

    // Leg 1 — cover. Pixels stagger in while the first content fades out
    // underneath them, so it dissolves away rather than getting chopped into
    // same-colour blocks.
    tl.to(
      pixels,
      {
        display: "block",
        duration: 0,
        stagger: { each: staggerDuration, from: "random" },
      },
      0
    );
    if (firstRef.current) {
      tl.to(
        firstRef.current,
        { opacity: 0, duration: animationStepDuration, ease: "power2.in" },
        0
      );
    }

    // Fully covered for `holdDuration`; swap the content in the middle of the
    // hold so every cell is guaranteed dark before and after the swap.
    tl.call(
      () => setShowSecond(true),
      undefined,
      animationStepDuration + holdDuration / 2
    );

    // Leg 2 — uncover, revealing the second content.
    tl.to(
      pixels,
      {
        display: "none",
        duration: 0,
        stagger: { each: staggerDuration, from: "random" },
      },
      uncoverAt
    );

    tl.call(() => onComplete?.(), undefined, uncoverAt + animationStepDuration);

    return () => {
      tl.kill();
    };
    // onComplete is intentionally not a dep: the timeline should not be
    // rebuilt if the parent hands us a new closure mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, animationStepDuration, holdDuration]);

  return (
    <div className="pixel-transition">
      <div
        className="pixel-transition__layer"
        ref={firstRef}
        aria-hidden={showSecond}
      >
        {firstContent}
      </div>
      <div
        className="pixel-transition__layer pixel-transition__layer--second"
        ref={secondRef}
        aria-hidden={!showSecond}
        style={{ display: showSecond ? "block" : "none" }}
      >
        {secondContent}
      </div>
      <div className="pixel-transition__pixels" ref={pixelGridRef} />
    </div>
  );
}
