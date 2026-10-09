# Releasing OSAVA

A release is three things in order: a model that is **hosted and verified**, installers **built from a tagged
commit**, and a **draft** release that a person reads before publishing. Code signing is not part of this yet
(see "Not done yet" at the end).

## Once per model (not once per OSAVA release)

1. **Decide what the weights go out under**, and check what is in them. See "The classifier model" in
   [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): the base is Apache-2.0, the training data includes
   GPL-3.0 captures and the author's own benign telemetry.
2. **Host the GGUF** at a stable address that honours `Range` requests (so an interrupted download resumes). A
   GitHub release asset works; the limit is 2 GiB per file and the model is 1,915,305,440 bytes:

   ```bash
   gh release create model-v3 osava-smollm-q4.gguf --repo d0-00d/osava-slm --title "osava-smollm v3 (Q4_K_M)" --notes "…"
   ```

3. **Record the address beside the checksum it belongs to**, in osava-slm, so the two cannot drift apart:

   ```bash
   python3 export_contract.py --out contract.json --model-sha256 <sha256> --model-bytes <bytes> --model-url <url>
   ```

   Copy that `contract.json` to `backend/src/services/behaviour/contract.json` here and commit both. Only
   `model.url` changes; run it without `--model-url` first and confirm the file is byte-identical.
4. **`cd backend && npm run verify-release -- --full`** must pass. It downloads the model from that address with
   OSAVA's own downloader and checks its SHA-256, so a wrong URL, a wrong file or a host without `Range`
   support is found here and not by a new user.

## For each release

1. Bump the version in `package.json`, `package-lock.json` (two places), `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`; add the entry to `CHANGELOG.md`.
2. Checks that run anywhere (CI runs these too):

   ```bash
   npx tsc --noEmit && npm run build
   cd backend && npx tsc --noEmit -p . && npm run unit
   ```

3. Checks that need Windows and the model (`cd backend`):
   - `npm run selftest`: starts the real model and runs the contract's canaries.
   - `npm run eval-llama -- <eval_set_v3.jsonl> out.json`: v3 scores 124/138; compare with the previous run, every
     verdict should be identical.
   - `npm run parity -- <fixture>` and `npm run parity-explain -- <fixture>` if conversion or explanation code
     changed (fixtures: `parity/` in osava-slm; they hold real telemetry, never commit them).
4. `npm run verify-release`: llama.cpp, the Sysmon config and zip, and the model's address, against what the
   code pins. It exits non-zero while the model has no address.
5. **Build on Windows**: `npm ci` in the root and in `backend/`, then `npm run tauri build`. Installers are
   written to `src-tauri/target/release/bundle/nsis` and `.../msi`. (`npm run compile` packages the sidecar
   with `--no-bytecode`, so it does not matter which Node version builds it.)
6. **Test the built and installed app.** `scripts/release-test/final-test.ps1` and `installer-test.ps1` (see the
   README in that folder) run the launch, second-launch, close and kill checks on the real app and the installer
   end to end. Then the checklist below, for what they do not reach (Sysmon, the model, a clean PC). Port 4000 must
   be free.
7. Checksums: `Get-FileHash <file> -Algorithm SHA256` for each installer, into `SHA256SUMS.txt`.
8. Tag and draft: `git tag -a Alpha.V0.x -m "…" && git push origin Alpha.V0.x`. The release workflow builds and
   attaches the installers to a **draft**; or create the draft by hand with `gh release create --draft`.
   Read it, then publish.

## Checklist: the installed app

Do this as a new user would, ideally on a Windows account that has never run OSAVA. The scripts already check the
items about the launch, a second launch and closing or killing the app.

- [ ] The installer runs per-user with no administrator prompt; Windows says "Unknown publisher" while unsigned.
- [ ] OSAVA opens, the splash finishes, System Health loads, nothing is stuck on "waiting for the backend".
- [ ] Straight after Launch, with nothing clicked, the sidebar has every tab this PC has data for: AV Console if
      ClamAV is installed, Threats and Scan History if there is scan history. (They were missing for a whole
      session when the page asked for them before the backend was listening.)
- [ ] Opening OSAVA a second time brings the first window forward; there is still one `osava.exe`.
- [ ] `osava-backend.exe` is running (Task Manager) and listens on `127.0.0.1:4000` only.
- [ ] **Behaviour tab → Install Sysmon**: one UAC prompt; declining it leaves a calm message, not "installed".
- [ ] If the account is not in *Event Log Readers*: "Grant log access", then sign out and back in.
- [ ] **Install model**: a progress bar moves; **Stop** keeps what was downloaded; **Install model** again resumes
      (watch the byte count continue, not restart); pulling the network cable mid-way recovers.
- [ ] **Start monitoring**: "Loading the model" (up to a minute or two the first time), then "Monitoring"; new
      behaviours appear as events happen.
- [ ] Closing OSAVA leaves no `osava-backend.exe` or `llama-server.exe` running. So does ending `osava.exe` in
      Task Manager, within a few seconds, and port 4000 is free again.
- [ ] On a PC without the Visual C++ runtime, **Install model** says so before downloading anything.
- [ ] Uninstalling OSAVA works; `%USERPROFILE%\.osava` and Sysmon are left alone (and documented as such).
- [ ] On a machine with no usable GPU, the CPU note appears and verdicts still come.

## Not done yet

- **A clean Windows.** Everything in the checklist above has been run on the development PC (CHANGELOG,
  Verification), the installer as a renamed copy so as not to disturb an older install. Not yet run: a Windows
  that has never seen OSAVA, one without the Visual C++ runtime, and the `.msi` (it installs per machine and needs
  administrator rights).
- **The product name is `osava`, the same as v0.1's**, so installing v0.3 upgrades a v0.1 install in place.
- **Code signing.** Installers are unsigned, so SmartScreen warns on first run. The README tells users how to
  check the SHA-256 and proceed.
- **The model has no hosted address**, and the weights' licence is undecided. `verify-release` fails until both
  are settled.
- **No LICENSE file** in either repository: until one is added, nobody else may legally use or redistribute
  the code.
- **No auto-update.** A new version is a new installer.
- **The window talks to a fixed port (4000)** and trusts whatever answers there. A program that binds 4000
  first can impersonate the backend. A per-launch token and a free port, handed to both sides by the shell,
  would fix it; it is bigger than an alpha fix.
- **Uninstall leaves `%USERPROFILE%\.osava`** (about 2 GB) and Sysmon in place.
- **Downloads do not use the system proxy** (Node's `fetch` ignores it); behind a proxy, copy the model in by hand.
- **Windows 10 / 11 x64 only**, and Sysmon's log is read, not the Security log: logons (4624/4625) are in the
  model's training but not yet read.
