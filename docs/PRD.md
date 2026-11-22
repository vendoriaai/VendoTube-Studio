# PRD — VendoTube Studio

**Product:** VendoTube Studio (Electron multi-agent documentary studio)
**Version:** 2.0 — supersedes the v1 "DWK Desktop / VendoTube" WPF chatbot PRD (`documentary_workflow_kit/documentary_workflow_kit/docs/PRD.md`)
**Status:** Draft
**Last updated:** 2026-11-15
**Companion docs:** TAD.md · UI-UX-SPEC.md · AGENT-SPEC.md · DATA-SCHEMA.md · INTEGRATION-MAP.md · ROADMAP.md

---

## 1. Vision

One desktop app in which a small crew of AI agents produces a publish-ready YouTube documentary from a single sentence.

> "Make a 10-minute documentary about the lost city of Cahokia for YouTube."
>
> → **Scout** browses the real internet in a visible browser, harvesting articles, documents, images, footage, and audio into a rights-aware evidence library.
> → **Director** studies everything and writes the *Documentary Bible*: the story, the visual language, the emotional curve — what must be shown and what the viewer must feel — plus a shot-level workflow.
> → **Producer** executes the workflow: narration in high-quality neural voices (Edge TTS), motion graphics and VFX via HTML/GSAP compositions, a frame-accurate render, QC, and a delivery pack.

The user feels they are operating an **ultimate yet simple** studio: one chat, one library, one render button — with full evidence, rights, and approval discipline underneath (inherited from the Documentary Work Kit).

**What it combines (source projects):**

| Source | Contribution |
|--------|--------------|
| `deep-researcher-agent-release-2.2` (NVIDIA AI-Q Blueprint) | Research-agent architecture patterns: intent classification, clarifier, planner/worker/writer roles, citation verification. Optional "Deep Research" plugin via its MCP server. |
| `documentary_workflow_kit` (DWK CLI) | The production spine: evidence ledger, rights-gated downloads, shot list, render, finalize, QC, delivery. The CLI is reused as-is. |
| `herk-edit-kit-main` (Herk Edit Kit / HyperFrames) | The visual engine: HTML+GSAP compositions, motion-graphics style library, silence/mistake cutting, storytelling structure, headless-Chrome + FFmpeg rendering. |

## 2. Problem statement

Producing a credible, watchable documentary video today requires stitching together: research tools, evidence notes, rights checks, scriptwriting, TTS, screen recorders, After Effects/Premiere, and YouTube packaging. Each handoff loses context, and AI tools either hallucinate sources or produce unwatchable slideshows.

VendoTube Studio removes the handoffs: a crew of specialized agents works on a shared project folder, keeps an auditable evidence trail, uses real browser research and real downloadable assets, and renders motion-graphics-grade video — with the user approving every consequential step.

## 3. Goals & non-goals

### Goals

| # | Goal |
|---|------|
| G1 | Single Windows installer (Electron `.exe`); no Python, FFmpeg, Node, or browser-setup knowledge required |
| G2 | One conversation drives the whole pipeline; a visible crew (Scout / Director / Producer) does the work |
| G3 | Scout researches with a real local browser (visible browsing) and downloads documents, images, video, audio, and data into a per-project asset library |
| G4 | Director produces a complete Documentary Bible: narrative arc, scene-by-scene scenario, visual & emotional specification ("what must be shown / what the viewer must feel"), retention beats, and an executable workflow |
| G5 | Producer generates narration with high-quality neural TTS (Microsoft Edge voices via `edge-tts`), synchronized subtitles, and motion-graphics compositions (HyperFrames + GSAP + style library) |
| G6 | Renders 1080p (optionally 4K) MP4 via headless-Chrome frame capture + FFmpeg; draft/standard/high quality presets |
| G7 | DWK evidence discipline is fully preserved: sources.csv, evidence_ledger.csv, rights-gated downloads, shot list, validation, QC report |
| G8 | Every side effect (download, TTS, render, package) is approval-gated; every agent action is visible and auditable |
| G9 | In-app preview player, asset browser with thumbnails, and Documentary Bible reader — no external tools needed for review |
| G10 | Delivery pack: final MP4, subtitles, credits/evidence, and a YouTube metadata kit (titles, description + chapters, tags, thumbnail concepts) |

### Non-goals (v1)

| # | Non-goal |
|---|----------|
| N1 | Publishing/uploading to YouTube directly (metadata kit only) |
| N2 | Timeline drag-and-drop editing (timeline is generated; user edits via script/beat/shot edits and re-runs) |
| N3 | Voice cloning; cloud TTS other than Edge voices |
| N4 | macOS/Linux builds (Windows first; architecture stays portable) |
| N5 | Paywall/login/anti-bot circumvention; robots.txt evasion |
| N6 | AI video generation ( Veo/Sora style) — visual material comes from discovered assets + motion graphics |
| N7 | Bundling the full NVIDIA NAT/NIM deep-researcher stack (offered later as an optional MCP plugin — see INTEGRATION-MAP.md §4) |

## 4. Personas

| Persona | Needs |
|---------|-------|
| **Creator** (primary) | Publishes documentary/educational YouTube videos without editing skills; wants high retention, honest sources, fast turnaround |
| **Researcher / archivist** | Traceable sources, evidence ledger, license provenance, credit export |
| **AI-automation user** | Watches agent activity, inspects tool calls, wants control via approvals and editable artifacts |

## 5. The crew (summary — full spec in AGENT-SPEC.md)

| Agent | Role | Key outputs |
|-------|------|-------------|
| **Showrunner** | Orchestrator & single chat voice: intake, clarification, task routing, approvals, summaries | plan, gate decisions, progress digests |
| **Scout** (Researcher) | Visible local-browser research; harvests documents, images, video, audio, data; builds evidence + asset library | `sources.csv`, `evidence_ledger.csv`, `assets_to_download.csv`, `research/` |
| **Director** (Scenario) | Analyzes all evidence & assets; writes the Documentary Bible and executable workflow | `bible.md`, `beats.json`, `script.md`, `shot_list.csv`, `workflow.json` |
| **Producer** (Production) | Executes the workflow: TTS, compositions, motion graphics, render, mix, QC, package | `vo/*.mp3|wav`, `compositions/*.html`, `documentary.mp4`, `qc/`, delivery ZIP |

The user only ever talks to the Showrunner; each crew member has a live activity stream in the UI.

## 6. Core features (v1)

### F1 — Projects & workspace
- New-project brief wizard: topic, audience, tone, language, target runtime (optional — empty "Auto" = the Director decides the runtime from the research and records the reason in the bible), aspect (16:9 / 9:16), resolution/fps, commercial intent, style preset
- Project folder (portable, DWK-superset layout — DATA-SCHEMA.md §2); recent projects; drag-and-drop open

### F2 — Crew chat (Showrunner)
- Single chat: user briefs, asks, edits; Showrunner routes to crew
- Message types: text, plan card, tool-call card, approval card, progress card, artifact link, diff preview
- @scout/@director/@producer mentions to address a specific agent
- Full history persisted locally (SQLite)

### F3 — Scout: visible browser research
- Bundled Chromium window the user can watch/focus; Scout navigates, reads, extracts (trafilatura/pypdf), and takes structured notes
- Search via configured providers (Tavily/Serper/DuckDuckGo) + direct URL follow
- Harvest types: web text, PDFs, images, video (yt-dlp), audio, structured data (CSV/JSON); every item registered with provenance
- Rights-aware: open-license discovery (Commons/LOC/Internet Archive) + license capture on every asset; robots.txt respected; no paywall/login bypass
- Network guard: `http(s)` only; host validated; `localhost`/loopback/private/reserved addresses refused

### F4 — Asset library
- Grid view of all project assets (images, footage, audio, documents, data) with thumbnails, duration, size, license badge, SHA-256, source link
- Preview (image/video/audio), filter by type/license/status, bulk approve for download

### F5 — Evidence & sources (DWK-compatible)
- sources.csv + evidence_ledger.csv exactly per DWK schema; claim IDs `(CLM001)` flow into script, shot list, and subtitles source-cards
- Ledger viewer with claim→source→asset cross-links; confidence & caveats surfaced in chat

### F6 — Director: Documentary Bible
- `bible.md`: thesis, narrative arc (hook → context → evidence & counterpoint → turn → payoff), scene-by-scene scenario with per-scene visual language, mood, music/sound direction, on-screen text plan
- `beats.json`: machine-readable emotional curve — per-beat emotion (curiosity/tension/surprise/payoff), intensity, target duration, re-hook points, pattern interrupts
- "Viewer feeling" contract: every scene states intended emotion + why the viewer keeps watching

### F7 — Script & narration (Edge TTS)
- Evidence-mapped spoken script (`script.md`) with per-section voice direction (voice, pace, energy)
- Neural voices via `edge-tts` (e.g. `en-US-AndrewMultilingualNeural`, `en-US-AvaMultilingualNeural`) — Edge-browser-quality, no local install
- Word-boundary timings → SRT subtitles; CPS/overlap validation (DWK `validate_srt`)
- User-supplied narration overrides TTS; offline SAPI fallback voice available

### F8 — Producer: workflow execution
- `workflow.json` (Director's handoff) drives: asset prep → VO → composition build → render → finalize → QC → package
- Stage progress as live job cards with cancel

### F9 — Motion graphics & VFX (HyperFrames)
- Producer authors HTML compositions (`data-*` timing + GSAP timelines) using: Herk style-library card styles, brand tokens, lower-thirds, kinetic captions, Ken Burns on stills, crossfades/wipes, particle/gradient accents, SFX hooks
- Two bundled visual styles (from herk-edit-kit: vox-explainer, kallaway) + per-project style.json

### F10 — Render pipeline
- `hyperframes render` (headless Chrome + FFmpeg): quality draft/standard/high, 24/30/60 fps, mp4/webm
- DWK `finalize` mux (VO + music duck-under + subtitles, AAC 192k, faststart) and `qc` (full decode, dims/fps/runtime, subtitle stream) reused verbatim
- Segmented render + resume for long films

### F11 — Preview & review
- In-app player for draft/final; "review by beat" mode (jump between beats); frame inspection at beginning/middle/end (DWK QC spirit)
- Bible reader with beat chips synced to preview timeline

### F12 — Retention & QC pass
- Automated checks: dead zones (no visual change > N s), cut-cadence variance, caption CPS, LUFS loudness (-14 target), subtitle sync drift, rights completeness
- Retention notes from Director (hook strength, re-hooks, pacing) surfaced as a checklist on the render page

### F13 — Delivery & YouTube kit
- Delivery ZIP (DWK `package_project`): MP4, SRT, credits.md, evidence notes, QC report, SHA-256 sidecar
- YouTube metadata kit: 3 title options, description with chapters (from beats), tags, 3 thumbnail concepts (styled cards using key assets), end-screen plan

### F14 — Settings & models
- Model provider: OpenRouter (default, one key) or any OpenAI-compatible endpoint incl. local Ollama; per-agent model choice
- Edge TTS voice list + preview; fallback voice; ffmpeg/chromium paths (bundled by default)
- Appearance, project defaults, data location, privacy (no telemetry)

### F15 — Visual QC ("the AI watches the cut")
A post-render pass that actually looks at the rendered master — because QC on inputs and audio metrics cannot see a clipped subtitle, a wrong b-roll shot, or narration contradicting the picture.

- **Layer 0 (always, local, free):** ffmpeg detectors (black / frozen / silence) on the master + an exact cut-time assertion against the composition plan + sampled-frame capture (1 fps + every scene cut point) cached under `qc/visual_frames/`
- **Layer 1 (optional, vision model):** sampled frames reviewed *with their scene context* (shot intent + VO text per timestamp) via the user-configured provider (`agent.visual_model`); findings: visual↔narration mismatch, caption clipping/missing, wrong asset, border/render artifacts, dead-air confirmation
- `qc/visual_report.json`: per-finding `{class, severity, t_s, frame_ref, evidence, suggestion, scene_id?}` + verdict pass/warn/fail, stamped with the master SHA-256 (stale ⇒ re-run)
- Verdict `fail` parks packaging behind **gate G-V** (audited human override); `warn` is advisory; sampled frames are a local cache only, never shipped and never telemetry (R11)
- Findings feed the existing refine loop: Preview timeline markers + Director re-pace/re-shot proposals — the AI proposes fixes, the human-gated loop decides
- Cost ceiling: ≤ 600 sampled frames per film, ≤ 12 per vision request; Layer 1 skipped entirely when disabled or no vision-capable model is configured (disclosed)

## 7. Golden-path user flow

```
Brief → Clarify (Showrunner) → PLAN CARD [approve]
  → Scout: research + harvest + rights review [approvals per download batch]
  → Director: Bible draft → user reviews in Bible Reader [edit/approve]
  → Director: script + shot list + workflow.json [approve]
  → Producer: VO sample [approve voice] → full VO + subtitles
  → Producer: draft render (720p draft) → Preview [notes]
  → Producer: final render → QC → [auto-fix loop] → package
  → Delivery page: MP4 + ZIP + YouTube kit
```

## 8. Approval gates

| Gate | Action | Silent default |
|------|--------|----------------|
| G-A | Create project folder | Blocked |
| G-B | Any download batch (non-discovery side effect) | Blocked |
| G-C | Rights status → `approved` (per asset) | Blocked — never auto-approved |
| G-D | TTS generation (voice + script version) | Blocked |
| G-E | Render start (quality/fps shown) | Blocked |
| G-F | Finalize + package ZIP | Blocked |
| G-G | Delete/overwrite artifacts | Blocked |
| G-M | Produce with downloaded media still `rights_status=review` (visual enrichment) | Blocked — the same human click as G-C; never auto-approved (M6 autopilot parks here) |
| G-V | Package while visual QC verdict = `fail` (M7) | Blocked — audited human override allowed; `warn` never blocks |

## 9. Requirements & constraints

| ID | Requirement |
|----|-------------|
| R1 | Windows 10/11 x64 desktop app; single NSIS installer; portable mode optional |
| R2 | LLM access via user's own key (OpenRouter or OpenAI-compatible/local); key stored with Electron `safeStorage` (DPAPI), never logged or exported |
| R3 | Narration TTS: Microsoft Edge neural voices via `edge-tts`; graceful fallback to Windows SAPI offline voice |
| R4 | Bundled: FFmpeg (+ffprobe), yt-dlp, Python sidecar runtime, Playwright Chromium, node runtime (Electron) |
| R5 | All project data in user-chosen folders; app-state SQLite in `%LOCALAPPDATA%\VendoTubeStudio`; nothing uploaded except LLM prompts to the configured provider |
| R6 | robots.txt respected; no paywall/login/anti-bot/geo bypass; downloads only after explicit rights approval (DWK R8/R9 carried over) |
| R7 | Network fetch guard: only `http`/`https`; validate host; refuse localhost, loopback, private, and reserved IP ranges (SSRF hardening for all agent-initiated requests) |
| R8 | Every agent action visible in UI (activity stream + tool cards); claim→evidence citation required in script |
| R9 | Render cadence honesty: duplication/interpolation and upscales disclosed; AI-generated cards never presented as archival evidence (DWK R7 + AGENT_GUIDE) |
| R10 | Cancellation must be safe at every gate; partial artifacts quarantined, never named as final |
| R11 | Visual QC (F15/M7) processing: Layer 0 detectors and frame sampling run locally only; Layer 1 vision review sends sampled frames (base64) solely to the user-configured LLM provider — the same disclosure channel as every agent call, with a strictly-local path (`visual_qc.vision=false` or a local VLM endpoint); frames cached under `qc/visual_frames/` only, excluded from delivery, never telemetry |

## 10. Success metrics

| Metric | Target |
|--------|--------|
| Brief → project initialized | < 30 s |
| Brief → Director Bible ready (10-min film) | < 15 min (research-dependent) |
| End-to-end 8–10 min documentary | < 45 min incl. render |
| First-render QC pass rate | ≥ 90% |
| Retention QC: dead zones > 8 s | 0 |
| Caption CPS violations | 0 |
| Rights violations shipped | 0 |
| Visual QC fail-class findings at package | 0 open (each G-V override audited) |
| Agent actions visible/auditable | 100% |

## 11. Out of scope (future)

- YouTube upload API, multi-language VO tracks, voice cloning
- Full drag-and-drop timeline editor; per-clip color grading
- AI image/video generation
- Collaborative/cloud projects
- Deep-research plugin via deep-researcher MCP server (v2 — INTEGRATION-MAP §4)
