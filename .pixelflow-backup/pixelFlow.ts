/**
 * pixelFlow.ts
 * Calm flowing backdrop for OSAVA, drawn with solid pixels. WebGL1, no dependencies.
 *
 * Modes (all driven by one smooth, domain-warped field):
 *   dither : Bayer-dithered fluid bands, solid pixels, optional scanline rows
 *   rows   : horizontal pixel rows bent by a height field, dithered along each row
 *   ascii  : character ramp " .:-=+*%#@" on a text grid
 *
 * Accents, kept quiet on purpose:
 *   packets : short bright runs travelling along a row (hex scramble in ascii)
 *   slips   : now and then a thin strip of rows shifts sideways for a moment
 *
 * Tab switch transition (call transition()):
 *   tear  : a few choppy frames of torn rows, two-tone split, striped blocks
 *   sweep : a pixel scan line crosses the screen and refreshes what it passes
 *
 * Mask (for a splash wordmark): pass a canvas whose bright areas are the shape.
 * Raising maskAmount dissolves the shape in, pixel by pixel, out of the flow.
 *
 * Pass 1 renders the field into a small texture. Pass 2 draws the pixels.
 */

export type PixelFlowMode = "dither" | "rows" | "ascii";
export type PixelFlowTransition = "both" | "tear" | "sweep" | "none";
export type PixelFlowMaskSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

export interface PixelFlowOptions {
  mode: PixelFlowMode;
  /** CSS px per pixel. In ascii mode one character is 7 x 10 pixels. */
  pixelSize: number;
  /** Zoom of the flow pattern. Higher is larger shapes. */
  scale: number;
  /** Flow speed. 0 freezes the field. */
  speed: number;
  /** How often row slips happen, 0 to 1. */
  glitch: number;
  /** How many rows carry data packets, 0 to 1. */
  packets: number;
  /** Darkens every other pixel row in dither mode, 0 to 1. */
  scanlines: number;
  /** Overall brightness. */
  intensity: number;
  /** Darkens the middle of the screen so content stays readable, 0 to 1. */
  vignette: number;
  /** 0 is normal, 1 shifts to the warning color. Eased. */
  alert: number;
  /** Ripple the field around the pointer. */
  interactive: boolean;
  /** What plays when transition() is called, for example on a tab switch. */
  transition: PixelFlowTransition;
  /** Length of the transition in ms. */
  transitionMs: number;
  /**
   * Shape to carve out of the flow, as a canvas or image whose red channel is
   * the shape (white = inside). Null clears it. Used for the splash wordmark.
   */
  mask: PixelFlowMaskSource | null;
  /** How far the mask is revealed, 0 to 1. Animated over maskEaseMs. */
  maskAmount: number;
  /** Time the reveal takes, in ms. */
  maskEaseMs: number;
  /** Where the mask sits: width as a fraction of the canvas, then center x, y. */
  maskRect: [number, number, number];
  /** Changes the dissolve pattern without changing the shape. */
  maskSeed: number;
  accent: string;
  highlight: string;
  warn: string;
  background: string;
  maxDpr: number;
  fps: number;
  seed: number;
  paused: boolean;
}

export const PIXEL_FLOW_DEFAULTS: PixelFlowOptions = {
  mode: "dither",
  pixelSize: 2,
  scale: 1,
  speed: 1,
  glitch: 0.25,
  packets: 0.3,
  scanlines: 0.35,
  intensity: 0.75,
  vignette: 0.55,
  alert: 0,
  interactive: true,
  transition: "both",
  transitionMs: 650,
  mask: null,
  maskAmount: 0,
  maskEaseMs: 1100,
  maskRect: [0.52, 0.5, 0.34],
  maskSeed: 3,
  accent: "#85d5c6",
  highlight: "#e6e1e1",
  warn: "#fb923c",
  background: "#0a090c",
  maxDpr: 1.5,
  fps: 30,
  seed: 5,
  paused: false,
};

export interface PixelFlowHandle {
  update(next: Partial<PixelFlowOptions>): void;
  /** Fire a short burst of row slips. strength 0 to 1. */
  kick(strength?: number): void;
  /**
   * Play the tab-switch transition. direction 1 sweeps downward (moving to a
   * later tab), -1 sweeps upward. Skipped when reduced motion is on.
   */
  transition(direction?: number): void;
  /** True once the mask reveal has finished animating. */
  maskSettled(): boolean;
  render(): void;
  destroy(): void;
  readonly supported: boolean;
}

const MODE_INDEX: Record<PixelFlowMode, number> = { dither: 0, rows: 1, ascii: 2 };

/* 5x7 glyphs, rows top to bottom. Index 0-9 is the brightness ramp, 10-25 is hex. */
const GLYPHS: string[][] = [
  ["00000", "00000", "00000", "00000", "00000", "00000", "00000"], // space
  ["00000", "00000", "00000", "00000", "00000", "01100", "01100"], // .
  ["00000", "01100", "01100", "00000", "01100", "01100", "00000"], // :
  ["00000", "00000", "00000", "11111", "00000", "00000", "00000"], // -
  ["00000", "00000", "11111", "00000", "11111", "00000", "00000"], // =
  ["00000", "00100", "00100", "11111", "00100", "00100", "00000"], // +
  ["00000", "10101", "01110", "11111", "01110", "10101", "00000"], // *
  ["11001", "11010", "00010", "00100", "01000", "01011", "10011"], // %
  ["01010", "01010", "11111", "01010", "11111", "01010", "01010"], // #
  ["01110", "10001", "10111", "10101", "10111", "10000", "01111"], // @
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], // 0
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"], // 1
  ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], // 2
  ["11110", "00001", "00001", "01110", "00001", "00001", "11110"], // 3
  ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], // 4
  ["11111", "10000", "11110", "00001", "00001", "10001", "01110"], // 5
  ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], // 6
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"], // 7
  ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], // 8
  ["01110", "10001", "10001", "01111", "00001", "00010", "01100"], // 9
  ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], // A
  ["11110", "10001", "10001", "11110", "10001", "10001", "11110"], // B
  ["01110", "10001", "10000", "10000", "10000", "10001", "01110"], // C
  ["11100", "10010", "10001", "10001", "10001", "10010", "11100"], // D
  ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], // E
  ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], // F
];
const GLYPH_COUNT = GLYPHS.length;
const ATLAS_W = GLYPH_COUNT * 5;
const ATLAS_H = 7;

function buildAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H);
  GLYPHS.forEach((rows, g) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < 5; x++) {
        if (row[x] === "1") data[y * ATLAS_W + g * 5 + x] = 255;
      }
    });
  });
  return data;
}

/* ------------------------------------------------------------------ shaders */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Simplex noise 3D: Ashima Arts / Stefan Gustavson, MIT license.
const NOISE = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const HASH = `
float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453123); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

const FIELD_FRAG = `
precision highp float;
uniform vec2  uTexelCss;  // CSS px covered by one field texel (x, y)
uniform float uScale;
uniform float uTime;
uniform float uMode;
uniform float uSeed;
uniform vec3  uMouse;     // world coords, z = presence
${NOISE}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * snoise(p);
    p = p * 2.03 + vec3(17.0, 9.0, 3.0);
    a *= 0.5;
  }
  return s;
}

vec2 world(vec2 texel) { return texel * uTexelCss / (640.0 * uScale); }

// Large, slow, domain-warped flow. Kept to single-octave warps so shapes stay broad.
float flow(vec2 p, float t, vec3 s, out vec2 r) {
  vec2 p2 = p * 0.6;
  vec2 q = vec2(snoise(vec3(p2, t * 0.03) + s),
                snoise(vec3(p2 + vec2(5.2, 1.3), t * 0.03) + s));
  r = vec2(snoise(vec3(p2 + 1.2 * q + vec2(1.7, 9.2), t * 0.04) + s),
           snoise(vec3(p2 + 1.2 * q + vec2(8.3, 2.8), t * 0.04) + s));
  return 0.88 * snoise(vec3(p2 + 1.4 * r, t * 0.025) + s)
       + 0.12 * snoise(vec3(p2 * 2.0 + r, t * 0.04) + s);
}

float heightField(vec2 p, float t, vec3 s) {
  vec2 q = vec2(snoise(vec3(p * 0.8, t * 0.05) + s), snoise(vec3(p * 0.8 + 3.1, t * 0.05) + s));
  return fbm(vec3((p + 0.3 * q) * vec2(1.1, 1.9), t * 0.07) + s);
}

void main() {
  vec2 p = world(gl_FragCoord.xy);
  float t = uTime;
  vec3 s = vec3(uSeed * 3.7, uSeed * 1.3, 0.0);
  vec2 dm = (p - uMouse.xy) * uScale;
  float bump = uMouse.z * exp(-dot(dm, dm) / 0.018);

  if (uMode < 0.5) {
    vec2 r;
    float f = flow(p, t, s, r) + 0.45 * bump;
    float mass = smoothstep(0.15, 0.7, f) * (0.72 + 0.28 * smoothstep(0.65, 0.95, f));
    float c = abs(fract(f * 2.6 - t * 0.03) - 0.5);
    float edge = smoothstep(-0.4, -0.05, f) * (1.0 - smoothstep(0.1, 0.2, f));
    float line = (1.0 - smoothstep(0.03, 0.07, c)) * edge;
    gl_FragColor = vec4(max(mass, line * 0.9), 0.0, 0.0, 1.0);
  } else if (uMode < 1.5) {
    float h0 = heightField(p, t, s);
    float h = h0 + 0.6 * bump;
    float e = uTexelCss.x / (640.0 * uScale);
    float hx = heightField(p + vec2(e, 0.0), t, s) - h0;
    float hy = heightField(p + vec2(0.0, e), t, s) - h0;
    vec3 n = normalize(vec3(-hx / e * 0.10, -hy / e * 0.10, 1.0));
    float shade = clamp(dot(n, normalize(vec3(-0.55, 0.45, 0.70))), 0.0, 1.0);
    shade = smoothstep(0.35, 1.0, shade);
    shade = max(shade, bump * 0.6);
    gl_FragColor = vec4(clamp(h * 0.55 + 0.5, 0.0, 1.0), shade, 0.0, 1.0);
  } else {
    vec2 r;
    float f = flow(p, t, s, r);
    float v = 0.5 + 0.5 * sin(f * 2.8 + p.x * 1.3 + p.y * 0.4 - t * 0.08);
    v = v * v * (3.0 - 2.0 * v) + 0.5 * bump;
    gl_FragColor = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
}
`;

const PIXEL_FRAG = `
precision highp float;
uniform sampler2D uField;
uniform sampler2D uAtlas;
uniform vec2  uRes;
uniform vec2  uGrid;      // field texels
uniform vec2  uDiv;       // pixels per field texel
uniform float uUnit;      // device px per pixel
uniform float uMode;
uniform float uClock;
uniform float uSeed;
uniform float uGlitch;
uniform float uKick;
uniform float uPackets;
uniform float uScanlines;
uniform float uIntensity;
uniform float uVignette;
uniform float uAlert;
uniform vec3  uBg;
uniform vec3  uAccent;
uniform vec3  uHi;
uniform vec3  uWarn;
uniform float uSwitch;      // transition strength, 0 when idle
uniform float uSwitchT;     // transition progress 0..1
uniform float uSwitchDir;   // 1 sweeps down, -1 sweeps up
uniform float uSwitchSeed;
uniform float uTransTears;  // 1 enables tear frames
uniform float uTransSweep;  // 1 enables the scan sweep
uniform sampler2D uMask;
uniform float uMaskOn;      // 1 when a mask texture is bound
uniform float uMaskAmount;  // reveal progress 0..1
uniform vec4  uMaskRect;    // width fraction, aspect, center x, center y (from top)
uniform float uMaskSeed;
${HASH}

vec3  gAccent;
float gSlot;
float gBurst;
float gSlipChance;
float gSlipSign;

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

float glyph(float id, vec2 g) {
  vec2 uv = vec2((id * 5.0 + g.x + 0.5) / ${ATLAS_W.toFixed(1)}, (g.y + 0.5) / ${ATLAS_H.toFixed(1)});
  return step(0.5, texture2D(uAtlas, uv).r);
}

vec2 fieldUv(vec2 pu) { return (pu + 0.5) / (uGrid * uDiv); }

// Is this lane carrying a packet right now, and where is the packet's head?
// Returns distance behind the head in lane units (negative or > len means outside).
float packet(float lane, float span, float len, float unitsPerSec) {
  float epoch = floor(uClock * 0.12 + hash11(lane * 1.9 + uSeed) * 6.0);
  float on = step(1.0 - uPackets * 0.35, hash11(lane * 0.73 + epoch * 1.31 + uSeed));
  float spd = unitsPerSec * mix(0.6, 1.4, hash11(lane * 2.3 + uSeed));
  float head = mod(uClock * spd + hash11(lane * 5.1) * 997.0, span + len * 2.0) - len;
  return on > 0.5 ? head : -1e4;
}

// Distance (in pixel rows) behind the transition sweep. Positive means already swept.
float sweepDist(float rowTop) {
  float e = 1.0 - pow(1.0 - uSwitchT, 3.0);
  float total = uRes.y / uUnit;
  float pos = (uSwitchDir > 0.0 ? e : 1.0 - e) * (total + 40.0) - 20.0;
  return (pos - rowTop) * uSwitchDir;
}

vec3 renderAscii(vec2 pu) {
  vec2 CELL = vec2(7.0, 10.0);
  vec2 cell = floor(pu / CELL);
  float slip = gBurst * step(1.0 - gSlipChance, hash11(cell.y * 7.13 + gSlot * 3.7 + uSeed));
  float sh = slip * gSlipSign * (1.0 + floor(hash11(cell.y + gSlot * 1.9) * 2.0 + uKick * 2.0));
  vec2 c = cell + vec2(sh, 0.0);
  vec2 l = pu - cell * CELL;
  float v = texture2D(uField, (c + 0.5) / uGrid).r;

  float len = 9.0;
  float d = packet(cell.y, uGrid.x, len, 14.0) - c.x;
  float inPk = step(0.0, d) * step(d, len);
  float pk = inPk * (1.0 - d / len);
  float isHead = inPk * step(d, 0.99);

  // Rows the transition sweep just passed flicker through hex before settling.
  float swept = 0.0;
  if (uTransSweep > 0.5 && uSwitch > 0.001) {
    float sd = sweepDist(uRes.y / uUnit - (cell.y + 0.5) * CELL.y);
    swept = step(0.0, sd) * (1.0 - smoothstep(10.0, 40.0, sd));
  }

  float id = floor(mix(0.6, 9.999, clamp(v, 0.0, 1.0)));
  if (inPk > 0.5 || swept > 0.5) id = 10.0 + min(15.0, floor(hash21(c + floor(uClock * 16.0)) * 16.0));

  float gx = l.x - 1.0;
  float gy = CELL.y - 2.0 - l.y;
  float bit = 0.0;
  if (gx >= 0.0 && gx <= 4.0 && gy >= 0.0 && gy <= 6.0) bit = glyph(id, vec2(gx, gy));

  vec3 cc = mix(gAccent * 0.55, gAccent, smoothstep(0.15, 0.6, v));
  cc = mix(cc, uHi, smoothstep(0.85, 1.0, v));
  cc = mix(cc, uHi, max(pk * 0.55, isHead));
  cc = mix(cc, uHi, max(slip * 0.45, swept * 0.5));
  return cc * bit * max(max(mix(0.4, 1.0, v), pk), swept * 0.9);
}

vec3 renderRows(vec2 pu) {
  float pitch = 4.0;
  vec4 s0 = texture2D(uField, fieldUv(pu));
  float y0 = pu.y + floor((s0.r - 0.5) * pitch * 7.0 + 0.5);
  float row0 = floor(y0 / pitch);
  float slip = gBurst * step(1.0 - gSlipChance, hash11(row0 * 7.13 + gSlot * 3.7 + uSeed));
  float sh = slip * gSlipSign * (3.0 + floor(hash11(row0 + gSlot * 1.9) * 6.0)) * (1.0 + 2.0 * uKick);
  vec2 q = pu + vec2(sh, 0.0);

  vec4 s = slip > 0.5 ? texture2D(uField, fieldUv(q)) : s0;
  float y = q.y + floor((s.r - 0.5) * pitch * 7.0 + 0.5);
  float row = floor(y / pitch);
  float lit = step(mod(y, pitch), 0.5);
  float shade = s.g;
  float th = bayer4(vec2(q.x, row * 3.0));
  float on = lit * step(th + 0.03, shade);
  float hot = step(0.8 + th * 0.18, shade);

  float len = 36.0;
  float d = packet(row, uRes.x / uUnit, len, 90.0) - q.x;
  float pk = lit * step(0.0, d) * step(d, len) * (1.0 - d / len);

  vec3 cc = mix(gAccent, uHi, hot);
  cc = mix(cc, uHi, slip * 0.5);
  vec3 col = cc * on * mix(0.55, 1.0, shade);
  return max(col, uHi * step(0.25, pk) * pk * lit);
}

vec3 renderDither(vec2 pu) {
  float stripH = floor(mix(2.0, 8.0, hash11(gSlot * 2.11 + 0.3)));
  float strip = floor(pu.y / stripH);
  float slip = gBurst * step(1.0 - gSlipChance, hash11(strip * 7.13 + gSlot * 3.7 + uSeed));
  float sh = slip * gSlipSign * (3.0 + floor(hash11(strip + gSlot * 1.9) * 8.0)) * (1.0 + 2.0 * uKick);
  vec2 q = pu + vec2(sh, 0.0);

  float v = texture2D(uField, fieldUv(q)).r;
  float th = bayer8(q);
  float on = step(th + 0.01, v);
  float hot = step(0.8 + th * 0.18, v);
  vec3 cc = mix(gAccent, uHi, hot);
  cc = mix(cc, uHi, slip * 0.5);
  float scan = 1.0 - uScanlines * step(0.5, mod(pu.y, 2.0));
  vec3 col = cc * on * scan;

  float laneH = 18.0;
  float lane = floor(pu.y / laneH);
  float laneRow = step(mod(pu.y, laneH), 0.5);
  float len = 40.0;
  float d = packet(lane, uRes.x / uUnit, len, 110.0) - pu.x;
  float pk = laneRow * step(0.0, d) * step(d, len) * (1.0 - d / len);
  float dash = step(0.5, mod(pu.x, 3.0));
  return max(col, uHi * pk * dash);
}

// Mask lookup in screen space. Returns 0 outside the mask rectangle.
float maskAt(vec2 muv) {
  float inBox = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
  return inBox * texture2D(uMask, vec2(muv.x, 1.0 - muv.y)).r;
}

vec3 renderMode(vec2 pu) {
  if (uMode > 1.5) return renderAscii(pu);
  if (uMode > 0.5) return renderRows(pu);
  return renderDither(pu);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 pu = floor(px / uUnit);

  gAccent = mix(uAccent, uWarn, uAlert);
  gSlot = floor(uClock * 3.0);
  gBurst = max(step(1.0 - uGlitch * 0.25 - uAlert * 0.08, hash11(gSlot * 1.37 + uSeed + 0.5)),
               step(0.001, uKick));
  gSlipChance = 0.05 + 0.3 * uKick;
  gSlipSign = hash11(gSlot * 4.7 + uSeed) < 0.5 ? -1.0 : 1.0;

  vec3 col;
  float tp = uSwitchT;
  float tearEnv = uTransTears * uSwitch * (1.0 - smoothstep(0.3, 0.6, tp));

  if (tearEnv > 0.001) {
    // Tab switch, part 1: a few choppy frames of torn rows with a two-tone split.
    float ts = floor(tp * 12.0);
    float ss = uSwitchSeed;
    float bandH = floor(mix(2.0, 14.0, hash11(ts * 2.11 + ss)));
    float band = floor(pu.y / bandH);
    float on = step(1.0 - 0.6 * tearEnv, hash11(band * 7.13 + ts * 3.7 + ss));
    float shift = floor((hash11(band * 3.31 + ts * 1.9 + ss) - 0.5) * 80.0 * tearEnv);
    vec2 q = pu + vec2(shift * on, 0.0);
    col = renderMode(q);
    if (on > 0.5) {
      float split = 1.0 + floor(hash11(band + ts * 5.1 + ss) * 3.0);
      float ll = dot(renderMode(q + vec2(split, 0.0)), vec3(0.3333));
      float lr = dot(renderMode(q - vec2(split, 0.0)), vec3(0.3333));
      vec3 ghost = mix(uWarn, uAccent, uAlert);
      col = col * 0.7 + ghost * ll * 0.9 + uHi * lr * 0.35 + gAccent * 0.04;
    }
    vec2 bs = vec2(floor(mix(8.0, 40.0, hash11(ts * 0.73 + ss))), floor(mix(3.0, 10.0, hash11(ts * 1.91 + ss))));
    vec2 blk = floor(pu / bs);
    float corrupt = step(1.0 - 0.045 * tearEnv, hash21(blk + ts * 0.37 + ss));
    float stripe = step(0.5, fract(pu.y * 0.5)) * (0.55 + 0.45 * step(0.5, fract((pu.x + pu.y) * 0.25)));
    col = mix(col, mix(gAccent, uHi, 0.3) * stripe * 0.9, corrupt);
  } else {
    col = renderMode(pu);
  }

  if (uTransSweep > 0.5 && uSwitch > 0.001) {
    // Tab switch, part 2: a pixel scan line crosses the screen, refreshing what it passes.
    float d = sweepDist(floor((uRes.y - px.y) / uUnit));
    float fade = 1.0 - smoothstep(0.8, 1.0, tp);
    float line = step(0.0, d) * step(d, 1.5);
    float trail = step(0.0, d) * (1.0 - clamp(d / 36.0, 0.0, 1.0));
    float dots = step(bayer8(pu), trail * 0.55);
    col *= 1.0 + 0.35 * trail * fade;
    col = max(col, uHi * max(line, dots * 0.55 * trail) * fade);
  }

  vec2 uv = px / uRes;
  float r = length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
  float outer = 1.0 - 0.5 * smoothstep(0.45, 1.05, r);
  float center = mix(1.0, 0.5 + 0.5 * smoothstep(0.0, 0.6, r), uVignette);
  col *= uIntensity * outer * center;

  if (uMaskOn > 0.5 && uMaskAmount > 0.001) {
    // Splash wordmark: an outlined shape whose interior is filled with the
    // same dithered pixels as the flow behind it, dissolving in left to right.
    float w = uRes.x * uMaskRect.x;
    float h = w / max(uMaskRect.y, 0.001);
    vec2 c = vec2(uRes.x * uMaskRect.z, uRes.y * (1.0 - uMaskRect.w));
    vec2 muv = (px - c) / vec2(w, h) + 0.5;

    // Everything outside the wordmark's box only dims, so skip the sampling.
    float near = step(-0.03, muv.x) * step(muv.x, 1.03)
               * step(-0.03, muv.y) * step(muv.y, 1.03);
    col *= 1.0 - 0.5 * uMaskAmount;
    if (near > 0.5) {

    float m = maskAt(muv);
    float solid = step(0.5, m);

    // One pixel out in each direction: if any neighbour is outside, this is the rim.
    vec2 o = vec2(uUnit / w, uUnit / h);
    float nb = min(min(maskAt(muv + vec2(o.x, 0.0)), maskAt(muv - vec2(o.x, 0.0))),
                   min(maskAt(muv + vec2(0.0, o.y)), maskAt(muv - vec2(0.0, o.y))));
    float rim = solid * (1.0 - step(0.5, nb));

    // Interior fill density follows the flow, so the letters carry its texture.
    float body = clamp(dot(col, vec3(0.34)) * 3.2 + 0.22, 0.0, 1.0);
    float fill = solid * step(bayer8(pu), 0.38 + 0.62 * body);
    float shape = max(rim, fill);

    // Reveal wipes left to right, scattered by a per-pixel hash so it granulates.
    float a = uMaskAmount;
    float wipe = clamp(a * 2.1 - muv.x * 0.85 - 0.12, 0.0, 1.0);
    wipe = wipe * wipe * (3.0 - 2.0 * wipe);
    float grain = hash21(pu * 1.31 + uMaskSeed * 7.0);
    float lit = shape * step(grain, wipe);

    vec3 inside = mix(gAccent, uHi, max(smoothstep(0.45, 1.0, body) * 0.55, rim * 0.7));

    // The advancing front burns brighter for a moment.
    float front = lit * (1.0 - smoothstep(0.0, 0.3, wipe - grain)) * (1.0 - a * 0.5);
    inside += uHi * front * 0.9;

    // The dim above already applied; undo it inside the letters.
    col = mix(col, inside, lit);
    }
  }

  gl_FragColor = vec4(min(uBg + col, vec3(1.0)), 1.0);
}
`;

/* ------------------------------------------------------------------ helpers */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Program { prog: WebGLProgram; u: Uniforms; }

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("pixelFlow: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? "";
    gl.deleteShader(sh);
    throw new Error("pixelFlow: shader compile failed\n" + log);
  }
  return sh;
}

function link(gl: WebGLRenderingContext, frag: string, names: string[]): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error("pixelFlow: createProgram failed");
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error("pixelFlow: link failed\n" + (gl.getProgramInfoLog(prog) ?? ""));
  }
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return { prog, u };
}

const TIME_WRAP = 1800; // keeps noise and hash inputs precise; a kick hides the seam
const CLOCK_WRAP = 3600;

/* ------------------------------------------------------------------ engine */

export function createPixelFlow(
  canvas: HTMLCanvasElement,
  initial: Partial<PixelFlowOptions> = {},
): PixelFlowHandle {
  let opts: PixelFlowOptions = { ...PIXEL_FLOW_DEFAULTS, ...initial };

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });

  if (!gl) {
    canvas.style.background = opts.background;
    return {
      update() {}, kick() {}, transition() {}, maskSettled: () => true,
      render() {}, destroy() {}, supported: false,
    };
  }
  const ctx: WebGLRenderingContext = gl;

  const reduceMotion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  let fieldProg: Program | null = null;
  let pixelProg: Program | null = null;
  let quad: WebGLBuffer | null = null;
  let fieldTex: WebGLTexture | null = null;
  let maskTex: WebGLTexture | null = null;
  let atlasTex: WebGLTexture | null = null;
  let fbo: WebGLFramebuffer | null = null;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let unit = 1;
  let divX = 3;
  let divY = 3;
  let cols = 1;
  let rows = 1;

  let simTime = 30 + (opts.seed % 23);
  let clock = 0;
  let alertNow = opts.alert;
  let kickNow = 0;
  let switchT = 1; // 1 means idle
  let switchDir = 1;
  let switchSeed = 0;
  let maskNow = opts.maskAmount;
  let maskSource: PixelFlowMaskSource | null = null;
  let maskAspect = 1;

  let pointerX = -1e4;
  let pointerY = -1e4;
  let lastPointer = -1e9;
  let presence = 0;

  let lastTick = 0;
  let lastDraw = 0;
  let raf = 0;
  let lost = false;
  let destroyed = false;

  function setup(): void {
    fieldProg = link(ctx, FIELD_FRAG, ["uTexelCss", "uScale", "uTime", "uMode", "uSeed", "uMouse"]);
    pixelProg = link(ctx, PIXEL_FRAG, [
      "uField", "uAtlas", "uRes", "uGrid", "uDiv", "uUnit", "uMode", "uClock", "uSeed",
      "uGlitch", "uKick", "uPackets", "uScanlines", "uIntensity", "uVignette", "uAlert",
      "uBg", "uAccent", "uHi", "uWarn",
      "uSwitch", "uSwitchT", "uSwitchDir", "uSwitchSeed", "uTransTears", "uTransSweep",
      "uMask", "uMaskOn", "uMaskAmount", "uMaskRect", "uMaskSeed",
    ]);

    quad = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, quad);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);

    const makeTex = (filter: number): WebGLTexture | null => {
      const t = ctx.createTexture();
      ctx.bindTexture(ctx.TEXTURE_2D, t);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, filter);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, filter);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
      return t;
    };

    fieldTex = makeTex(ctx.LINEAR);
    maskTex = makeTex(ctx.LINEAR);
    atlasTex = makeTex(ctx.NEAREST);
    ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 1);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE, ATLAS_W, ATLAS_H, 0, ctx.LUMINANCE, ctx.UNSIGNED_BYTE, buildAtlas());

    fbo = ctx.createFramebuffer();
    width = 0;
    resize();
    uploadMask();
  }

  /** Re-uploads the mask image. Safe to call with the same source. */
  function uploadMask(): void {
    const src = opts.mask;
    if (!src || lost || !maskTex) {
      maskSource = null;
      return;
    }
    const w = "naturalWidth" in src ? src.naturalWidth : src.width;
    const h = "naturalHeight" in src ? src.naturalHeight : src.height;
    if (!w || !h) {
      maskSource = null;
      return;
    }
    maskAspect = w / h;
    maskSource = src;
    ctx.bindTexture(ctx.TEXTURE_2D, maskTex);
    ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, src);
    } catch (err) {
      console.error("pixelFlow: mask upload failed", err);
      maskSource = null;
    }
  }

  function resize(): void {
    dpr = Math.min(window.devicePixelRatio || 1, Math.max(0.5, opts.maxDpr));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const u = Math.max(1, Math.round(opts.pixelSize * dpr));
    const [dx, dy] = opts.mode === "ascii" ? [7, 10] : opts.mode === "rows" ? [2, 2] : [3, 3];
    const c = Math.ceil(Math.ceil(w / u) / dx);
    const r = Math.ceil(Math.ceil(h / u) / dy);
    if (w === width && h === height && u === unit && c === cols && r === rows && dx === divX && dy === divY) return;

    width = w;
    height = h;
    unit = u;
    divX = dx;
    divY = dy;
    cols = c;
    rows = r;
    canvas.width = w;
    canvas.height = h;

    ctx.bindTexture(ctx.TEXTURE_2D, fieldTex);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, cols, rows, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, null);
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, fbo);
    ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, fieldTex, 0);
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
  }

  function motionAllowed(): boolean {
    return !(reduceMotion?.matches ?? false);
  }

  function draw(): void {
    if (lost || !fieldProg || !pixelProg) return;
    resize();

    const mode = MODE_INDEX[opts.mode] ?? 0;
    const moving = motionAllowed();
    const scale = Math.max(0.1, opts.scale);
    const worldPerCss = 1 / (640 * scale);
    const cssH = height / dpr;

    ctx.bindFramebuffer(ctx.FRAMEBUFFER, fbo);
    ctx.viewport(0, 0, cols, rows);
    ctx.useProgram(fieldProg.prog);
    ctx.uniform2f(fieldProg.u.uTexelCss, (divX * unit) / dpr, (divY * unit) / dpr);
    ctx.uniform1f(fieldProg.u.uScale, scale);
    ctx.uniform1f(fieldProg.u.uTime, simTime);
    ctx.uniform1f(fieldProg.u.uMode, mode);
    ctx.uniform1f(fieldProg.u.uSeed, opts.seed % 97);
    ctx.uniform3f(
      fieldProg.u.uMouse,
      pointerX * worldPerCss,
      (cssH - pointerY) * worldPerCss,
      opts.interactive && moving ? presence : 0,
    );
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);

    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
    ctx.viewport(0, 0, width, height);
    ctx.useProgram(pixelProg.prog);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, fieldTex);
    ctx.uniform1i(pixelProg.u.uField, 0);
    ctx.activeTexture(ctx.TEXTURE1);
    ctx.bindTexture(ctx.TEXTURE_2D, atlasTex);
    ctx.uniform1i(pixelProg.u.uAtlas, 1);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.uniform2f(pixelProg.u.uRes, width, height);
    ctx.uniform2f(pixelProg.u.uGrid, cols, rows);
    ctx.uniform2f(pixelProg.u.uDiv, divX, divY);
    ctx.uniform1f(pixelProg.u.uUnit, unit);
    ctx.uniform1f(pixelProg.u.uMode, mode);
    ctx.uniform1f(pixelProg.u.uClock, clock);
    ctx.uniform1f(pixelProg.u.uSeed, opts.seed % 97);
    ctx.uniform1f(pixelProg.u.uGlitch, moving ? opts.glitch : 0);
    ctx.uniform1f(pixelProg.u.uKick, moving ? kickNow : 0);
    ctx.uniform1f(pixelProg.u.uPackets, moving ? opts.packets : 0);
    ctx.uniform1f(pixelProg.u.uScanlines, opts.scanlines);
    ctx.uniform1f(pixelProg.u.uIntensity, opts.intensity);
    ctx.uniform1f(pixelProg.u.uVignette, opts.vignette);
    ctx.uniform1f(pixelProg.u.uAlert, alertNow);
    ctx.uniform3fv(pixelProg.u.uBg, hexToRgb(opts.background));
    ctx.uniform3fv(pixelProg.u.uAccent, hexToRgb(opts.accent));
    ctx.uniform3fv(pixelProg.u.uHi, hexToRgb(opts.highlight));
    ctx.uniform3fv(pixelProg.u.uWarn, hexToRgb(opts.warn));
    const active = moving && switchT < 1;
    ctx.uniform1f(pixelProg.u.uSwitch, active ? Math.pow(1 - switchT, 0.6) : 0);
    ctx.uniform1f(pixelProg.u.uSwitchT, switchT);
    ctx.uniform1f(pixelProg.u.uSwitchDir, switchDir);
    ctx.uniform1f(pixelProg.u.uSwitchSeed, switchSeed);
    ctx.uniform1f(pixelProg.u.uTransTears, opts.transition === "both" || opts.transition === "tear" ? 1 : 0);
    ctx.uniform1f(pixelProg.u.uTransSweep, opts.transition === "both" || opts.transition === "sweep" ? 1 : 0);
    ctx.activeTexture(ctx.TEXTURE2);
    ctx.bindTexture(ctx.TEXTURE_2D, maskTex);
    ctx.uniform1i(pixelProg.u.uMask, 2);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.uniform1f(pixelProg.u.uMaskOn, maskSource ? 1 : 0);
    ctx.uniform1f(pixelProg.u.uMaskAmount, maskNow);
    ctx.uniform4f(
      pixelProg.u.uMaskRect,
      opts.maskRect[0], maskAspect, opts.maskRect[1], opts.maskRect[2],
    );
    ctx.uniform1f(pixelProg.u.uMaskSeed, opts.maskSeed % 97);
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);
  }

  function animating(): boolean {
    if (document.hidden) return false;
    // A mask still settling keeps the loop alive even when motion is reduced.
    if (maskNow !== opts.maskAmount) return true;
    return !opts.paused && motionAllowed();
  }

  function tick(now: number): void {
    raf = 0;
    if (destroyed || lost) return;
    const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.1) : 0;
    lastTick = now;

    simTime += dt * opts.speed;
    if (simTime > TIME_WRAP) {
      simTime -= TIME_WRAP - 30;
      kickNow = Math.max(kickNow, 0.7);
    }
    clock = (clock + dt) % CLOCK_WRAP;
    kickNow = Math.max(0, kickNow - dt * 2.5);
    if (switchT < 1) switchT = Math.min(1, switchT + (dt * 1000) / Math.max(100, opts.transitionMs));
    if (maskNow !== opts.maskAmount) {
      const step = (dt * 1000) / Math.max(1, opts.maskEaseMs);
      maskNow = opts.maskAmount > maskNow
        ? Math.min(opts.maskAmount, maskNow + step)
        : Math.max(opts.maskAmount, maskNow - step);
    }
    alertNow += (opts.alert - alertNow) * Math.min(1, dt * 4);
    const target = opts.interactive && now - lastPointer < 1500 ? 1 : 0;
    presence += (target - presence) * Math.min(1, dt * 4);

    const interval = 1000 / Math.max(1, opts.fps);
    if (now - lastDraw >= interval - 1) {
      lastDraw = now;
      draw();
    }
    if (animating()) raf = requestAnimationFrame(tick);
  }

  function start(): void {
    if (raf || destroyed || lost) return;
    lastTick = 0;
    lastDraw = 0;
    if (!motionAllowed()) maskNow = opts.maskAmount;
    if (animating()) raf = requestAnimationFrame(tick);
    else {
      alertNow = opts.alert;
      draw();
    }
  }

  function stop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  const onPointer = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointerX = e.clientX - rect.left;
    pointerY = e.clientY - rect.top;
    lastPointer = performance.now();
  };
  const onPointerLeave = (): void => { lastPointer = -1e9; };

  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => { if (!raf) draw(); })
    : null;
  ro?.observe(canvas);

  const restart = (): void => { stop(); start(); };
  const onLost = (e: Event): void => { e.preventDefault(); lost = true; stop(); };
  const onRestored = (): void => {
    lost = false;
    try { setup(); start(); } catch (err) { console.error(err); }
  };

  window.addEventListener("pointermove", onPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", restart);
  reduceMotion?.addEventListener?.("change", restart);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  setup();
  start();

  return {
    supported: true,
    update(next) {
      const prevMask = opts.mask;
      opts = { ...opts, ...next };
      if (opts.mask !== prevMask) uploadMask();
      restart();
      if (!raf) draw();
    },
    kick(strength = 1) {
      kickNow = Math.max(kickNow, Math.min(1, Math.max(0, strength)));
    },
    maskSettled() {
      return maskNow === opts.maskAmount;
    },
    transition(direction = 1) {
      if (opts.transition === "none" || !motionAllowed()) return;
      switchT = 0;
      switchDir = direction < 0 ? -1 : 1;
      switchSeed = Math.floor(Math.random() * 97) + 0.5;
    },
    render() {
      draw();
    },
    destroy() {
      destroyed = true;
      stop();
      ro?.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", restart);
      reduceMotion?.removeEventListener?.("change", restart);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (!ctx.isContextLost()) {
        ctx.deleteTexture(fieldTex);
        ctx.deleteTexture(maskTex);
        ctx.deleteTexture(atlasTex);
        ctx.deleteFramebuffer(fbo);
        ctx.deleteBuffer(quad);
        if (fieldProg) ctx.deleteProgram(fieldProg.prog);
        if (pixelProg) ctx.deleteProgram(pixelProg.prog);
      }
    },
  };
}
