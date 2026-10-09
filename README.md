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
- **Behaviour Triage** *(new in v0.3)*: Reads the Sysmon log and ranks the events that deserve a look, using a small language model (SENTRI-Classifier v3, a fine-tune of SmolLM3-3B) that runs on this PC. It triages; it does not prove. See [Behaviour triage](#behaviour-triage).

---

## Behaviour triage

Open the **Behaviour** tab. A small language model reads Sysmon events on this PC and rates each *behaviour* **none / low / medium / high**, so a person only has to look at the few that matter. It is a triage aid, not an antivirus: it will miss things and flag harmless ones, and a *High* means "look here first", not "this is certainly an attack".

**Setup (once)**

1. **Sysmon**: press *Install Sysmon*. OSAVA installs it with a pinned, checksummed configuration and asks for administrator permission once. It also adds you to *Event Log Readers*, so OSAVA itself never has to run as admin. Windows applies that at your **next sign-in**: sign out and back in once.
2. **Local model**: press *Install model*. OSAVA downloads a pinned llama.cpp build and checks both it and the model file against fixed checksums. The model (`osava-smollm-q4.gguf`, 1.9 GB, SHA-256 `9ab1eba2…3d51`) is not bundled: put it in `%USERPROFILE%\.osava\llm\` (an Ollama store is also checked), or set `OSAVA_MODEL_URL` to a download for it.
3. **Start monitoring** (or *Scan once*). Everything runs on this PC; events and verdicts are kept in `%USERPROFILE%\.osava\` and are never sent anywhere.

**How to read it**

- The model judges one event at a time, with no memory of earlier ones. A behaviour (the event with who and where removed: user, IP address, port) is judged the first time it is seen and only counted afterwards.
- *Severity* is the model's call. The reasons and tags are computed from the event by fixed rules, so they can only quote what is in it.
- If the model gives no usable answer, OSAVA escalates the event rather than calling it clean ("No answer").
- It judges Sysmon process (1), network (3), image-load (7), file (11) and registry (12, 13) events. Everything else is counted under *Not assessed*, never treated as clean. Logon events (4624/4625) are in the model's training, but OSAVA reads only the Sysmon log for now.
- *Medium* is the weakest call: clear attacks and clearly normal activity are told apart far more reliably than the grey area between them. Read None and Low as "nothing stood out", not "safe".

**Checking a build** (from `backend/`)

```bash
npm run unit             # monitor, scan pipeline, review rule, origin guard; needs no model
npm run selftest         # starts the real model and runs the contract's canaries (Windows)
npm run eval-llama -- <eval_set.jsonl> <out.json>   # held-out events; the shipped v3 scores 124/138
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
├── src-tauri/                  # Tauri v2 Rust application layer & installer bundle configuration
│   ├── binaries/               # Compiled sidecar executable (osava-backend.exe)
│   └── target/release/bundle/  # Generated .msi and .exe installers
├── public/                     # Static assets
├── package.json                # Root scripts and frontend dependencies
├── README.md                   # Project documentation
└── vite.config.ts              # Vite configuration
```

---

## Installation & Pre-Built Installers

Once compiled, Osava produces standalone Windows installer packages located in `src-tauri/target/release/bundle/`:

| Installer Format | File Name | Location | Description |
| :--- | :--- | :--- | :--- |
| **MSI Package** | `osava_0.3.0_x64_en-US.msi` | `src-tauri/target/release/bundle/msi/` | Windows Installer package suitable for standard or enterprise deployment. |
| **Executable Setup** | `osava_0.3.0_x64-setup.exe` | `src-tauri/target/release/bundle/nsis/` | NSIS interactive setup installer. |

---

**Prefer not to build it yourself? Check the Releases page for pre-built installers.*

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

To run the full desktop application in development mode with hot-reloading:

```bash
# From the root directory:
npm run dev
```

To run the backend and frontend servers separately:

```bash
# Terminal 1: Backend API (http://localhost:4000)
cd backend
npm run dev

# Terminal 2: Frontend Vite app (http://localhost:1420)
cd ..
npm run dev
```

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
