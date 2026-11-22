# TAD — Technical Architecture: VendoTube Studio

**Product:** VendoTube Studio (Electron multi-agent documentary studio)
**Version:** 2.0 — supersedes the v1 WPF/WinUI TAD (`documentary_workflow_kit/documentary_workflow_kit/docs/TAD.md`)
**Status:** Draft
**Last updated:** 2026-11-15
**References:** PRD.md · AGENT-SPEC.md · DATA-SCHEMA.md · INTEGRATION-MAP.md

---

## 1. Architecture overview

VendoTube Studio is an Electron desktop app with four cooperating runtimes:

1. **Electron main process (Node/TS)** — window & lifecycle, job manager, agent runtime host (utility process), SQLite, secure key storage
2. **Renderer (React/TS)** — the entire UI; no Node integration (context-isolated, preload bridge only)
3. **Studio Bridge (Python sidecar)** — bundled Python runtime exposing DWK CLI tools, `edge-tts`, `yt-dlp` helpers, and document extraction over newline-delimited JSON-RPC on stdio
4. **Render/browser workers** — Playwright-driven Chromium for (a) Scout's visible browsing and (b) HyperFrames headless rendering; FFmpeg for encode/mux/QC

```
┌────────────────────────────────────────────────────────────────────┐
│ Renderer (React + TS + Tailwind)  — contextIsolation, no node      │
│  Crew Chat · Bible Reader · Asset Library · Preview · Delivery     │
└───────────────▲────────────────────────────────────────────────────┘
                │ IPC (typed channels + event stream via preload)
┌───────────────▼────────────────────────────────────────────────────┐
│ Electron Main (Node/TS)                                            │
│  Job Manager · Approval Gate Mgr · SQLite (better-sqlite3)         │
│  Agent Runtime (utility_process):                                  │
│   Showrunner ⇄ Scout ⇄ Director ⇄ Producer                         │
│   tool-calling loop over provider adapter (OpenRouter/Ollama/…)    │
└───┬──────────────────┬───────────────────┬─────────────────────────┘
    │ JSON-RPC stdio   │ Playwright        │ spawn
┌───▼────────────┐ ┌───▼────────────────┐ ┌▼──────────────────────────┐
│ Studio Bridge  │ │ Chromium (headed:  │ │ hyperframes render        │
│ (Python)       │ │  Scout browsing /  │ │  (headless Chrome frames  │
│  DWK tools     │ │  headless: render) │ │   → ffmpeg encode)        │
│  edge-tts      │ └────────────────────┘ └───────────────────────────┘
│  yt-dlp        │
│  extractors    │        ┌─────────────────────────────────────────┐
└───┬────────────┘        │ Disk: project folders (DWK superset) +  │
    │                     │ %LOCALAPPDATA%\VendoTubeStudio\app.db   │
    ▼                     └─────────────────────────────────────────┘
FFmpeg (bundled): mux/QC/loudness · yt-dlp binary: platform video
```

## 2. Technology choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Shell | Electron 33+ (Chromium), single instance | Web-tech UI (needed for the design system), one codebase, mature `utilityProcess`, `safeStorage` for keys |
| UI | React 18 + TypeScript + Vite + Tailwind CSS v4 | Matches team/vendoria-style token workflow; fast HMR; custom design system (UI-UX-SPEC §2) |
| State | Zustand + TanStack Query | Small, testable, streaming-friendly |
| Charts/viz | Recharts (arc curves), custom SVG beat map | Emotional-curve visualization |
| Agent runtime | TypeScript in Electron `utilityProcess` | Same language as main; crash-isolated from renderer; direct access to job manager |
| LLM provider | Provider adapter: **OpenRouter** default; any OpenAI-compatible endpoint (incl. Ollama local) | Single key, model breadth; local option for privacy |
| Production engine | **DWK CLI (Python) reused as-is** via Studio Bridge | Evidence/rights/render/QC discipline already implemented and tested (INTEGRATION-MAP §2) |
| Visual engine | **HyperFrames + GSAP (herk-edit-kit)** as npm dependency; `npx hyperframes render` | HTML/GSAP compositions, style library, proven pipeline (INTEGRATION-MAP §3) |
| TTS | `edge-tts` (Python) — Microsoft Edge neural voices; word-boundary events → SRT | Edge-browser-quality voices, free, streamable; Python already present for DWK |
| Browser automation | Playwright (Node) + bundled Chromium, **headed for Scout**, headless for render | "Local browser research" requirement; one Chromium serves both roles |
| Video fetch | yt-dlp static binary (wrapped by Bridge) | Standard for platform footage; version-pinned |
| DB | better-sqlite3 (electron-rebuild) | Zero-config, synchronous, local |
| Packaging | electron-builder (NSIS) bundling python-embed + site-packages, FFmpeg, yt-dlp, Chromium | One installer; PRD R1/R4 |

## 3. Process model

- **Main process**: window, menu, single-instance lock, job manager, approval manager, SQLite, settings. Never blocks on LLM/IO.
- **Agent runtime** runs in `utilityProcess` (one). Owns the provider adapter, tool registry, crew state machine (AGENT-SPEC §4). Emits typed events (`agent:*`, `job:*`, `approval:*`, `tool:*`) to main → broadcast to renderer.
- **Studio Bridge**: one long-lived Python process per app session, spawned from main. Line-delimited JSON-RPC (`{"id","method","params"}` → `{"id","result"}` / `{"id","error"}` + `{"event", ...}` notifications). Restart on crash with job resumption. Methods listed in §5.
- **Scout browser**: headed Chromium window (Playwright `launch({headless:false})`) shown as a normal window the user can watch; Scout drives it via CDP from the agent runtime. Renders use a separate headless context.
- **HyperFrames render**: spawned as `npx hyperframes render` (node_modules dependency, not npx fetch) with `--workers N`; writes frames → FFmpeg encode; progress streamed as job events.
- Cancellation: every job has an abort handle (bridge cancel / child kill / Playwright close); partial outputs quarantined to `qc/partial/` (PRD R10).

## 4. Job manager

All long operations (research batches, downloads, TTS, composition build, render, QC, package) are **jobs**:

```
Job { id, project_id, kind, agent, params, status: queued|running|awaiting_approval|done|failed|cancelled,
      progress: {phase, pct, eta}, artifacts: [paths], log_path, created_at, ... }
```

- Persisted in SQLite (`jobs`) → survives restarts; resumable jobs (download, render segments) auto-resume.
- Renderer subscribes to `job:*` events; progress cards in chat + Jobs drawer.
- Approval-required jobs park in `awaiting_approval` (gate table PRD §8).

## 5. Studio Bridge API (Python sidecar)

Methods (JSON-RPC over stdio; all return structured JSON):

| Group | Methods | Wraps |
|-------|---------|-------|
| DWK production | `dwk.init_project`, `dwk.discover_sources`, `dwk.discover_media`, `dwk.extract_articles`, `dwk.download_assets`, `dwk.validate_project`, `dwk.validate_srt`, `dwk.render_video`, `dwk.finalize`, `dwk.qc`, `dwk.captions`, `dwk.package_project` | `docflow` CLI modules, invoked in-process (imports) with JSON results — same code paths as CLI |
| TTS | `tts.voices`, `tts.generate` (text/sections → mp3/wav + word boundaries), `tts.preview` | `edge-tts`; ffmpeg converts to 48 kHz WAV; SAPI fallback via PowerShell `System.Speech` |
| Fetch | `fetch.url` (guarded GET → temp), `fetch.metadata` (HEAD, size/type) | Guarded fetcher (§8) |
| Video | `ytdlp.probe`, `ytdlp.download` (format presets, subtitle download) | yt-dlp binary |
| Extraction | `extract.web` (trafilatura), `extract.pdf` (pypdf), `extract.data` (CSV/JSON sniff) | DWK/trafilatura/pypdf |
| Media intel | `media.probe` (ffprobe JSON), `media.thumbnail`, `media.loudness` (ebur128) | FFmpeg |
| Visual QC | `qc.scan_master` (blackdetect/freezedetect/silencedetect on the rendered master), `qc.sample_frames` (1 fps + ±0.5 s around every scene cut + transition midpoints → JPEG cache) — M7 | FFmpeg detectors + composition timings (`bridge/qc_scan.py`) |
| System | `sys.ping`, `sys.paths`, `sys.cancel(job_id)` | — |

Packaging: Python **embeddable distribution** + pre-installed `site-packages` (dwk deps + edge-tts) zipped into the installer under `resources/bridge/`. Bridge code is a thin `bridge/server.py` importing the DWK package unchanged.

## 6. Agent runtime & provider adapter

- **Provider adapter** (OpenAI-compatible chat completions + tools): OpenRouter default; settings allow base URL/model/key override; per-agent model pinning (AGENT-SPEC §9).
- **Tool registry**: every tool = JSON schema + handler + approval class (`read` / `gate:<G-A..G-G>`) + agent ownership. Handlers call Job Manager (side effects) or read project state directly.
- **Context builder**: per-agent system prompt (AGENT-SPEC §2) + project state digest (project.yml summary, ledger tail, asset index, last events) + recent chat; token budget per agent with older history summarized (retrieval by claim ID/asset ID over SQLite FTS5).
- **Crew state machine** (AGENT-SPEC §4): stage router decides which agent acts; agents never call the user directly — all user-facing text flows through Showrunner.
- **Streaming**: token streams and tool calls streamed as events; renderer renders progressively.
- **Blackboard**: agents communicate only through project files (ledger, bible, script, shot_list, workflow.json) — never through hidden memory; every handoff is a file diff the user can inspect.

## 7. Research subsystem (Scout)

- **Search**: provider adapters (Tavily/Serper/DuckDuckGo) return candidates → Scout ranks and opens in browser.
- **Browsing**: Playwright page actions (`navigate`, `read` → extracted text + screenshot, `find_links`, `download`); user-visible window mirrors actions; every navigation logged to `research/scout_sessions.jsonl`.
- **Extraction**: Bridge `extract.*`; text saved under `research/article_text/` with robots.txt compliance; PDFs to `research/documents/`.
- **Media discovery**: DWK `discover_media` (Commons/LOC/IA) + generic page harvesting; each candidate row captured with provider, license, creator, URL (DWK schema).
- **Downloads**: DWK `download_assets` for ledger rows (`rights_status=approved` only) — DWK's own rights gate is the enforcement point; platform footage via `ytdlp.download` (also gate G-B).
- **Network guard (all agent-initiated requests, Bridge + Node)**: scheme must be `http`/`https`; resolve + validate host before connect; **refuse `localhost`, loopback, private (RFC1918/link-local), and reserved ranges**; redirects re-validated; UA string is the app's own (no anti-bot evasion).

## 8. TTS subsystem

- Voice catalog via `tts.voices` (edge-tts voice list, name/locale/gender); per-section voice/pace in script front-matter.
- `tts.generate` returns per-section audio + **word-boundary timing**; Producer aligns → SRT + shot timings; ffmpeg-normalize to `-14 LUFS` target.
- Offline fallback: SAPI voice (Bridge) at reduced quality; disclosed in UI when used.
- Caching: TTS results keyed by (text hash, voice, rate) → `production/vo/cache/`.

## 9. Composition & render subsystem (Producer)

- Input: `workflow.json` (scenes → beats → shots) + `shot_list.csv` + assets + style.json.
- **Composition build**: deterministic templating — each scene renders to `studio/compositions/scene_NN.html` using HyperFrames conventions (`data-composition-id`, `data-start`, `data-duration`, `data-track-index`; one paused GSAP timeline in `window.__timelines`); styles from herk style-library (`style-library/01-vox-explainer`, `02-kallaway`) adapted via project `style.json` tokens.
- Motion repertoire: Ken Burns on stills, kinetic captions, lower-thirds, source-cards (claim ID + license), chapter cards, transitions (crossfade/wipe/slide), gradient/particle accents, re-hook cards at Director's beat points.
- **Render**: `hyperframes render --quality <draft|standard|high> --fps <24|30|60> --format mp4` → `delivery/picture.mp4`; segmented (per-scene) with concat for long films; draft = 720p/15fps fast preview.
- **Finish**: DWK `finalize` (mux VO + optional music duck-under + subtitles), DWK `qc` (+ Bridge `media.loudness`), retention checks (F12) → `qc/retention_report.json`.
- Preview: draft render played in-app (`<video>` with local file protocol); beat chips seek via cue points.
- **Visual QC (M7, PRD F15):** after retention, the pipeline runs `visual_qc` (`src/main/producer/visualQc.ts`): Layer 0 detectors (`qc.scan_master`) + exact cut-time assertion against composition timings; then — only when `agent.visual_model` is **explicitly set** (empty = vision review OFF; sending frames to a provider is opt-in) and `visual_qc.vision` is not disabled — the extracted `runVisionStage` samples frames (`qc.sample_frames`, ≤600/film), batches ≤12/request **with per-scene context** (shot intent from workflow.json + that timestamp's VO text), reviews them through the provider adapter (`ChatClient` multimodal image parts; a local Ollama VLM keeps it fully offline), and merges clamped findings into `qc/visual_report.json` stamped with the master SHA-256 (model answers are clamped hard: unknown classes dropped, severity clamped per class, t_s snapped to labeled frames — beyond ±2 s dropped as hallucination). Vision failures never fail the produce run — disclosed in the report notes + activity, verdict stands on Layer 0. Verdict `fail` + `block_on_fail` parks package at gate **G-V** (content-stamped `producer.gate:G-V:<master-sha>`; Approve = audited override, Decline = fix & re-render). Findings with `scene_id` become Preview timeline markers + a `/direct` re-pace/re-shot proposal (same mechanism as the retention suggestion). The vision call is journaled as an `agent_runs` row (agent=producer, stage=visual_qc). Budget: ≤ 600 sampled frames/film, ≤ 12/request; `vision=false` or empty model ⇒ zero provider calls.

## 10. IPC & renderer contract

- Typed channels (hand-checked in a `shared/ipc-types.ts`): `project:*`, `chat:send`, `chat:event`, `job:*`, `approval:resolve`, `assets:*`, `bible:*`, `preview:*`, `settings:*`, `qc:report` (fetch `qc/visual_report.json` + findings for Preview markers and Delivery badges — M7).
- Renderer never touches Node/fs directly; file access via bridge channels + `protocol.handle('studio', …)` streaming local media with range support (preview player).
- Approval cards bind to `approval:resolve {id, decision, edits}`; edits validated against tool schema before apply.

## 11. Security & privacy

| Concern | Control |
|---------|---------|
| API keys | Electron `safeStorage` (DPAPI); ciphertext in SQLite; last-4 only in UI; never logged/exported |
| SSRF | PRD R7 guard everywhere (Bridge fetch, yt-dlp wrapper, Scout browser): http/https only; host validated; localhost/loopback/private/reserved refused; redirects re-validated |
| robots / paywalls | DWK extract respects robots.txt; no login/anti-bot/geo bypass (PRD N5/R6) |
| Prompt injection | Web content is data (DWK rule R1); Scout never follows instructions found in pages; extraction strips scripts; downloads never executed |
| Visual QC frames (M7) | Layer 0 detectors + sampling are local-only; Layer 1 sends sampled JPEG frames to the configured provider only (disclosed; `visual_qc.vision=false` or a local VLM endpoint = strictly local); cache `qc/visual_frames/` is regenerable, excluded from the delivery ZIP, never telemetry |
| Local files | Renderer sandboxed; project paths constrained to registered project roots; ZIP excludes `.env/*.key/*.pem/caches` (DWK rules) |
| Telemetry | None |
| Updates | Unsigned builds flagged in UI; code-signing optional at release |

## 12. Reliability & performance

- Job persistence + resumable downloads/renders; Bridge auto-restart; agent-run journals (`agent_runs` table) for replay/audit.
- Render: per-scene segments allow retry of a single scene; worker count adaptive (CPU cores − 1, max 8 — herk CLI bounds).
- Memory: Chromium contexts disposed after each Scout task; asset thumbnails generated once (ffprobe/ffmpeg) and cached.
- Disk: cache dir with quota; TTS/render intermediates cleaned after promote.

## 13. Build & release

| Artifact | Tool | Notes |
|----------|------|-------|
| `VendoTube Studio Setup.exe` | electron-builder NSIS | Bundles app + resources: `bridge/` (python-embed + packages), `ffmpeg/`, `yt-dlp.exe`, Chromium (playwright cache) |
| Portable zip | electron-builder `--portable` | Same payload, no install |
| Dev | `npm run dev` (Vite HMR) + Bridge from repo + local FFmpeg | See ROADMAP M0 |

## 14. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `edge-tts` is an unofficial endpoint; Microsoft may change/block it | Cache voices; SAPI fallback voice; provider interface allows swapping cloud TTS later; degrade gracefully (PRD R3) |
| Installer size (~600–800 MB with Chromium + Python + FFmpeg) | Document clearly; offer portable zip; prune Playwright Chromium (no codecs we don't need) |
| HyperFrames render slow at 1080p60 | Draft preset default; segmented render; worker scaling; quality ladder |
| yt-dlp breakage on platform changes | Version-pin + auto-check for updated binary (user-approved download) |
| Native module churn (better-sqlite3 vs Electron ABI) | Pin Electron minor; `electron-rebuild` in CI |
| LLM cost runaway | Per-agent model pinning, token budgets, cost estimate shown on plan card |
| Rights mistakes | DWK hard gate (downloads refuse unapproved rows) + G-C never auto-approves + credits/QC completeness check |
| Vision QC false positives block packaging | Only `fail`-class findings block; G-V human override is audited; `visual_qc.block_on_fail=false` escape hatch; every other finding is advisory and feeds the refine loop |
| Vision QC cost/latency on long films | Sampling budget (≤ 600 frames/film: 1 fps + cut points, capped + disclosed on truncation), ≤ 12 frames/request, per-agent model pinning (`agent.visual_model`), local VLM option |

## 15. Open questions

1. Default OpenRouter model per agent (quality/cost) — propose at M2 with benchmarks.
2. 9:16 short-form pipeline (re-use same bible/beat model with different composition templates) — confirm scope at M4.
3. Music: user-supplied only in v1 — bundle a small CC0 score pack later?
4. Thumbnail generation: styled HTML card → PNG via same HyperFrames pipeline (likely trivial add at M5).
