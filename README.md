# Osava

Osava is a Windows-focused desktop security dashboard built with Tauri, React, and TypeScript. It combines a local backend service with a React frontend to provide:

- system protection status monitoring (antivirus and firewall)
- email breach checking
- ClamAV installation/uninstallation management
- antivirus definition updates and file scanning via an AV console

## Project Structure

- `/src` — React frontend application
- `/backend` — standalone Node/Express API used by the frontend
- `/src-tauri` — Tauri configuration and Rust runtime files
- `/public` — static assets for the frontend

## Features

- `Dashboard` shows Windows Security Center antivirus and firewall status
- `EmailCheck` queries a breach-check API for a supplied email address
- `SecurityHub` installs or uninstalls ClamAV and tracks install state
- `AvConsole` updates definitions, launches scans, and streams console logs
- local backend health and install status endpoints consumed by the frontend

## Requirements

- Node.js 20+ (or compatible LTS)
- Yarn or npm
- Rust toolchain (for Tauri desktop builds)
- Windows 10/11 for full security center and ClamAV integration

## Setup

1. Install dependencies for the root app:

   ```bash
   cd c:\Users\Ayush\osava
   npm install
   ```

2. Install backend dependencies:

   ```bash
   cd backend
   npm install
   ```

3. Ensure the backend is available on `http://localhost:4000` before using the frontend.

## Running Locally

### Start the backend

```bash
cd backend
npm run dev
```

The backend exposes these key endpoints:

- `GET /health` — health check
- `GET /api/system-status` — antivirus/firewall status
- `GET /api/check-email/:email` — email breach lookup
- `GET /api/install-status` — ClamAV install state
- `POST /api/install-status` — install ClamAV
- `POST /api/uninstall` — uninstall ClamAV
- various `/api/av/*` endpoints for scan/update operations

### Start the frontend

```bash
cd c:\Users\Ayush\osava
npm run dev
```

Then open the Vite development URL shown in the terminal.

## Tauri Build

Once the frontend and backend are ready, build the desktop app with:

```bash
npm run build
npm run tauri build
```

> Note: Tauri packaging may require additional Rust components and platform-specific setup.

## Usage

- Use the navigation buttons to switch between Email Check, Dashboard, Security Hub, and AV Console.
- `EmailCheck` requires a valid email address and uses the backend API to check breaches.
- `Dashboard` queries Windows Security Center and firewall profiles.
- `SecurityHub` installs or removes ClamAV and stores install status in `~\.osava\install-status.json`.
- `AV Console` can update definitions, run scans, and display log output.

## Notes

- The project is currently tailored for Windows and uses PowerShell commands for system queries and installer management.
- ClamAV installation is performed via MSI and requires administrator privileges.
- The frontend expects the backend at `http://localhost:4000`.

## Development Tips

- Keep the backend running while testing React UI flows.
- If the backend cannot be reached, check that `npm run dev` is active in `/backend`.
- Use the `SecurityHub` tab to refresh ClamAV install status after installing or uninstalling.

## License

This repository does not specify a license. Add one if you intend to share or publish the project.
