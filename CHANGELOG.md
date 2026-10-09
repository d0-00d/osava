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
- `npm run unit`: 18 tests for the monitor, the scan pipeline, the review rule, the origin guard and module
  names. They need no Windows and no model (a fake llama-server answers). The ones guarding the bugs below
  were checked by reintroducing each bug and watching the right test fail.
- **"Grant log access".** When Sysmon is installed but the account is not in the *Event Log Readers* group
  (Sysmon put there by hand, say), the Behaviour tab says so and offers to add it: one administrator prompt,
  the same step the installer already did. `/status` now reports `sysmon.group` (`member`, `not-member`,
  `unknown`), because the two cures differ: a member only has to sign in again, but signing out never helps
  someone who was not added.
- `OSAVA_STATE_FILE` to point the behaviour state somewhere other than `~/.osava/behaviour.json`.
- **A model install that survives a bad connection.** The 1.9 GB download resumes from where it stopped (a
  `Range` request on a `.part` file), shows how far along it is, can be stopped (keeping what arrived), checks
  free disk space first, and gives up on a stalled connection instead of hanging. It runs as a background job
  whose progress is part of `/status`, so closing the window or changing tab loses nothing. A model file
  copied in by hand is recognised and checked by pressing Install.
- **CPU fallback.** If the graphics path will not start, hangs, or fails the canaries, the server is started
  again on the CPU, and the Behaviour tab says so. Measured: a clean install's first start took 59 s (Windows
  scanning the new unsigned programs; 8 s afterwards), so the startup allowance is now 120 s.
- The model's download address can be recorded in `contract.json` beside its checksum
  (`export_contract.py --model-url`), or set with `OSAVA_MODEL_URL`.
- **`npm run verify-release`**: checks everything a clean machine will fetch against what the code pins (llama.cpp
  and the Sysmon config by SHA-256, Sysmon by its Microsoft signature, the model's address, size and `Range`
  support; `--full` also downloads and hashes the model). It fails while the model has no address.
- `RELEASING.md` (the procedure, a checklist for the installed app, and what is not done), CI for pushes, a
  draft-release workflow for tags (not yet run), and `THIRD_PARTY_NOTICES.md`.
- **A trail when the backend cannot start.** It writes one line to `%USERPROFILE%\.osava\backend.log` when it starts, and a plain reason when it cannot (port 4000 taken by another program, a crash), then exits. The splash, which used to tell an installed user to run `cd backend && npm run dev`, now says another program may be using port 4000 and where to look.
- The installer now has an identity: explicit targets, a per-user NSIS install, a publisher, copyright and
  descriptions instead of "A Tauri App".
- **One window at a time.** Opening OSAVA again brings the first window forward.
- **The model runtime's one outside requirement is checked first.** llama.cpp needs the Visual C++ Redistributable
  (x64), which a clean Windows may lack. Before downloading 2 GB, the Behaviour tab checks for it, names it and
  links Microsoft's installer; and a server that dies because a DLL is missing is reported as that, in about a
  second, instead of as an unexplained exit after trying the CPU too.

### Fixed (each found by running the real thing)

- **The installed app hid the AV Console, Threats and Scan History tabs, and System Health first said "No
  antivirus product detected" and "No firewall product detected".** The window and its backend start together
  and the page loads first; within 100 ms it asked for the install status, the scan history and the system status,
  and all three were refused because the backend listens about half a second later. Only the splash retried. The
  tabs depend on two answers asked for once, so they stayed missing for the whole session on a PC with ClamAV and
  scan history. `npm run dev` hid it, because the backend is started by hand before the window. The page now asks
  once the splash has found the backend.
- **Killing OSAVA (Task Manager, a crash, an installer replacing it) left its backend running**, holding port 4000
  and the model in memory, and the next launch talked to the old copy. The window now gives the backend its pid
  and the backend exits within two seconds of that process going.
- **Starting OSAVA twice** opened a second window with no backend of its own, and closing the first window killed
  the one they shared. See "One window at a time".
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
- **`npm run dev` crashed on startup** (`Cannot read properties of undefined`). `contract.ts` sat next to
  `contract.json`, and under ts-node `require("./contract")` resolves the `.json` first, so `CONTRACT` was
  undefined. tsc, esbuild and pkg all prefer the `.ts`, so the typecheck, the bundle, the packaged sidecar and
  every test passed; only ts-node-dev broke. The module is now `contractSpec.ts` (the same rename the Windows
  working copy had already made), and a unit test refuses any `.ts` that shares a name with a `.json`.
- The Behaviour tab told someone who had never been added to the log-readers group to "sign out and back in",
  and offered no way forward. See "Grant log access" above.
- "Already a member" was recognised by its English message; it is now also recognised by exception type.
- **The UI fetched its fonts from Google on every launch**, sending the user's IP address to a third party from
  a product that promises nothing leaves the machine, and falling back to a system font offline. The fonts
  (OFL) now ship inside the app.
- **A Windows username with an apostrophe** (O'Brien) broke the llama.cpp unpack and the Sysmon install, because
  paths went into PowerShell single-quoted strings unescaped. The clean-install test runs from `José O'Brien`.
- **An interrupted unpack of llama.cpp** could leave an `llama-server.exe` without its DLLs that then counted as
  "installed" forever. The unpack is now atomic.
- **A model file counted as "installed" the moment it existed.** It now has to be verified against the checksum.
- Installing Sysmon accepts Microsoft's licence terms on the user's behalf (`-accepteula`) without saying so;
  the Behaviour tab now does.
- The backend typechecks cleanly for the first time: an unfinished KicomAV scaffold returned nothing from a
  function that promised a string. It now throws "not implemented".

### Security

- The `/api/behaviour/*` routes answer only to the OSAVA window. A browser request from any other origin, or
  with a Host that is not loopback (DNS rebinding), is refused before it reaches a handler. The routes serve
  command lines and paths from Sysmon and can start installers, so any web page open on the PC must not be
  able to read or trigger them.
- The backend listens on loopback only, on both `127.0.0.1` and `::1`. It used to listen on every interface,
  which is also what makes Windows ask the user to allow the app through the firewall. Both families are
  bound because `localhost` resolves to `::1` first and a refused connection there costs two seconds.
- The window makes no request to any host but its own (checked in the built UI): the Google Fonts calls are gone.
- *Not changed:* the older ClamAV routes still use an open CORS policy. The loopback bind closes the network
  exposure; a web page in the user's own browser could still reach them.

### Known limits

- **The model has no hosted address yet.** The contract can carry one, and `verify-release` fails until it does. Until then put `osava-smollm-q4.gguf` (SHA-256 `9ab1eba2…3d51`) in `%USERPROFILE%\.osava\llm\`, or set `OSAVA_MODEL_URL`, and press Install to have it verified. The weights' licence is undecided, and neither repository has a LICENSE file.
- **Logon events (4624/4625) are not read.** They are in the model's training, but the reader opens only the
  Sysmon channel.
- **Medium is the weakest call.** Clear attacks and clearly normal activity are told apart far more reliably
  than the grey area between them. Verdicts are per event, with no memory of earlier ones, and a behaviour is
  decided the first time it is seen.
- **Reading the live Sysmon log needs a sign-out and back in** after OSAVA adds the account to *Event Log
  Readers* (Windows applies a new membership at sign-in). Until then, a backend started elevated can read it.
- **Not tested on a clean PC.** The installers (`.msi` / `.exe`, built with `npm run tauri build` on Windows) were
  built and exercised on the development machine, not on a Windows that has never seen OSAVA. They are unsigned.
  The Visual C++ runtime is checked for and explained, not installed for you. The version in `package.json`,
  `tauri.conf.json` and `Cargo.toml` is 0.3.0.

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
- **The built app, driven through its WebView2 debugging port by a script, nothing mocked.** A plain launch
  shows every tab the PC has data for (six here), makes no request that fails, logs no console error, and talks
  only to its own origin and `localhost:4000`. A second launch exits and leaves one window and one backend.
  Closing the window leaves no process. Killing it takes the backend with it in 1.6 s, and with the model loaded
  the model server too (2.6 s). Before the fixes the same launch showed three tabs, three console errors and four
  refused requests, and a kill left the backend running.
- **The installer.** The NSIS setup asks for no administrator rights (its manifest says `asInvoker`), installs for
  the current user in under three seconds, registers under the current user only, makes its shortcuts, and the
  installed copy passes the checks above. Installing over a running copy works, and uninstalling removes what
  the setup put there and leaves only `%USERPROFILE%\.osava`. It was run as a renamed copy of the same build
  (another product name and identifier), so it could not touch a v0.1 install that was already on the machine.
  The `.msi` was not run: it installs for all users and needs administrator rights.
- *Not exercised:* a live Sysmon feed. The account used for development is not yet in *Event Log Readers*, so
  the live log could only be tested for its failure path (`LOG_ACCESS_DENIED`) and through exported logs. Nor a
  Windows that has never seen OSAVA, or one without the Visual C++ runtime (that failure was run for real by
  removing a DLL from the server's folder: refused in 1.1 s with the right message).
