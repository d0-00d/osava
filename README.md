# Osava — Open-Source Antivirus Application

*(Honestly, "platform" might be the more accurate word — but we'll see.)*

**Osava** is a modern Windows desktop security dashboard built with [Tauri v2](https://tauri.app/), React 19, TypeScript, and Express. It provides system security monitoring, email breach lookups, ClamAV antivirus management, and custom scan/definition update workflows in a desktop interface.

---

## Releases are shipped spontaneously, with more features on the way. ...(*￣０￣)ノ

**CURRENT STAGE → ALPHA v0.1**

---

## (✦_✦) Key Features

- **Security Dashboard**: Monitor real-time Windows Security Center status, including active antivirus software and Windows Firewall states across Domain, Private, and Public profiles.
- **Email Breach Checker**: Verify whether an email address has been compromised in a known data breach.
- **Security Hub (ClamAV Manager)**: Check installation status, and download, install, or uninstall ClamAV via automated MSI setup.
- **AV Console**: Run ClamAV definition updates (`freshclam`), perform custom directory or full-system scans (`clamscan`), and view live output logs.

---

## Repository Structure

```text
osava/
├── src/                        # React + TypeScript frontend UI
├── backend/                    # Standalone Express API backend (bundled via esbuild + pkg)
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
| **MSI Package** | `osava_0.1.0_x64_en-US.msi` | `src-tauri/target/release/bundle/msi/` | Windows Installer package suitable for standard or enterprise deployment. |
| **Executable Setup** | `osava_0.1.0_x64-setup.exe` | `src-tauri/target/release/bundle/nsis/` | NSIS interactive setup installer. |

---

**Prefer not to build it yourself? Check the Releases page for pre-built installers.*

## Requirements & Development Setup

### System Requirements

- **OS**: Windows 10 or 11 (required for Windows Security Center & PowerShell queries)
- **Hardware**: Likely runs fine on modest hardware (e.g. a Raspberry Pi), though this hasn't been formally tested
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
   - `@yao-pkg/pkg` compiles `backend.cjs` into `src-tauri/binaries/osava-backend-x86_64-pc-windows-msvc.exe`.
2. **Frontend build (`npm run build`)**
   - `tsc` checks TypeScript types, and `vite build` bundles the frontend into `dist/`.
3. **Tauri bundling (`tauri build`)**
   - Rust compiles the native wrapper (`src-tauri`).
   - The WiX toolset compiles `osava_0.1.0_x64_en-US.msi`.
   - The NSIS toolset compiles `osava_0.1.0_x64-setup.exe`.

---

## Backend API Endpoints

The internal Express backend (listening on `http://localhost:4000`) exposes:

- `GET /health` — Health check status
- `GET /api/system-status` — Antivirus and firewall status via PowerShell `Get-CimInstance`
- `GET /api/check-email/:email` — Email breach check integration
- `GET /api/install-status` — ClamAV installation check (`~\.osava\install-status.json`)
- `POST /api/install-status` — Trigger ClamAV MSI installer download and execution
- `POST /api/uninstall` — Trigger ClamAV uninstallation
- `POST /api/av/update` — Execute a `freshclam` definition update
- `POST /api/av/scan` — Execute `clamscan` against target paths

---

## Disclaimer

**Note:** This is an early development build, with more features planned for future releases. I am **not** responsible for any damages resulting from the use of this application — though this is unlikely, given its currently minimal functionality.

---

## License

This project is open source. See license details if applicable.

## ;))
