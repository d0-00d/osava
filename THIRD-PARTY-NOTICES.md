# Third-Party Notices

osava itself is distributed under the MIT License (see `LICENSE`). It also
redistributes the following third-party software.

## KicomAV

- **Upstream:** https://github.com/hanul93/kicomav
- **License:** GNU General Public License v2.0
- **Bundled as:** `src-tauri/vendor/k2.exe`, installed to `resources/kicomav/k2.exe`
- **Version built:** _TODO — record the upstream tag or commit this binary was built from._

`k2.exe` is a PyInstaller build of the upstream KicomAV command-line scanner. It
is invoked by osava as a separate process; osava does not link against KicomAV
and is not a derivative work of it.

Because this binary is redistributed in the osava installer, GPL v2 obligations
apply to the binary itself:

- The full GPL v2 text must ship alongside it — _TODO: add `licenses/KicomAV-GPLv2.txt`._
- Corresponding source must be made available for the exact version built.
  Recording the upstream commit above and linking to it satisfies this in the
  common case; if upstream ever becomes unavailable, a source archive must be
  offered directly.
- Upstream copyright notices must be preserved.

This file is a good-faith compliance record, not legal advice.
