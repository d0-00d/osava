// ─────────────────────────────────────────────────────────────
// Only OSAVA's own window may use the behaviour API.
//
// It serves what Sysmon recorded -- command lines, paths, user names -- and it
// can start installers. The backend listens on the loopback interface, but a
// web page open in any browser on this machine can still send requests to
// localhost, and with a permissive CORS policy it can read the answers. Two
// checks close that:
//
//   * Origin. A browser attaches the page's origin to a cross-origin request
//     (always, for anything but a plain GET). OSAVA's window is the only
//     origin allowed; a request from anywhere else is refused before it
//     reaches a handler, so neither the data nor the side effect is reachable.
//     Non-browser callers send no Origin and are not affected: whoever can run
//     a local program as this user can read the state file anyway.
//   * Host. A page can rebind its own DNS name to 127.0.0.1 and make requests
//     that look same-origin to the browser. Those carry the attacker's name in
//     the Host header, which is not ours.
//
// The origins are the ones Tauri 2 gives the bundled UI: http://tauri.localhost
// on Windows (https:// when `useHttpsScheme` is set), tauri://localhost
// elsewhere; and Vite's dev server.
// ─────────────────────────────────────────────────────────────

import type { NextFunction, Request, Response } from "express";
import { API_PORT } from "../config";

export const ALLOWED_HOSTS = new Set([
  `localhost:${API_PORT}`, `127.0.0.1:${API_PORT}`, `[::1]:${API_PORT}`,
]);

export const ALLOWED_ORIGINS = new Set([
  "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
  "http://localhost:1420", "http://127.0.0.1:1420",
]);

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = (req.headers.host ?? "").toLowerCase();
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(host) || (origin !== undefined && !ALLOWED_ORIGINS.has(origin))) {
    // The app-wide cors() has already stamped "*" on this response; do not let
    // a refused page read even the refusal.
    res.removeHeader("Access-Control-Allow-Origin");
    res.status(403).json({ error: "This API is for the OSAVA app only.", code: "NOT_LOCAL" });
    return;
  }
  next();
}
