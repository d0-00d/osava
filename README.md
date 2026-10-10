# Osava

**Osava** is a modern Windows desktop security dashboard built with [Tauri v2](https://tauri.app/), React 19, TypeScript, and Express. It provides system security monitoring, ClamAV antivirus management, behaviour triage with a language model that runs entirely on your PC, and custom scan/definition update workflows in a desktop interface.

---

## Releases are shipped spontaneously, with more features on the way...
(*￣０￣)ノ
**CURRENT STAGE → ALPHA v0.3**  ·  see [CHANGELOG.md](CHANGELOG.md)

---

## (✦_✦) Key Features

- **Security Dashboard**: Monitor real-time Windows Security Center status, including active antivirus software and Windows Firewall states across Domain, Private, and Public profiles.
- **Security Hub (ClamAV Manager)**: Check installation status, and download, install, or uninstall ClamAV via automated MSI setup.
- **AV Console**: Run ClamAV definition updates (`freshclam`), perform custom directory or full-system scans (`clamscan`), and view live output logs.
- **Behaviour Triage** *(new in v0.3)*: Reads the Sysmon log and ranks the events that deserve a look, using a small language model (SENTRI-Classifier v7b, a fine-tune of SmolLM3-3B) that runs on this PC. It triages; it does not prove. See [Behaviour triage](#behaviour-triage).

---

## Behaviour triage

Open the **Behaviour** tab. A small language model reads Sysmon events on this PC and rates each *behaviour* **none / low / medium / high**, so a person only has to look at the few that matter. It is a triage aid, not an antivirus: it will miss things and flag harmless ones, and a *High* means "look here first", not "this is certainly an attack".

**Setup (once)**

1. **Sysmon**: press *Install Sysmon*. OSAVA installs it with a pinned, checksummed configuration and asks for administrator permission once. Installing it accepts Microsoft's Sysinternals Software License Terms for Sysmon on your behalf. It also adds you to *Event Log Readers*, so OSAVA itself never has to run as admin. Windows applies that at your **next sign-in**: sign out and back in once. If Sysmon is already installed (put there by hand, say) but you are not in that group, the button reads *Grant log access* and does only that step; signing out alone would never help.
2. **Local model**: press *Install model*. OSAVA downloads a pinned llama.cpp build and the model, checking both against fixed checksums. It shows progress, **Stop** keeps what has arrived, and an interrupted download resumes where it left off. The model (`osava-smollm-q4.gguf`, 1.9 GB, SHA-256 `dc24b6b9…1f52`) is fetched from the address recorded in the build's `contract.json` (or `OSAVA_MODEL_URL`); a build without one cannot fetch it, so put the file in `%USERPROFILE%\.osava\llm\` (an Ollama store is also checked) and press the button to have it verified. The first start of the model can take a minute or two, while Windows checks the freshly downloaded programs; if the graphics path does not work on your PC, OSAVA starts it on the CPU instead.
3. **Start monitoring** (or *Scan once*). Everything runs on this PC; events and verdicts are kept in `%USERPROFILE%\.osava\` and are never sent anywhere.

**How to read it**

- The model judges one event at a time, with no memory of earlier ones. A behaviour (the event with who and where removed: user, IP address, port) is judged the first time it is seen and only counted afterwards.
- *Severity* is the model's call. The reasons and tags are computed from the event by fixed rules, so they can only quote what is in it.
- If the model gives no usable answer, OSAVA escalates the event rather than calling it clean ("No answer").
- **Mark as expected** on a flagged behaviour you recognise takes it off *Needs review*. The model's verdict stays as it was, labelled *Expected*, and you can undo it. A new model's verdict on the same behaviour is shown to you again.
- OSAVA's own work is skipped, not judged: its PowerShell log readers and status checks, the model server, and what they write. It is recognised from the log itself (the processes the backend started, and theirs), not from names, so another program's PowerShell is still judged.
- It judges Sysmon process (1), network (3), image-load (7), file (11) and registry (12, 13) events. Everything else is counted under *Not assessed*, never treated as clean. It also judges logons (4624, 4625) from the Security log, which the same *Event Log Readers* membership opens; if that log cannot be read, the Behaviour tab says logons are not being assessed.
- *Medium* is the weakest call: clear attacks and clearly normal activity are told apart far more reliably than the grey area between them. Read None and Low as "nothing stood out", not "safe".

**Checking a build** (from `backend/`)

```bash
npm run unit             # monitor, scan pipeline, review rule, origin guard; needs no model
npm run selftest         # starts the real model and runs the contract's canaries (Windows)
npm run eval-llama -- <eval_set.jsonl> <out.json>   # held-out events; the shipped v7b scores 122/138
npm run parity -- <fixture.json>                    # event -> model input, byte for byte against the Python
npm run parity-explain -- <fixture.json>            # explain.ts against targets.py
```

The fixtures come from `parity/` in [osava-slm](https://github.com/d0-00d/osava-slm). They hold real telemetry, so they are never committed.

---

## Repository Structure

```text
osava/
├── src/                        # React + TypeScript frontend UI
├── backend/                    # Standalone Express API backend (bundled via esbuild + pkg)
│   └── src/services/behaviour/ # Behaviour triage: Sysmon reader, model runtime, classifier, monitor
├── scripts/release-test/       # Drives the built app and its installer on Windows (see RELEASING.md)
├── src-tauri/                  # Tauri v2 Rust application layer & installer bundle configuration
│   ├── binaries/               # Compiled sidecar executable (osava-backend.exe)
│   └── target/release/bundle/  # Generated .msi and .exe installers
├── public/                     # Static assets
├── package.json                # Root scripts and frontend dependencies
├── README.md                   # Project documentation
└── vite.config.ts              # Vite configuration
```

---

## Installing OSAVA

Windows 10 or 11, 64-bit. Download `osava_<version>_x64-setup.exe` (installs for your user, no administrator
needed) from the [Releases](https://github.com/d0-00d/osava/releases) page, with `SHA256SUMS.txt`, and check
what you downloaded. The `.msi` installs for every user of the PC into Program Files and asks for administrator
permission; it is there for managed deployment.

```powershell
Get-FileHash .\osava_0.3.0_x64-setup.exe -Algorithm SHA256
```

Alpha releases are **not code-signed yet**, so Windows SmartScreen shows "Windows protected your PC" and
"Unknown publisher". After comparing the hash with `SHA256SUMS.txt`, choose *More info*, then *Run anyway*.

OSAVA needs two things Microsoft ships with current Windows, and a clean or old PC may lack: **WebView2** (the
setup downloads it from Microsoft if it is missing, which needs a connection that once) and the **Visual C++
Redistributable (x64)**, which the model runtime needs. If the second is missing the Behaviour tab says so, before
it downloads anything, and links Microsoft's installer
([aka.ms/vs/17/release/vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)).

Only one copy runs at a time: opening OSAVA again brings the first window forward. If OSAVA stays on its start
screen, another program may be using port 4000; `%USERPROFILE%\.osava\backend.log` says what the backend reported.

The first time you open the **Behaviour** tab, OSAVA sets itself up (details under
[Behaviour triage](#behaviour-triage)): Sysmon (one administrator prompt), then the model runtime. That is a
download of about 2 GB, shown with a progress bar; **Stop** keeps what has arrived and pressing Install again
continues from there. It needs an internet connection once and about 2.5 GB of free disk space. After that,
everything runs offline. (A build whose contract names no download address cannot fetch the model: copy
`osava-smollm-q4.gguf` into `%USERPROFILE%\.osava\llm\` instead and press *Install model* to check it.)

**Removing it.** Uninstall OSAVA from *Settings → Apps*. It leaves what it set up, because other tools may use
it: the model and state in `%USERPROFILE%\.osava` (about 2 GB; delete the folder), and Sysmon (`Sysmon64.exe -u`
from an administrator prompt removes it).

### Building the installers yourself

Once compiled, Osava produces standalone Windows installer packages in `src-tauri/target/release/bundle/`:

| Installer Format | File Name | Location | Description |
| :--- | :--- | :--- | :--- |
| **MSI Package** | `osava_0.3.0_x64_en-US.msi` | `src-tauri/target/release/bundle/msi/` | Windows Installer package suitable for standard or enterprise deployment. |
| **Executable Setup** | `osava_0.3.0_x64-setup.exe` | `src-tauri/target/release/bundle/nsis/` | NSIS interactive setup installer. |

How a release is made, and what is not done yet, is in [RELEASING.md](RELEASING.md). Third-party licences are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Requirements & Development Setup

### System Requirements

- **OS**: Windows 10 or 11 (required for Windows Security Center & PowerShell queries)
- **Hardware**: The dashboard and ClamAV parts are light. Behaviour triage loads a 1.9 GB model (about 2 GB of RAM or video memory) and only sends it behaviours it has not judged before. Measured on a Ryzen 7 8845HS laptop: about 0.25 s per new behaviour on its integrated Radeon 780M (Vulkan), about 1.3 s on the CPU alone. Slower machines will take longer.
- **Node.js**: v20+ LTS
- **Package Manager**: `npm`
- **Rust Toolchain**: Required to compile the Tauri desktop application (`cargo`, `rustc`)

### Step-by-Step Setup

1. **Clone the repository and install frontend dependencies:**
   ```bash
   git clone https://github.com/your-repo/osava.git
   cd osava
   npm install
   ```

2. **Install backend dependencies:**
   ```bash
   cd backend
   npm install
   cd ..
   ```

---

## Running the App Locally

### Development Mode

Run the app from **Windows** (PowerShell or Windows Terminal), not from WSL. The Tauri shell needs the Windows Rust (MSVC) toolchain, and the backend uses PowerShell, the Windows event log and `%USERPROFILE%\.osava`. Under WSL, `npm run tauri dev` stops at `failed to run 'cargo metadata'` because there is no Rust there, and a backend running there would look for the model in the wrong home directory. Install dependencies with Windows' `npm` in the Windows checkout (`node_modules` installed under WSL holds Linux binaries). Editing, `tsc` and `npm run unit` work anywhere.

The debug build of the desktop shell does not start the backend sidecar, so run the two pieces yourself:

```powershell
# Terminal 1: Backend API (http://localhost:4000)
cd backend
npm run dev

# Terminal 2: the desktop app. It starts Vite (http://localhost:1420) itself, then opens the window.
npm run tauri dev
```

To work on the UI alone in a browser, `npm run dev` from the root starts only Vite. To try Behaviour triage right away without signing out first, start the backend terminal elevated ("Run as administrator"): an administrator can read the Sysmon log.

---

## Building `.msi` and `.exe` Installers

To compile the backend sidecar executable, build the React frontend production bundle, and generate both `.msi` and `.exe` installers, run:

```bash
npm run tauri build
```

### What happens during `npm run tauri build`

1. **Backend compilation (`npm run build:backend`)**
   - `esbuild` bundles `backend/src/index.ts` into `dist/backend.cjs`.
   - `@yao-pkg/pkg` compiles `backend.cjs` into `src-tauri/binaries/osava-backend-x86_64-pc-windows-msvc.exe`, without V8 bytecode (`--no-bytecode`). Bytecode is tied to the exact Node build that made it, and a sidecar built on a different Node than pkg's Windows target refuses to start.
2. **Frontend build (`npm run build`)**
   - `tsc` checks TypeScript types, and `vite build` bundles the frontend into `dist/`.
3. **Tauri bundling (`tauri build`)**
   - Rust compiles the native wrapper (`src-tauri`).
   - The WiX toolset compiles `osava_0.3.0_x64_en-US.msi`.
   - The NSIS toolset compiles `osava_0.3.0_x64-setup.exe`.

---

## Backend API Endpoints

The internal Express backend (listening on `http://localhost:4000`, loopback only) exposes:

- `GET /health` — Health check status
- `GET /api/system-status` — Antivirus and firewall status via PowerShell `Get-CimInstance`
- `GET /api/install-status` — ClamAV installation check (`~\.osava\install-status.json`)
- `POST /api/install-status` — Trigger ClamAV MSI installer download and execution
- `POST /api/uninstall` — Trigger ClamAV uninstallation
- `POST /api/av/update` — Execute a `freshclam` definition update
- `POST /api/av/scan` — Execute `clamscan` against target paths

Behaviour triage:

- `GET /api/behaviour/status` — Setup state (Sysmon, runtime), model identity, monitor state, counts
- `POST /api/behaviour/install-sysmon` — Install Sysmon (one UAC prompt) and add the user to *Event Log Readers*
- `POST /api/behaviour/install-runtime` — Download and verify llama.cpp, verify the model file
- `POST /api/behaviour/monitor/start` · `POST /api/behaviour/monitor/stop` — Continuous scanning (stop also unloads the model)
- `POST /api/behaviour/scan` — One scan now
- `POST /api/behaviour/stop` — Stop monitoring and unload the model
- `GET /api/behaviour/verdicts?view=review|all&limit=200` — Verdicts, those needing review first, then by severity

The `/api/behaviour/*` routes answer only to the OSAVA window: a request from any other web origin, or with a Host that is not loopback, is refused (`routes/localOnly.ts`). They serve what Sysmon recorded, so any web page open on this PC must not be able to read them.

---

## Disclaimer

**Note:** This is an early development build, with more features planned for future releases. I am **not** responsible for any damages resulting from the use of this application — though this is unlikely, given its currently minimal functionality. Behaviour triage in particular is an experimental aid for a person doing the looking, not a protection: it can miss real attacks and flag harmless activity.

---

## License

This project is open source. See license details if applicable.

## ;))
