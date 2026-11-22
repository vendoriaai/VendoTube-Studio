# Third-party notices — VendoTube Studio

Third-party components this app bundles or executes, with their licenses. This file
ships with the distribution (electron-builder `extraResources`).

| Component | License | How it is used | Source |
|-----------|---------|----------------|--------|
| documentary_workflow_kit (DWK / `docflow`) | MIT | imported in-process by the Studio Bridge (evidence ledger, rights gates, render/finalize/QC/package) | `../documentary_workflow_kit/` |
| HyperFrames CLI (`hyperframes`) | Apache-2.0 | npm dependency; renders compositions via headless Chrome + FFmpeg | npm `hyperframes` |
| GSAP | GSAP standard no-charge license | npm dependency; animation timelines inside compositions | npm `gsap` |
| herk-edit-kit style library | MIT (kit) + kit use-permission notice (retain when redistributing) | design tokens/layouts adapted into the Studio composition templates (`01-vox-explainer`, `02-kallaway` DESIGN.md/tokens) | `../herk-edit-kit-main/` |
| edge-tts | GPL-3.0 | executed as an independent Python subprocess by the Studio Bridge (aggregation, not linking); Microsoft Edge neural voices via an unofficial endpoint | https://github.com/rany2/edge-tts |
| Fraunces, Archivo, Plus Jakarta Sans, Inter | SIL OFL | vendored latin woff2 subsets (`assets/fonts/`), used by renders and thumbnails | Google Fonts |
| Natural Earth 110m land | Public domain | rasterized once into a compact land dot-mask (`src/main/producer/world-mask.ts`) for the animated map card; the render is offline | https://www.naturalearthdata.com/ |
| yt-dlp | Unlicense/Public domain | external runtime binary on PATH (not redistributed in the dev milestone) | https://github.com/yt-dlp/yt-dlp |
| FFmpeg / FFprobe | LGPL-2.1 (build: GPL variant) | external runtime binaries on PATH | https://ffmpeg.org |
| React, Electron, better-sqlite3, playwright-core, yaml, vitest, electron-builder | MIT / Apache-2.0 / BSD etc. | npm dependencies | npm |

Project code: see LICENSE in this repository.
