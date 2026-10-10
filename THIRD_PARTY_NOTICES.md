# Third-party notices

OSAVA is built from, and downloads, other people's work. This lists what is in the installer, what the
installed app fetches on the user's machine, and the licence each comes under. Package lists are generated
from the installed packages' own licence fields (`npm ls --omit=dev --all`); regenerate them when the
dependencies change.

## In the app window (bundled by Vite)

| Package | Version | Licence |
|---|---|---|
| @dimforge/rapier3d-compat | 0.12.0 | Apache-2.0 |
| @fontsource/ibm-plex-mono | 5.3.0 | OFL-1.1 |
| @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 |
| @gsap/react | 2.1.2 | SEE LICENSE AT https://gsap.com/standard-license |
| @tauri-apps/api | 2.11.0 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.7.1 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.5.4 | MIT OR Apache-2.0 |
| @tweenjs/tween.js | 23.1.3 | MIT |
| @types/stats.js | 0.17.4 | MIT |
| @types/three | 0.185.1 | MIT |
| @types/webxr | 0.5.24 | MIT |
| fflate | 0.8.3 | MIT |
| framer-motion | 12.42.2 | MIT |
| gsap | 3.15.0 | Standard 'no charge' license: https://gsap.com/standard-license. |
| meshoptimizer | 1.1.1 | MIT |
| motion | 12.42.2 | MIT |
| motion-dom | 12.42.2 | MIT |
| motion-utils | 12.39.0 | MIT |
| react | 19.2.7 | MIT |
| react-dom | 19.2.7 | MIT |
| scheduler | 0.27.0 | MIT |
| three | 0.185.1 | MIT |
| tslib | 2.8.1 | 0BSD |

Two of these are not OSI-approved open-source licences and are worth knowing about:

- **GSAP and @gsap/react** ship under GreenSock's "Standard 'no charge' licence"
  (<https://gsap.com/standard-license>): free to use and redistribute in an app like this one, but it is a
  custom licence, not MIT. GSAP is used for two interface effects (`src/Shuffle.tsx`,
  `src/PixelTransition.tsx`). If OSAVA should be wholly under an OSI licence, these are the two files to
  rework (the project already depends on `motion`, which is MIT).
- **Fonts** are under the SIL Open Font License 1.1, which allows bundling and redistribution: Pixelify Sans
  (`src/assets/fonts/OFL.txt`), and JetBrains Mono and IBM Plex Mono (the `@fontsource` packages, which carry
  their licence files). The UI no longer fetches fonts from Google at run time.

## In the backend sidecar (`osava-backend.exe`, bundled by esbuild and packaged by pkg)

| Package | Version | Licence |
|---|---|---|
| accepts | 2.0.0 | MIT |
| body-parser | 2.3.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| content-disposition | 1.1.0 | MIT |
| content-type | 2.0.0 | MIT |
| content-type | 1.0.5 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cors | 2.8.6 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| dotenv | 17.4.2 | BSD-2-Clause |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| encodeurl | 2.0.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| express | 5.2.1 | MIT |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| http-errors | 2.0.1 | MIT |
| iconv-lite | 0.7.2 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 1.1.0 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 3.0.2 | MIT |
| ms | 2.1.3 | MIT |
| negotiator | 1.0.0 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| parseurl | 1.3.3 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| proxy-addr | 2.0.7 | MIT |
| qs | 6.15.2 | BSD-3-Clause |
| range-parser | 1.2.1 | MIT |
| raw-body | 3.0.2 | MIT |
| router | 2.2.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setprototypeof | 1.2.0 | ISC |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| toidentifier | 1.0.1 | MIT |
| type-is | 2.1.0 | MIT |
| unpipe | 1.0.0 | MIT |
| vary | 1.1.2 | MIT |
| wrappy | 1.0.2 | ISC |

pkg embeds the Node.js runtime (MIT, <https://github.com/nodejs/node/blob/main/LICENSE>) in the executable.

## The desktop shell

Tauri 2 and its plugins (MIT or Apache-2.0) and the Rust crates they pull in; the exact set is `src-tauri/Cargo.lock`.

## Fetched on the user's machine at install time (not distributed with OSAVA)

Each is downloaded from its publisher and checked against a pinned SHA-256 (or, for Sysmon, a Microsoft
Authenticode signature) before it is used.

| Component | From | Licence | Note |
|---|---|---|---|
| llama.cpp `b11177` (`llama-server`) | github.com/ggml-org/llama.cpp | MIT | Vulkan build for Windows x64 |
| Sysmon | download.sysinternals.com | Microsoft Sysinternals Software License Terms | Installing it accepts these terms on the user's behalf; the Behaviour tab says so. OSAVA does not redistribute it. |
| Sysmon configuration (pinned commit) | github.com/SwiftOnSecurity/sysmon-config | no licence file detected by GitHub | Fetched from the author's public repository at install time; not redistributed. Check the upstream terms before bundling it. |
| ClamAV (optional, Security Hub) | github.com/Cisco-Talos/clamav | GPL-2.0 | The official installer is downloaded and run; OSAVA does not bundle or link it. |
| osava-smollm classifier (GGUF, Q4_K_M) | to be published; its address is recorded in `contract.json` | **not yet chosen** | A fine-tune of HuggingFaceTB/SmolLM3-3B (Apache-2.0). See below. |

### The classifier model

The base model, SmolLM3-3B, is Apache-2.0. The fine-tune was trained on Windows event data that includes
captures from EVTX-ATTACK-SAMPLES (<https://github.com/sbousseaden/EVTX-ATTACK-SAMPLES>, **GPL-3.0**), on
synthetic events, and on benign events recorded on the author's own machine. Before the weights are
published, decide and record: the licence they go out under (whether a model trained on GPL-licensed
captures needs to be GPL is not settled law; get a view you trust), and confirm that nothing identifying
from the author's own telemetry can be recovered from them.
