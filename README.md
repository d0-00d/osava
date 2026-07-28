# Osava - open sourec anti virus application (<- honestly a platform would be a better word but idk)

**Osava** is a modern Windows desktop security dashboard built with [Tauri v2](https://tauri.app/), React 19, TypeScript, and Express. It provides system security monitoring, email breach lookups, ClamAV antivirus management, and custom scan/definition update workflows in a desktop interface.

---

## (✦_✦) Key Features

- **Security Dashboard**: Monitor real-time Windows Security Center status including active Antivirus software and Windows Firewall states across Domain, Private, and Public profiles.
- **Email Breach Checker**: Verify if email addresses have been compromised in data breaches.
- **Security Hub (ClamAV Manager)**: Check installation status, download, install, or uninstall ClamAV directly through MSI setup automation.
- **AV Console**: Perform ClamAV definition updates (`freshclam`), run custom directory or system scans (`clamscan`), and view live output logs.

---

## Repository Structure

```text
osava/
├── src/               # React + TypeScript Frontend UI
├── backend/           # Standalone Express API backend (bundled via esbuild + pkg)
├── src-tauri/         # Tauri v2 Rust application layer & installer bundle configuration
│   ├── binaries/      # Compiled sidecar executable (osava-backend.exe)
│   └── target/release/bundle/ # Generated .msi and .exe installers
├── public/            # Static assets
├── package.json       # Root scripts and frontend dependencies
├── README.md          # Project documentation
└── vite.config.ts     # Vite configuration
```

---

## Installation & Pre-built Installers

When compiled, Osava produces standalone Windows installer packages located in `src-tauri/target/release/bundle/`:

| Installer Format | File Name | Location | Description |
| :--- | :--- | :--- | :--- |
| **MSI Package** | `osava_0.1.0_x64_en-US.msi` | `src-tauri/target/release/bundle/msi/` | Windows Installer package suitable for standard or enterprise deployment. |
| **Executable Setup** | `osava_0.1.0_x64-setup.exe` | `src-tauri/target/release/bundle/nsis/` | NSIS interactive setup installer. |

---

## Requirements & Development Setup

### System Requirements

- **OS**: Windows 10 or Windows 11 (required for Windows Security Center & PowerShell queries)
- **Node.js**: v20+ LTS
- **Package Manager**: `npm`
- **Rust Toolchain**: Required for compiling Tauri desktop application (`cargo`, `rustc`)

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

### Running in Development Mode

To run the full desktop application in development mode with hot-reloading:

```bash
# From the root directory:
npm run dev
```

To run backend and frontend web servers separately:

```bash
# Terminal 1: Backend API (http://localhost:4000)
cd backend
npm run dev

# Terminal 2: Frontend Vite App (http://localhost:1420)
cd ..
npm run dev
```

---

## Building `.msi` and `.exe` Installers

To compile the backend sidecar executable, build the React frontend production bundle, and generate both `.msi` and `.exe` installers, run:

```bash
npm run tauri build
```

### What happens during `npm run tauri build`:

1. **Backend Compilation (`npm run build:backend`)**:
   - `esbuild` bundles `backend/src/index.ts` into `dist/backend.cjs`.
   - `@yao-pkg/pkg` compiles `backend.cjs` into `src-tauri/binaries/osava-backend-x86_64-pc-windows-msvc.exe`.
2. **Frontend Build (`npm run build`)**:
   - `tsc` checks TypeScript types and `vite build` bundles the frontend into `dist/`.
3. **Tauri Bundling (`tauri build`)**:
   - Rust compiles the native wrapper (`src-tauri`).
   - WiX toolset compiles `osava_0.1.0_x64_en-US.msi`.
   - NSIS toolset compiles `osava_0.1.0_x64-setup.exe`.

---

## Backend API Endpoints

The internal Express backend (listening on `http://localhost:4000`) exposes:

- `GET /health` — Health check status
- `GET /api/system-status` — Antivirus and Firewall status via PowerShell `Get-CimInstance`
- `GET /api/check-email/:email` — Email breach check integration
- `GET /api/install-status` — ClamAV installation check (`~\.osava\install-status.json`)
- `POST /api/install-status` — Trigger ClamAV MSI installer download and execution
- `POST /api/uninstall` — Trigger ClamAV uninstallation
- `POST /api/av/update` — Execute `freshclam` definition update
- `POST /api/av/scan` — Execute `clamscan` on target paths

---

## License

This project is open-source. See license details if applicable.
