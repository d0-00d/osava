# Testing the built app

`npm run unit` cannot see what only the built, installed app does: the backend is started by the window and is
not listening yet when the page loads, the window can be killed rather than closed, a user opens it twice. These
scripts run the real thing on Windows and judge what a person would meet. They found three bugs the unit tests
could not (see the changelog for Alpha v0.3).

They need Windows 10/11, Node 22+ on the `PATH` (for its built-in `WebSocket`), and OSAVA **not running**
(they stop every OSAVA process when they finish, and refuse to start otherwise). Nothing here presses *Install
Sysmon*, which would raise an administrator prompt, or starts monitoring.

## `final-test.ps1`: the built app

```powershell
.\scripts\release-test\final-test.ps1 -App .\src-tauri\target\release\osava.exe
```

1. **A plain launch.** The app starts its own backend. Nothing is clicked except *Launch*. The sidebar has every
   tab this PC has data for (AV Console if ClamAV is installed, Threats and Scan History if there is scan
   history), System Health never claims nothing is installed, no request fails, no console error is logged, and
   the window talks only to its own origin and `localhost:4000`.
2. **A second launch** exits by itself and leaves one window and one backend.
3. **Closing the window** leaves no `osava.exe`, `osava-backend.exe` or `llama-server.exe`, and frees port 4000.
4. **Killing the app** (Task Manager, a crash) takes the backend with it within seconds.
5. The backend's log (`%USERPROFILE%\.osava\backend.log`) says it started and why it stopped.

It drives the window through WebView2's debugging port (9223), so that port must be free too. Screenshots and a
scratch browser profile go to `%TEMP%\osava-release-test`.

## `installer-test.ps1`: the NSIS setup

```powershell
.\scripts\release-test\installer-test.ps1 -Setup .\src-tauri\target\release\bundle\nsis\osava-installtest_0.3.0_x64-setup.exe
```

Checks that the setup asks for no administrator rights (it reads the manifest first, so a prompt nobody answers
cannot hang it), installs silently for the current user, registers itself under the current user only, makes its
shortcut, and that the **installed** copy passes `final-test.ps1`. Then it installs again over a copy that is
running, uninstalls, and checks the program files, the registry entry and the shortcut are gone, that
`%USERPROFILE%\.osava` was left alone, and that any OSAVA that was already on the PC is exactly as it was.

**On a PC that already has OSAVA installed**, do not run the real setup: it has the same product name and would
upgrade that install, and the uninstall step would remove it. Build the same commit with a different identity
and run that:

```text
src-tauri/tauri.conf.json:  "productName": "osava-installtest",  "identifier": "com.<you>.osava.installtest"
npm run tauri build -- --bundles nsis
```

(`-Match` and `-Identifier` default to those names; change them if you used others.) **On a clean PC or VM**, run
the real setup with `-Match osava`.

The `.msi` is not covered: it installs for every user and needs administrator rights.
