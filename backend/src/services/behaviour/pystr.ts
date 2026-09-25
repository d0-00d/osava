// Python string semantics, where they differ from JavaScript's.
//
// The conversion and signature code are ports of Python, and they must agree
// byte for byte (see parity/). Three places JS and Python disagree:
//   * length and slicing: Python counts code points, JS counts UTF-16 units
//   * str.strip() / str.split(): Python's whitespace set is not JS's \s --
//     Python includes \x1c-\x1f and \x85; JS includes ﻿
// ASCII-only input never hits any of this. Real telemetry sometimes does.

const PY_WS = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0  -     　";
const STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const SPLIT = new RegExp(`[${PY_WS}]+`);

export const pyStrip = (s: string) => s.replace(STRIP, "");
export const pySplitWs = (s: string) => s.split(SPLIT).filter((x) => x !== "");
export const pyLen = (s: string) => Array.from(s).length;
export const pySlice = (s: string, end: number) =>
  pyLen(s) <= end ? s : Array.from(s).slice(0, end).join("");
