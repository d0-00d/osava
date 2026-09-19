/**
 * pixelWipe.ts
 * Screen handoff curtain for OSAVA, drawn with the same square pixels and
 * Bayer dithering as the flow backdrop. WebGL1, no dependencies.
 *
 * One pass, transparent where the curtain has not reached. A single front
 * travels across the screen twice:
 *   cover   : the curtain dithers in, hiding whatever is underneath
 *   hold    : fully covered, with a couple of torn frames
 *   uncover : the same front continues, dissolving the curtain away
 *
 * The caller owns the clock and calls render(t) with t from 0 to 1, so the
 * content swap can be scheduled against the same timeline.
 */

export type PixelWipeDirection = "down" | "up" | "right" | "left";

export interface PixelWipeOptions {
  /** CSS px per pixel. Match the flow backdrop so the two read as one system. */
  pixelSize: number;
  direction: PixelWipeDirection;
  /** Fraction of the timeline spent covering. */
  coverEnd: number;
  /** Fraction of the timeline at which uncovering starts. */
  uncoverStart: number;
  background: string;
  accent: string;
  highlight: string;
  seed: number;
  maxDpr: number;
}

export const PIXEL_WIPE_DEFAULTS: PixelWipeOptions = {
  pixelSize: 2,
  direction: "down",
  coverEnd: 0.42,
  uncoverStart: 0.58,
  background: "#0a090c",
  accent: "#85d5c6",
  highlight: "#e6e1e1",
  seed: 9,
  maxDpr: 1.5,
};

export interface PixelWipeHandle {
  /** Draw the curtain at timeline position t (0 to 1). */
  render(t: number): void;
  /** Clear to fully transparent. */
  clear(): void;
  destroy(): void;
  readonly supported: boolean;
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uUnit;     // device px per pixel
uniform float uT;        // 0..1 across the whole handoff
uniform float uCover;    // fraction spent covering
uniform float uUncover;  // fraction at which uncovering starts
uniform float uAxis;     // 0 vertical, 1 horizontal
uniform float uFlip;     // 1 reverses the travel direction
uniform float uSeed;
uniform vec3  uBg;
uniform vec3  uAccent;
uniform vec3  uHi;

float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453123); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

float ease(float x) { return x * x * (3.0 - 2.0 * x); }

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 pu = floor(px / uUnit);
  float rows = uRes.y / uUnit;
  float cols = uRes.x / uUnit;

  // Travel axis: how far this pixel is from where the front starts, and the
  // coordinate that runs along the front.
  float span = uAxis > 0.5 ? cols : rows;
  float here = uAxis > 0.5 ? pu.x : (rows - pu.y);   // gl_FragCoord.y is bottom-up
  if (uFlip > 0.5) here = span - here;
  float along = uAxis > 0.5 ? (rows - pu.y) : pu.x;

  float feather = max(16.0, span * 0.20);
  // Overshoot by more than the lane jitter so the last pixel is covered before
  // the caller swaps the content, and reach that point slightly early.
  float travel = span + feather * 2.5;

  float tc = clamp(uT / max(uCover * 0.9, 0.001), 0.0, 1.0);
  float frontC = ease(tc) * travel - feather;

  float tu = clamp((uT - uUncover) / max(1.0 - uUncover, 0.001), 0.0, 1.0);
  float frontU = ease(tu) * travel - feather;

  // The front is not a straight line: each lane leads or trails a little.
  float jit = (hash11(along * 0.37 + uSeed) - 0.5) * feather * 0.5
            + sin(along * 0.055 + uSeed) * feather * 0.16;

  float dc = (frontC + jit) - here;   // > 0 once the cover front has passed
  float du = (frontU + jit) - here;

  float th = bayer8(pu) * 0.82 + hash21(pu + uSeed) * 0.18;
  float cov = step(th, clamp(dc / feather, 0.0, 1.0));
  float unc = step(th, clamp(du / feather, 0.0, 1.0));
  float a = cov * (1.0 - unc);

  // Bright dashes that run ahead of the advancing front.
  float ahead = -dc;
  float laneHot = step(0.90, hash11(along * 3.1 + uSeed + floor(uT * 14.0) * 0.7));
  float dash = step(0.5, fract((uAxis > 0.5 ? pu.y : pu.x) * 0.22 + uT * 26.0));
  float packet = laneHot * dash
               * step(0.0, ahead) * step(ahead, feather * 1.3)
               * step(uT, uCover);

  float alpha = max(a, packet);
  if (alpha < 0.5) discard;
  alpha = 1.0;

  // Colour: dark base, with a teal dither that thickens toward the front and
  // settles out well behind it, so a covered screen is not a flat field of noise.
  float depth = clamp(dc / (span * 0.34), 0.0, 1.0);
  vec3 col = uBg;
  float tex = step(bayer8(pu * 0.5 + 3.0), 0.46 * (1.0 - depth * depth));
  col = mix(col, mix(uBg, uAccent, 0.6), tex);

  // Deep behind the front the curtain keeps a few gaps, so the flow backdrop
  // underneath still shows through rather than the screen going dead.
  float holes = step(bayer8(pu * 0.5 + 21.0), 0.08 * depth) * step(uT, uUncover);
  alpha *= 1.0 - holes;
  if (alpha < 0.5) discard;

  // Leading edge of whichever front is currently moving.
  float edgeC = (1.0 - smoothstep(0.0, 3.0, abs(dc))) * step(uT, uCover);
  float edgeU = (1.0 - smoothstep(0.0, 3.0, abs(du))) * step(uUncover, uT);
  col = mix(col, uHi, max(edgeC, edgeU));
  col = mix(col, uHi, packet * 0.9);

  // Two torn frames while the screen is fully covered, so the swap registers.
  float held = step(uCover, uT) * step(uT, uUncover);
  if (held > 0.5) {
    float fr = floor(uT * 90.0);
    float band = floor(pu.y / floor(mix(3.0, 12.0, hash11(fr + uSeed))));
    float on = step(0.72, hash11(band * 7.13 + fr * 3.7 + uSeed));
    float stripe = step(0.5, fract(pu.y * 0.5)) * (0.55 + 0.45 * step(0.5, fract((pu.x + pu.y) * 0.25)));
    col = mix(col, mix(uAccent, uHi, 0.35) * stripe, on * 0.5);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("pixelWipe: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? "";
    gl.deleteShader(sh);
    throw new Error("pixelWipe: shader compile failed\n" + log);
  }
  return sh;
}

export function createPixelWipe(
  canvas: HTMLCanvasElement,
  initial: Partial<PixelWipeOptions> = {},
): PixelWipeHandle {
  const opts: PixelWipeOptions = { ...PIXEL_WIPE_DEFAULTS, ...initial };

  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) return { render() {}, clear() {}, destroy() {}, supported: false };
  const ctx: WebGLRenderingContext = gl;

  const prog = ctx.createProgram();
  if (!prog) return { render() {}, clear() {}, destroy() {}, supported: false };
  const vs = compile(ctx, ctx.VERTEX_SHADER, VERT);
  const fs = compile(ctx, ctx.FRAGMENT_SHADER, FRAG);
  ctx.attachShader(prog, vs);
  ctx.attachShader(prog, fs);
  ctx.bindAttribLocation(prog, 0, "aPos");
  ctx.linkProgram(prog);
  ctx.deleteShader(vs);
  ctx.deleteShader(fs);
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS) && !ctx.isContextLost()) {
    throw new Error("pixelWipe: link failed\n" + (ctx.getProgramInfoLog(prog) ?? ""));
  }

  const u = (n: string) => ctx.getUniformLocation(prog, n);
  const uRes = u("uRes"), uUnit = u("uUnit"), uT = u("uT");
  const uCover = u("uCover"), uUncover = u("uUncover");
  const uAxis = u("uAxis"), uFlip = u("uFlip"), uSeed = u("uSeed");
  const uBg = u("uBg"), uAccent = u("uAccent"), uHi = u("uHi");

  const quad = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, quad);
  ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
  ctx.enableVertexAttribArray(0);
  ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);

  ctx.disable(ctx.BLEND);
  ctx.clearColor(0, 0, 0, 0);

  let width = 0;
  let height = 0;
  let unit = 1;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, Math.max(0.5, opts.maxDpr));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const px = Math.max(1, Math.round(opts.pixelSize * dpr));
    if (w === width && h === height && px === unit) return;
    width = w;
    height = h;
    unit = px;
    canvas.width = w;
    canvas.height = h;
  }

  const axis = opts.direction === "left" || opts.direction === "right" ? 1 : 0;
  const flip = opts.direction === "up" || opts.direction === "left" ? 1 : 0;

  return {
    supported: true,
    render(t) {
      if (ctx.isContextLost()) return;
      resize();
      ctx.viewport(0, 0, width, height);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
      ctx.useProgram(prog);
      ctx.uniform2f(uRes, width, height);
      ctx.uniform1f(uUnit, unit);
      ctx.uniform1f(uT, Math.min(1, Math.max(0, t)));
      ctx.uniform1f(uCover, opts.coverEnd);
      ctx.uniform1f(uUncover, opts.uncoverStart);
      ctx.uniform1f(uAxis, axis);
      ctx.uniform1f(uFlip, flip);
      ctx.uniform1f(uSeed, opts.seed % 97);
      ctx.uniform3fv(uBg, hexToRgb(opts.background));
      ctx.uniform3fv(uAccent, hexToRgb(opts.accent));
      ctx.uniform3fv(uHi, hexToRgb(opts.highlight));
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    },
    clear() {
      if (ctx.isContextLost()) return;
      resize();
      ctx.viewport(0, 0, width, height);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
    },
    destroy() {
      if (ctx.isContextLost()) return;
      ctx.deleteBuffer(quad);
      ctx.deleteProgram(prog);
    },
  };
}
