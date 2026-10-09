# Changelog

## Alpha v0.3: Behaviour triage (2026-10-09)

OSAVA now uses the SENTRI-Classifier v3 model end to end. The classifier backend landed earlier on this
branch; v0.3 adds the part a person can use, and fixes what running it against the real stack turned up.

### Added

- **Behaviour tab.** Install Sysmon and the local model, start or stop monitoring, scan once, and read the
  verdicts: needs-review first, then by severity, each with the reasons, the event exactly as the model saw
  it, and the model's per-class probabilities. Built from the existing OSAVA design system.
- **Continuous monitor**, in the backend so it keeps running while another tab is open. One scan at a time;
  a backlog is drained straight away; a transient failure is retried (2 s, then 4 s) and monitoring stops
  after three in a row; a problem only the user can fix (the log is unreadable, the model is wrong or
  missing) stops it at once and says why.
- **Silence is never clean.** The page counts the event types the model does not judge ("Not assessed"),
  says "Monitoring is off. Nothing is being assessed." rather than showing an empty list, and shows a model
  that gave no usable answer as "No answer", escalated, instead of inventing a rationale.
- **A verdict is a claim by one model.** A behaviour judged by a different model than the one now installed
  is judged again, keeping its history.
- `reviewReason()`: the single definition of "needs review" (no answer, not benign, or a close call), used by
  the classifier and returned by the API.
- `npm run unit`: 17 tests for the monitor, the scan pipeline, the review rule and the origin guard. They need
  no Windows and no model (a fake llama-server answers). The ones guarding the bugs below were checked by
  reintroducing each bug and watching the right test fail.
- `OSAVA_STATE_FILE` to point the behaviour state somewhere other than `~/.osava/behaviour.json`.

### Fixed (each found by running the real thing)

- **Events were silently skipped when more than 500 piled up.** `Get-WinEvent` walks a log newest-first and
  applies `-MaxEvents` to that order, so the reader took the newest 500 and the bookmark jumped past every
  older pending record. It now reads `-Oldest`, and a backlog drains in order.
- **`GET /api/behaviour/status` returned 500** whenever the 64-bit Sysmon (service `Sysmon64`) was installed:
  `powershell.exe` printed the right answer and then exited 1 because the 32-bit service name does not exist.
- **A failed elevation was reported as success.** A `Start-Process` that does not start leaves `$p` null and
  `exit $p.ExitCode` exits 0. It now fails with `ELEVATION_DENIED`, and the install is re-checked against the
  service rather than trusted to an exit code.
- **Two scans, or two model starts, at once** could read the same bookmark, classify the same behaviours
  twice, or race for the port. Both are now single-flight.
- **A stopped model server's late exit event** could make OSAVA forget the next one it had started, and so
  never stop it.
- **A llama-server that cannot be launched** (an antivirus blocking the exe, say) crashed the whole backend
  on an unhandled `error` event.
- **A scan that failed partway lost what it had decided.** Progress is now saved up to the record that failed.
- **The model file was checksummed at install but not at start.** It is now checked every time the server
  starts, remembered by the file's size and modification time so it costs a hash only when the file changes.
- The reader tells "no new events", "no such log" and "no access" apart by exception type and error id, not
  by English message text, so an idle log is not an error on a Windows in another language.
- **The sidecar built by `npm run compile` on a different Node than pkg's Windows target refused to start**
  ("V8 rejected the bytecode cache"). It is now packaged with `--no-bytecode`.

### Security

- The `/api/behaviour/*` routes answer only to the OSAVA window. A browser request from any other origin, or
  with a Host that is not loopback (DNS rebinding), is refused before it reaches a handler. The routes serve
  command lines and paths from Sysmon and can start installers, so any web page open on the PC must not be
  able to read or trigger them.
- The backend listens on loopback only, on both `127.0.0.1` and `::1`. It used to listen on every interface,
  which is also what makes Windows ask the user to allow the app through the firewall. Both families are
  bound because `localhost` resolves to `::1` first and a refused connection there costs two seconds.
- *Not changed:* the older ClamAV routes still use an open CORS policy. The loopback bind closes the network
  exposure; a web page in the user's own browser could still reach them.

### Known limits

- **The model is not bundled or hosted.** Put `osava-smollm-q4.gguf` (SHA-256 `9ab1eba2…3d51`) in
  `%USERPROFILE%\.osava\llm\`, or set `OSAVA_MODEL_URL`. OSAVA verifies whatever it gets.
- **Logon events (4624/4625) are not read.** They are in the model's training, but the reader opens only the
  Sysmon channel.
- **Medium is the weakest call.** Clear attacks and clearly normal activity are told apart far more reliably
  than the grey area between them. Verdicts are per event, with no memory of earlier ones, and a behaviour is
  decided the first time it is seen.
- **Reading the live Sysmon log needs a sign-out and back in** after the first install (the new *Event Log
  Readers* membership takes effect at sign-in).
- The installer (`.msi` / `.exe`) is built with `npm run tauri build` on Windows; it was not rebuilt for this
  entry. The version in `package.json`, `tauri.conf.json` and `Cargo.toml` is 0.3.0.

### Verification

- The v3 model, the pinned llama.cpp build and the shipped contract are unchanged. Canaries M011, X074 and B025
  pass on the deployed GGUF. On the 138 held-out events every severity, margin and verdict is identical to
  the earlier integration run (124/138 = 89.9%; one threat scored benign, flagged for review).
- The production PowerShell reader was replayed against exported Sysmon logs and compared with the Python that
  built the training data: **6,513 real records, contract text and behaviour signature identical**, covering
  EventIDs 1, 3, 7, 11, 12, 13 and 22 (and 4624 through the shared converter), truncated command lines, `%`
  escapes and records the converter rejects. UTF-8 round-tripping was checked separately with synthetic text,
  since no capture contains any.
- The documented parity gates on the final code: `npm run parity` 5,267 / 5,267 records (model input and
  behaviour signature, with the 1,279 rejections agreeing) and `npm run parity-explain` 12,423 / 12,423 cases
  (`explain.ts` against the current `targets.py`).
- The packaged sidecar, built on Linux and run on Windows, starts in under a second and passes the origin
  guard and the status, verdict and scan routes.
- The model also runs on the CPU alone (`OSAVA_LLM_DEVICE=none`): canaries pass, and on 40 held-out events
  every severity matches the iGPU run (margins differ by up to 0.12, as numerics do across backends). About
  1.3 s per new behaviour on an 8-core Ryzen 7 8845HS, against about 0.25 s on its Radeon 780M.
- *Not exercised:* a live Sysmon feed. The account used for development is not yet in *Event Log Readers*, so
  the live log could only be tested for its failure path (`LOG_ACCESS_DENIED`) and through exported logs.
