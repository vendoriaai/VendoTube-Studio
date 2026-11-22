<div align="center">

<img src="Logo/vendotube-logo-aurora%20no%20bg.png" alt="VendoTube Studio logo" width="180"/>

# VendoTube Studio

An Electron desktop app where a crew of AI agents turns one sentence into a publish-ready YouTube documentary — with evidence-led research, rights-safe assets, and motion-graphics-grade rendering.

[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows11&logoColor=white)](#-develop)
[![Built with Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/tests-333%20passing-22C55E)](#-develop)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![License](https://img.shields.io/badge/license-MIT-8B5CF6)](LICENSE)

**One brief → three specialists → one film**

</div>

---

## 🕵️ The crew

| | Agent | What it does |
|---|---|---|
| 🌐 | **Scout** | Researches the live internet in a visible local browser and harvests documents, images, footage, audio, and data into a rights-aware asset library. |
| 🎬 | **Director** | Studies the evidence and writes the *Documentary Bible*: narrative arc, scene-by-scene scenario, visual language, and the emotional curve — what must be shown, what the viewer must feel — plus the executable workflow. |
| 🎞️ | **Producer** | Executes it: neural narration (Microsoft Edge voices), HTML/GSAP motion-graphics compositions, headless-Chrome + FFmpeg render, QC, and a delivery pack with a YouTube metadata kit. |

## ✨ Highlights

- **Showrunner autopilot** — type one sentence and the crew runs end-to-end: research → film design → draft preview, with the media-rights gate kept human.
- **Design systems, not templates** — seven presets that are real layout languages (Swiss editorial grid, forensic case file, newsprint broadsheet, cinematic noir, vivid explainer, clean data, premium glass), each with its own typography, panel geometry, media treatment and furniture.
- **Voice-over-first editing** — the narration drives the cut: word-level timings align every scene, card and animation to what is actually being said.
- **Motion graphics built in** — animated charts, chronological timelines, location maps, and reconstructed article clippings, all rendered offline.
- **Visual QC** — deterministic ffmpeg detectors plus optional sampled vision review watch the finished master; a failed cut parks the delivery behind a human gate.
- **Local-first & honest** — projects live on your disk, no telemetry, every claim traceable to evidence.

> **Status:** all milestones M0–M7 implemented and verified — full pipeline, Showrunner autopilot, documentary-craft and visual-direction passes, layout-fit/duo, media treatment, motion graphics, narration-timed cut, visual QC, and installer packaging. **333 unit tests green.** Docs: [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) · [`docs/PRIVACY.md`](docs/PRIVACY.md) · [`docs/METRICS.md`](docs/METRICS.md).

## 🏗️ Built on three projects in this workspace

- [**DWK CLI toolkit**](../documentary_workflow_kit/) — evidence discipline, rights gates, render/QC
- [**Herk Edit Kit**](../herk-edit-kit-main/) — HyperFrames + GSAP visual engine, style library
- [**NVIDIA deep-researcher-agent**](../deep-researcher-agent-release-2.2/) — research architecture reference; optional v2 MCP plugin

## 🚀 Develop

```bash
npm install        # postinstall fetches the better-sqlite3 Electron prebuild
npm run dev        # Vite HMR dev app
npm test           # unit tests (job restart safety, bridge protocol)
npm run typecheck  # tsc over main/preload/shared + renderer
npm run build && npm run smoke   # exit-criteria harness (exit 0 = pass)
python bridge/test_bridge.py     # standalone Studio Bridge round-trip
```

## 📚 Documentation

Read in this order:

| Doc | Contents |
|-----|----------|
| [PRD](docs/PRD.md) | Vision, goals/non-goals, features F1–F14, approval gates, requirements, success metrics |
| [TAD](docs/TAD.md) | Electron + Python-bridge architecture, process model, job system, security, build/release, risks |
| [UI-UX-SPEC](docs/UI-UX-SPEC.md) | "Aurora Studio" design language (dark screening-room), layout, all six stage screens, components |
| [AGENT-SPEC](docs/AGENT-SPEC.md) | Crew model, system prompts, tool catalogs, orchestration state machine, model routing, evaluation rubric |
| [DATA-SCHEMA](docs/DATA-SCHEMA.md) | Project folder v2 (DWK superset), bible.md / beats.json / workflow.json formats, SQLite schema |
| [INTEGRATION-MAP](docs/INTEGRATION-MAP.md) | Exactly what is reused/wrapped/referenced from each source project |
| [ROADMAP](docs/ROADMAP.md) | Milestones M0–M7 with exit criteria; M3 = first end-to-end film |

## ⚖️ Ground rules (inherited from DWK)

> Every factual claim maps to an evidence ledger entry · rights approval is human-gated and never auto-granted · robots.txt and access controls respected · every side effect (download/TTS/render/package) requires explicit approval · render cadence and upscaling disclosed honestly · no telemetry; projects stay on disk.

---

<div align="center">

Licensed under [MIT](LICENSE) · built by the VendoTube Studio contributors

</div>
