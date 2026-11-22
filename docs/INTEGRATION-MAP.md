# Integration Map — source projects → VendoTube Studio

**Product:** VendoTube Studio
**Version:** 2.0
**Status:** Draft
**Last updated:** 2026-11-10

How the three existing projects in this workspace are reused, wrapped, or consulted. Nothing in the source projects is modified; all integration is additive (wrappers/imports in the new app).

---

## 1. Summary

| Source project | Reuse mode | What it provides |
|----------------|-----------|------------------|
| `documentary_workflow_kit` (DWK CLI) | **Bundle & wrap as-is** (Python sidecar) | Production spine: evidence ledger, rights-gated downloads, shot list, render/finalize/QC, packaging |
| `herk-edit-kit-main` (Herk Edit Kit) | **npm dependency + design/prompt assets** | HyperFrames HTML/GSAP render engine, style library, motion philosophy, storytelling/editing skill guidance |
| `deep-researcher-agent-release-2.2` (NVIDIA AI-Q) | **Reference architecture now; optional MCP plugin later** | Research agent patterns (intent/clarify/planner/workers/writer, citation verification); standalone MCP server |

## 2. DWK CLI (documentary_workflow_kit)

- **Reused verbatim** — `docflow` modules imported in-process by the Studio Bridge (TAD §5). CLI contract stays runnable (`documentary_workflow_kit/AGENTS.md` Local Contracts) so Studio and CLI remain interchangeable on the same project folders.
- Commands used by agents: `init, discover, sources, extract, download, validate, render, finalize, qc, captions, package` (`tts` is bypassed — Studio uses edge-tts instead of SAPI; SAPI remains the offline fallback).
- **Why not reimplement:** the evidence ledger, rights hard-gate, frame-contiguous shot model, and QC are the trust core of the product; they are tested and battle-defined.
- **Thin additions (in Studio, not in DWK):** multi-source media discovery beyond Commons/LOC/IA (generic page harvesting), yt-dlp footage fetching (parallel to DWK downloader, same approval gate), edge-tts narration with word timings feeding DWK's subtitle/validate path.

## 3. Herk Edit Kit (herk-edit-kit-main)

- **`hyperframes` npm package + GSAP** added as dependencies of the Electron app; Producer emits compositions in HyperFrames conventions (data-attributes + paused timelines in `window.__timelines`); render via its CLI (`--workers`, `--quality`, `--fps`, `--format`) with bundled Chromium + FFmpeg.
- **`style-library/`** (406 draft cards, 2 styles: `01-vox-explainer`, `02-kallaway`) bundled read-only as the template source for title cards, lower-thirds, kinetic captions, source-cards, chapter cards; `style.json` tokens parameterize them per project (DATA-SCHEMA §6).
- **Docs → prompt material:** `MOTION_PHILOSOPHY.md`, `docs/EDITING-PLAYBOOK.md`, `docs/STORYTELLING-WORKBOOK.md`, and the `video-storytelling` / `motion-showreel` / `short-form-edit` skill texts are adapted into Director/Producer prompt guidance (short verbatim excerpts, credited).
- **Not reused v1:** its transcription/ElevenLabs/Kie.ai integrations (Whisper local transcription is a candidate for v2 captions-from-footage), its example `video-projects/` (287 MB — excluded from the bundle).
- **License note:** verify the kit's LICENSE terms for bundling its style library in a distributed app before M4 release.

## 4. NVIDIA deep-researcher-agent (AI-Q Blueprint 2.2.1)

- **v1: reference only.** Its architecture informs Scout's shape: intent/depth classification, human-in-the-loop clarifier (mirrored by Showrunner plan approval), planner→concurrent workers→writer split (mirrored by Scout tasks), and citation verification (mirrored by DWK ledger + validation). It is **not bundled** — it requires the NAT 1.8 runtime, NIM endpoints, and optionally Postgres/OpenSearch: too heavy for a desktop installer (PRD N7).
- **v2 (optional plugin): "Deep Research mode".** The repo ships a standalone MCP server (`mcp/`, `aiq-mcp-server`). Studio can add an MCP client that runs it as an external service for users who want NIM-grade deep research; results would be normalized into `sources.csv`/`evidence_ledger.csv` so Director is agnostic to the research backend.
- **Code we may borrow patterns (not code) from:** citation verification logic (`src/aiq_agent/common/citation_verification.py`) as a spec for a Studio-side claim re-checker; intent classifier prompt design for Showrunner.

## 5. New code (what we actually build)

| Component | Language | Notes |
|-----------|----------|-------|
| Electron shell + UI (design system, 6 stages) | TS/React | UI-UX-SPEC |
| Agent runtime, provider adapter, tool registry | TS | AGENT-SPEC |
| Studio Bridge (`bridge/server.py`) | Python | JSON-RPC stdio; imports DWK + edge-tts |
| Composition builder (workflow.json → scene HTML) | TS | Templates = herk style library |
| Retention checker | TS + ffmpeg | DATA-SCHEMA §7 |
| Jobs/approvals/SQLite | TS | TAD §4 |
| Installers/bundling | electron-builder | TAD §13 |

## 6. Supersession notes

- The v1 **DWK Desktop chatbot specs** (`documentary_workflow_kit/documentary_workflow_kit/docs/`) describe a WPF single-agent chatbot; VendoTube Studio v2 supersedes that product plan (Electron, crew model, Edge TTS, HyperFrames visuals). The v1 docs remain useful for tool schemas and gate design; where they conflict with this suite, **v2 wins**.
- DWK **CLI toolkit contracts are unchanged and remain binding**.
