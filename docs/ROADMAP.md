# Roadmap — VendoTube Studio build plan

**Product:** VendoTube Studio
**Version:** 2.0
**Status:** Draft
**Last updated:** 2026-11-15
**References:** PRD.md · TAD.md · AGENT-SPEC.md · DATA-SCHEMA.md · INTEGRATION-MAP.md

Seven milestones, each with a demo-able exit. M3 is the hinge: first end-to-end film.

---

## M0 — Foundations (shell + bridge + tokens)

> **Implemented & verified 2026-11-10** — all exit criteria pass via `npm run smoke` (boot, DWK layout round-trip, bridge ping/validate, job pipeline) plus 15 unit tests and a standalone bridge round-trip. Deviation from TAD: `better-sqlite3` ships via Electron prebuild (`postinstall`), not electron-rebuild (no MSVC on the dev machine); dev bridge runs on system Python 3.13 (venv deferred — PyPI very slow here, bundling stays at M5).

**Scope**
- Electron app skeleton: main/renderer split, context isolation, typed IPC, single instance, window state
- Design system v1 from UI-UX-SPEC (tokens, primitives, crew rail/stage/inspector shell, dark+light themes)
- Studio Bridge: Python embeddable + DWK import + JSON-RPC stdio + restart supervision
- SQLite schema v1 (projects, settings, secrets via safeStorage); project create/open (DWK `init_project` layout)
- Provider adapter skeleton (OpenRouter) + health check in status bar
- Job manager + jobs rail (progress/cancel, restart-safe rows)

**Exit criteria**
- App boots < 3 s; create/open project writes DWK layout; Bridge round-trip (`sys.ping`, `dwk.validate_project` on a sample project) from a dev build
- Theme switches; jobs survive app restart in `queued/running` states correctly (resume or requeue)

## M1 — Scout MVP (research + harvest + ledger)

> **Implemented & verified 2026-11-11** — 50/50 unit tests (incl. 30-case SSRF suite + agent loop vs mock provider), bridge round-trip with a real gated download (SHA-256 verified), smoke exit 0. Deviations: Scout's browser uses **system Edge via playwright-core** (`channel: 'msedge'`, no bundled Chromium in dev — bundling stays at M5); Tavily adapter is coded but keyless DDG-lite search is the default (Tavily key field lands in the M2 settings pass); a live LLM-driven Scout run needs the user's provider key in Settings (any OpenAI-compatible endpoint) — everything deterministic is verified. Wikimedia rate-limited (429) the demo download; the gate mechanics are proven via a deterministic fixture.

**Scope**
- Search adapters (start: Tavily + DuckDuckGo), Playwright headed Chromium integration + live browser pane
- Extract pipeline (web text, PDFs, CSV/JSON) → `research/`; robots-aware via DWK `extract_articles`
- sources.csv + evidence_ledger.csv writing (DWK schemas); asset candidate registration incl. Commons/LOC/IA (`dwk.discover_media`)
- Guarded downloader: DWK `download_assets` + yt-dlp path behind gate G-B; rights approval flow (gate G-C)
- Asset Library grid + Inspector (thumbnails via ffmpeg, license badges)
- Scout agent loop + tool schemas (AGENT-SPEC §3); scout_sessions.jsonl journal; SSRF guard in Node + Bridge

**Exit criteria**
- "Research X" brief → ≥ 3 sources, ≥ 2 claims with locators, ≥ 4 asset candidates, 1 approved+downloaded batch, all visible in UI
- SSRF guard test suite (localhost/private/reserved refused) green; robots blocked URL extraction attempted → refused + logged

## M2 — Director MVP (bible + script + workflow)

> **Implemented & verified 2026-11-12** — 52/52 unit tests incl. the Director pipeline (scripted mock run writes bible.md/beats.json/script.md/workflow.json coherently; unknown-claim refs rejected; per-phase validation errors fed back to the model). Showrunner stages live on the project record (created → researching → research_done → directing → bible_ready | direction_needs_fixes); DWK validation runs at the end of every direction job and gates the stage. Known model-behavior guardrail: script section ids are scene ids (S01…) — serializers/validators are case-insensitive.

**Scope**
- State digest builder (ledger/assets → compact context) + FTS retrieval
- Bible generation (bible.md + beats.json) + Bible Reader UI (arc chart, scene cards, claim chips)
- Script with claim IDs + voice front-matter; shot_list.csv; workflow.json writer + validator (DATA-SCHEMA §5 constraints)
- Showrunner stage machine (INTAKE→RESEARCH→BIBLE→SCRIPT) + plan cards + approvals
- Model routing config per agent; token budgeting; cost estimate on plan cards

**Exit criteria**
- From an approved research state: Bible → user edits a scene → script/shot_list/workflow regenerate coherently; `dwk.validate_project` passes; every script claim maps to ledger (validator-enforced)

## M3 — Producer MVP (first film end-to-end) ⭑

**Scope**
- edge-tts integration (`tts.voices/preview/generate` with word boundaries, WAV 48k, cache); gate G-D; SAPI fallback
- Subtitle generation from word timings + `dwk.validate_srt`
- v1 compositions: Ken Burns stills, hard cuts + crossfades, title/end cards from style-library templates, lower-thirds — no heavy motion yet
- Render via HyperFrames CLI (draft preset) → `dwk.render_video` compatible picture master; `dwk.finalize` mux; `dwk.qc`
- Preview tab (in-app player, local protocol); Delivery tab with `dwk.package_project` (gate G-F) + youtube_kit.md v1 (titles/description/tags)
- Producer agent loop + gates G-E/G-F wired

**Exit criteria (the demo)**
- One sentence → finished MP4 + SRT + credits + ZIP, produced entirely in-app on a clean Windows machine (installer build), QC pass, every gate honored. Target: a coherent 3–5 minute film.

## M4 — Studio-grade visuals (motion + VFX + retention)

**Scope**
- Full composition builder: kinetic captions, beat-synced motion from beats.json (zoom/cut cadence, re-hook cards, pattern interrupts), particles/gradient accents, SFX placement, music duck-under in finalize
- Style presets (vox-explainer, kallaway) + per-project style.json editor
- Retention checker (dead zones, cadence variance, CPS, LUFS) → retention_report.json + Preview overlay; auto-fix pass (re-pace scenes) proposal
- Segmented render + per-scene retry; final quality ladder (standard/high); 9:16 short-form evaluation decision (TAD §15.2)
- Director retention.review self-check before handoff

**Exit criteria**
- 8–10 min film: 0 dead zones > 8 s, cadence variance in target, LUFS −14 ± 1; draft→final render loop < 45 min end-to-end on reference hardware (Ryzen 7 / RTX 3060 class)

## M5 — Polish & release

**Scope**
- Onboarding (first-run: provider key, voice preview, sample project), empty states, command palette (⌘K), shortcuts
- YouTube kit v2 (chapter markers from beats, 3 thumbnail concepts via HTML→PNG)
- Settings completeness (per-agent models, fallbacks, data location), error recovery polish, agent_runs audit viewer
- Installer bundling finalization (python-embed, FFmpeg, yt-dlp, Chromium), portable zip, size budget pass
- Docs: user guide, admin/privacy note; LICENSE audit (DWK MIT, herk kit license for style library, edge-tts ToS note in-app)

**Exit criteria**
- Fresh-machine install → demo film with zero manual dependency fixes; crash/restart mid-render resumes or cleanly requeues; all gates + audit views verified; PRD success metrics measured and recorded

## M6 — Showrunner autopilot (one idea → film)

> **Implemented & verified 2026-11-15** — 136 unit tests incl. `tests/showrunner.test.ts`; the full gate contract lives in `../AGENTS.md` (Showrunner autopilot gate contract + `GATED_JOB_KINDS` in `src/main/ipc.ts`). Backfilled here 2026-11-15 when M7 was spec'd (M6 shipped without a ROADMAP entry).

**Scope**
- One idea → research → direction → draft preview inside single resumable jobs: `showrunner.make` / `showrunner.refine` (`src/main/showrunner.ts`: pure phase machine + `routePlainMessage` chat router + `ShowrunnerRunner`); crew-job bodies (`runResearchJob`/`runDirectorJob`/`runProduceJob`) extracted in `index.ts` and shared with the individual handlers
- Home "Make my film" hero; Chat plain text routed by `routePlainMessage`: brief (no designed film) / revision note (designed film); Preview **Refine** prompt box + **Export final** (standard-quality autopilot produce)
- Gate policy (user decision): autopilot pre-approves G-D/G-E/G-F by persisting **approved** `pending_approvals` rows (100% audited, surfaced in the activity feed); **G-M (research media rights) is never auto-approved** — the run parks once
- **Runtime autonomy (2026-11-15):** Home "Minutes" is optional ("Auto") — with no user value `project.yml` omits `target_runtime_seconds` and the Director decides the runtime from the evidence, recording the choice + reason in bible.md `runtime_decision` (shown in the Bible reader); a user-set Minutes becomes an enforced budget in the Director prompt

**Exit criteria**
- One sentence → resumable autopilot job → draft film in Preview; refine note → revised draft; Export final; every auto-approval audited; G-M parks and resumes correctly.

## Craft pass — documentary-craft research → studio (2026-11-15)

> **Implemented & verified 2026-11-15** — 145 unit tests + bridge round-trip + TTS tests pass. Evidence base: `docs/research/DOCUMENTARY-CRAFT-RESEARCH.md` (six web-research passes). No gate changes; M7 untouched.

**Scope**
- **Five niche style presets** (`compositions.ts resolveStyle`): `true-crime`, `archival-history`, `science-explainer`, `investigative-cinema`, `business-clean` — matched before the kallaway/vox families (substring dispatch); vendored fonts reused; preset switchable via `studio/style.json` `preset` key (StyleSave whitelist + Bible Style panel picker, DATA-SCHEMA §6)
- **Director craft rules** (system prompt): hook ≤ ~15 s opening on evidence (never a title card), but/therefore beat chaining, deliberate reveal order, open-loop bookkeeping per beat (`opens_loop`/`closes_loop` → beats.json), "say cow see cow" narration, forward-pointing honest ending, niche→preset mapping with bible rationale
- **Retention rubric hardened** (Director `retention_review`): `retention.hook_seconds` (default 15, DATA-SCHEMA §2.1 now actually read), title-card-hook advisory, open-loop ledger advisories (dead loop hand-offs); Producer `retention_report.json` gains an advisory `hook` entry
- **Emitter craft**: Ken Burns speed floor (~1.5 %/s — long shots no longer fall below the attention band) + eased zoom (`power1.inOut`); emitter version `2026-11-15.1`
- **Audio craft** (bridge): broadcast VO chain on every TTS output (HPF 80 Hz → de-esser → 2.5:1 compressor → limiter), cache key versioned (`v2`) so stale cached WAVs re-render

## Visual direction pass — the Director plans the edit's look (2026-11-16)

> **Implemented & verified 2026-11-16** — 207 unit tests (25 new: scene-style resolution, transition_set inheritance + gapless dips, motion grammar, look rendering, style_write/validation, monotony advisory) + hyperframes lint green on the new emitter (`2026-11-16.1`). Closes the style-system audit finding (2026-11-16): the 7 presets were paint-only over one hardcoded engine — `shot.motion` ignored, `transition_set` dead, one global look per film.

**Scope**
- **Per-film identity**: new Director tool `style_write` authors `studio/style.json` (DATA-SCHEMA §6) — accent derived from thesis/period/subject (never the preset stock color), caption/vignette/grain, a live `transition_set` signature (`smooth|hard-cuts|cinematic|broadcast` → the default transition pair for scenes that author none), and a one-line `look` note. Style panel remains the user's override (last writer wins; StyleSave merges so a user tweak never drops Director keys)
- **Per-scene look**: `workflow_write` accepts `scenes[i].visual {mood, layout, accent?}` — `mood: neutral|warm|cool|sepia|noir|vivid` renders a deterministic grade overlay + footage filter (text/panel colors untouched — light presets stay readable; noir/sepia carry grain floors), `layout: standard|full-bleed|split|centered|minimal` composes cards (full-bleed swaps framed exhibits for cover media + scrim caption), optional accent `#rrggbb` for act-break palette shifts. All validated at `workflow_write`; all optional (absent = today's look — old projects untouched)
- **Live shot motion**: `shot.motion` is consumed at last — `kenburns` (unchanged 4-path band), `push-in`, `pull-out`, `pan-left/right` (scale headroom), `still`; unknown values rejected with the valid vocabulary. Injected b-roll gets a deterministic per-scene motion cycle instead of one fixed kenburns; the injector honors scene layouts (minimal/split = card-only, full-bleed = media-first)
- **Real transitions**: `cut|fade|crossfade|dip-to-black` per scene side; dips render as black overlays (out-side fade-up before the cut, in-side open from black) with the gapless VO timeline math preserved; `cut` entrances are true hard cuts. `computeSceneTimings` + the render-timing call site share the same transition_set resolution
- **Craft rule 7 (VISUAL DIRECTION)** in the Director prompt: derive the identity, time palette shifts to act breaks (research §3.2), choose motion by meaning, vary layouts; phase order gains `style_write` between `workflow_write` and `retention_review`; `retention_review` gains a visual-monotony advisory (every scene one look); bible scene blocks may carry a human-readable `look:` line (shown in the Bible reader)
- **Shot-list stills** are themed per scene (`buildShotListRows themeByScene`), so DWK rows mirror each scene's grade

**Exit criteria (met)**
- Every new input validated + deterministically rendered (unit tests assert exact tween/markup output per mood/layout/motion/transition); absent-visual back-compat asserted byte-level; sample film (no visual fields) unaffected.

## Design systems pass — presets become layout languages (2026-11-16)

> **Implemented & verified 2026-11-16** — 208 unit tests (new: seven-preset design uniqueness, furniture emission, vendored-font assertions) + hyperframes lint green + seven rendered still sheets visually reviewed (title / data / exhibit per preset). Closes the follow-up to the style-system audit: even after the visual-direction pass, `StyleTokens` was still a palette over ONE composition skeleton, so every preset read as the same film recoloured. Supersedes the visual-direction pass's per-film identity work only where the two overlap — scene `visual` fields and `style.json` overrides still apply on top.

**Scope**
- **New module `src/main/producer/skins.ts`** — `DesignKey` (`editorial | case-file | newsprint | noir | vivid | bright | glass`), the seven `StyleTokens` tables, `FONT_SETS`, the texture SVGs (`GRAIN`, `KRAFT`, `MOTTLE`, `FIBRE`, `HALFTONE`), `designCss(compId, style)` and `designFurniture(style, …)`. `compositions.ts` now imports its token types from here (re-exported for existing call sites); nothing else about the emitter contract changed
- **A skin changes the design language, not the paint**: typography system (display face, case, tracking, weight, `font-stretch`), panel geometry (square paper vs. rounded glass vs. hairline field), rule language (hairline / heavy bar / offset block / double rule), media treatment (halftone / grayscale / sepia / full colour), furniture layer (outlined index numerals, case stamps, mastheads, letterbox + timecode, page rules) and texture (kraft fibre, newsprint stock, grid lines)
- **Preset → design mapping** (seven presets, seven skeletons): `vox-explainer` → `editorial` (Swiss/brutalist: black canvas, cream paper panel, acid accent, monospace micro-labels, hard offset shadow) · `true-crime` → `case-file` (forensic: aged kraft stock, letterpress Fraunces, taped and slightly rotated exhibits, 16 px print border, heavy grain) · `archival-history` → `newsprint` (broadsheet: cream stock, halftone photography, masthead double rule, literary serif, italic captions) · `investigative-cinema` → `noir` (letterbox bars, mono timecode, hairline amber rules, sparse centered type, thin bar tracks) · `science-explainer` → `vivid` (deep navy radial, gradient rules, glowing numerals, rounded glass panels, pill captions) · `business-clean` → `bright` (white field, hairline grid, tabular numerals, small-caps mono labels, no grain) · `kallaway` → `glass` (previous house look, unchanged)
- **Reference-driven extremes**: `editorial` is built from the supplied Swiss/brutalist documentary showreel (black field, cream paper cards, acid-yellow blocks, monospace meta bars, oversized outlined scene numerals); `case-file` is built from the supplied forensic-opener reference (kraft paper, letterpress serif, taped exhibits, redaction-red accents)
- **Emitter changes** (`compositions.ts`): scenes carry `data-design="<key>"`; `${designCss()}` is emitted **after** the shared base block and **before** per-scene layout CSS, so `visual.layout` still wins; a `${furnitureHtml}` layer sits between the grain overlay and the accent layer; `renderSceneHtml` takes `sceneIndex`/`sceneTotal`/`projectTitle` for the furniture. Every previously used class name (`.card`, `.data-card`, `.bar-fill`, `.kb-bg`, `.kb-fg`, `.lower-third`, `.chapter-card`, `headline-*`) is unchanged, so lint and the existing tests stay valid
- **Layout overrides hardened** so they compose with skins instead of fighting them: `centered` re-centers the card, `split` left-aligns it, `minimal` strips the card chrome entirely (no panel/border/shadow)
- **New vendored fonts**: `JetBrains Mono` (the mono micro-label system, present in every skin) and `Space Grotesk` (`bright` display face) join Archivo / Fraunces / Plus Jakarta Sans / Inter in `assets/fonts/`. Still fully offline — no webfont fetches (lint enforces `@font-face`)
- **Unknown presets now fall back to `editorial`** (the studio's house look) instead of the dark glass family; `vox-explainer` is no longer a "paper" light preset — it is the black-canvas editorial grid
- **Surfaces that name the presets describe the design language**: Bible Style panel labels, the Director `style_preset` tool description and craft rule 6 all state that a preset is a layout language, not a recolour (DATA-SCHEMA §6 documents the skin layer)

**Exit criteria (met)**
- Seven presets render seven visually distinct design systems (stills reviewed per preset at title/data/exhibit; unit test asserts seven unique `design` keys, a mono stack and vendored fonts on every preset).
- HyperFrames lint exits 0 on the new emitter; the full unit suite is green; `dispatch`/markup contracts locked by existing tests are unbroken.

## M7 — Visual QC ("the AI watches the cut")

> **Layer 0 + Layer 1 implemented & verified 2026-11-15** — 167 unit tests (22 in `tests/producer.visualqc.test.ts`: L0 thresholds, sampling plan, mock-provider vision review with hard finding clamping, `runVisionStage` integration) + `bridge/test_qc_scan.py` (fixture film with planted defects: black [3–5s], silence [4–8s], frozen [9–12s], cuts {3, 5, 9} — all reported exactly, zero strays); smoke chain green incl. the visual report artifact asserting `vision:false` with no vision model wired (zero provider calls). Dogfood on a real film remains the open exit item.

**Rationale.** QC today verifies inputs and signal metrics (streams, decode, loudness, cadence) but nothing ever looks at the rendered pixels: narration↔visual mismatch, caption clipping, wrong b-roll, and border artifacts are invisible to the pipeline. M7 adds a post-render visual pass on three principles: (1) **most "watching" is deterministic** — the render is code-driven, so cut sync and timing are *asserted*, not observed; (2) **perception is sampled, not exhaustive** — 1 fps + every cut point (~≤600 frames for a 10-min film) instead of all 18,000, because adjacent frames are near-identical; (3) **findings feed the existing refine loop** (Preview Refine / Director revision), they don't replace it — AI catches objective defects, the human-gated loop carries taste.

**Scope**

- *Layer 0 — deterministic detectors (always, local, free):* bridge module `bridge/qc_scan.py` exposing `qc.scan_master` (ffmpeg `blackdetect` / `freezedetect` / `silencedetect` on the rendered master) and `qc.sample_frames` (JPEG sampling: 1 fps + ±0.5 s around every scene cut + transition midpoints, max 768 px wide, cached under `qc/visual_frames/`); plus an exact **cut-time assertion** comparing rendered scene cuts against the composition timings that built them. Reuses `media.loudness` for LUFS. No AI, no network.
- *Layer 1 — sampled visual review (vision model, optional — **implemented 2026-11-15**):* batches ≤ 12 sampled frames per request **with their scene context** (shot intent from workflow.json + the VO text for that timestamp) to a vision-capable model through the provider adapter (`agent.visual_model` setting — **empty = vision review OFF; sending frames to a provider is explicit opt-in**; a local Ollama VLM endpoint keeps it fully offline); verifies visual↔VO semantic match, subtitle clipping/overflow, caption presence, wrong-asset detection, exhibit-border/render artifacts. Model answers are clamped hard (unknown classes dropped, severity clamped per class, t_s snapped to labeled frames, hallucinated timestamps dropped); a vision failure never fails the produce run — disclosed, verdict stands on Layer 0. Journaled as an `agent_runs` row (agent=producer, stage=visual_qc). Skipped entirely when `visual_qc.vision=false` or `agent.visual_model` is empty (disclosed in the activity log + report notes).
- *Report:* `qc/visual_report.json` (DATA-SCHEMA §7.1) — findings `{class, severity: info|warn|fail, t_s, frame_ref, evidence, suggestion, scene_id?}`, verdict pass/warn/fail, stamped with the master's SHA-256 (stale stamp ⇒ re-run before package).
- *Gate G-V:* verdict `fail` + `visual_qc.block_on_fail` (default true) parks package on a content-stamped `pending_approvals` row (`producer.gate:G-V:<master-sha>`); Approve = audited human override, Decline = fix & re-render. `warn` never blocks. Add `G-V` to the Delivery `GATE_LABEL` map and the gate-card job-kind matching (`GATED_JOB_KINDS`).
- *Fix-loop integration:* findings carrying `scene_id` render as Preview timeline markers (extends the M4 dead-zone overlay) and as a `/direct` re-pace/re-shot proposal — same mechanism as the retention re-pace suggestion.
- *Cost ceiling:* sampling budget ≤ 600 frames per film (10 min at 1 fps + cut points; cap and disclose on truncation); ≤ 12 frames/request ⇒ ≤ ~52 vision calls per film.

**Exit criteria**
- Deterministic fixture film with planted defects (black segment, frozen segment, silent gap, off-by-one cut) → Layer 0 reports exactly those timestamps and nothing else (unit tests).
- Vision stage verified against a mock provider (no live key): batched request carries frames + scene context; report written; `agent_runs` row journaled; `vision=false` path makes zero provider calls (asserted).
- G-V park/resume/decline + restart-mid-park covered by job tests; delivery ZIP excludes `qc/visual_frames/`.
- Dogfood: report generated on the M3 smoke film **and** one real film made with the M6 build; findings recorded in METRICS.md (companion to PRD §10 "First-render QC pass rate").

---

## M8 — Layout-fit + duo + media + motion-graphics pass (implemented & verified 2026-11-16)

**Rationale.** The 2026-11-16 foundation film shipped cards whose copy was sized by character count alone: a prose note in a `data-stat` rendered at ~210 px and was clipped by the frame, `split` scenes left a text panel hugging the left edge with half the frame empty, the re-hook chip collided with the newsprint masthead, and card-to-card cuts stacked ghost text for 0.3 s. Two-box (image + text side by side) comparisons were not authorable at all. A media probe then showed the other half of the problem: portrait images and tall page screenshots were shrunk into landscape exhibits (a 1200×3600 page became a ~200 px sliver between blur bars), video was full-bleed under light-skin furniture with its caption dropped, and full-bleed media had no scrim on paper skins.

**Scope (all implemented)**
- **Deterministic fit**: `src/main/producer/fit.ts` (glyph-advance tables, greedy wrap, binary search for the largest fitting size) wired into every authored text node in `compositions.ts`; `DESIGN_*_BOX`/`DESIGN_TYPE` metrics in `skins.ts` are the single geometry source. Inline `font-size` only when the nominal CSS size would overflow.
- **Prose stat → pull-quote**: a `data-stat` without a numeric figure renders `.stat-quote` (fitted, max 4 lines) instead of the 190–218 px display slot; a title that repeats the figure is dropped.
- **Centering + collisions**: card panels centered in every layout (`split`/`minimal` keep left-aligned text but center the panel); re-hook chapter chip moved to `top: 118px` and aligned to each skin's content margin; graphics→graphics cuts hide the outgoing layer at the cut.
- **Duo template**: one shot, two equal image+text panels (`panels[2] {asset?, kicker?, title?, note?, motion?, zoom?}`) through the Director schema + handler validation, `artifacts.ts`, the emitter (asset copy, per-panel motion, staggered entrances, fitted text, per-skin `.duo-*` CSS, opaque text panels), `visuals.ts` (no auto-injection into duo scenes, two-panel shot-list stills).
- **Adaptive media plates**: `media-info.ts` parses intrinsic sizes from JPEG/PNG/GIF/WebP headers; portrait/square/4:3 sources get exact-aspect exhibit plates, small sources get near-native plates (no giant upscales), wide landscapes keep the skin frame. Duo portraits use a top-anchored cover crop.
- **Screenshot browser plates**: Scout screenshots and any extremely tall page scan render as a `media-plate screen-plate` with chrome bar + source host, page shown at full width from the top (`cover-top`) instead of a shrunken sliver.
- **Video plates**: standard layouts frame video at 16:9 on the canvas with a caption; clips are never Ken Burns-zoomed; `shot.text` captions render for video (previously dropped). Full-bleed video stays cinema.
- **Full-bleed cinema**: furniture suppressed, forced bottom scrim on every skin, white caption with an accent rule, chapter-chip shadow.
- **Per-skin media-plate styling**: editorial hard shadow, case-file taped print, newsprint hairline, noir black, vivid glow, bright/glass rounded.
- **Motion-graphics vocabulary**: `data-line` animated line/area charts (axes, gridlines, multi-series draw-on, staggered dots), `data-timeline` animated chronology (time-proportional axis, four collision-safe lanes, inside-card years, highlighted milestone), `data-map` animated location map (Natural Earth 110m dot mask, equirectangular projection, offline gazetteer, honest "not mapped" list, animated route, pulsing highlight), and `article` reconstructed source clipping (masthead, headline, body, byline, accent highlighter sweep, fixed `RECONSTRUCTION` label). Payloads validated in `workflow_write`; `cardStillSvg` carries the headline into DWK shot-list stills.
- **Director craft rule 10**: use a map for *where*, a timeline for *when*, a line for *how much*, an article for *what was written* — one or two per film, evidence-true, no decorative geography or invented points. `data-map` resolves common cities from an offline gazetteer; `article` is always tagged as a reconstruction.
- **Director craft rules 8/9**: headline/stat-figure/label budgets, prose never in a stat figure, never repeat the figure, use `duo` when the beat compares two things; `split` documented as media-only.
- **Producer audit**: `CompositionBuildResult.layoutNotes` lists every deterministic repair (prose→pull-quote, duplicate title, split-without-media, unshortenable text) in the activity feed.

**Verification**
- 249 unit tests (2 live-gated) incl. `tests/producer.fit.test.ts`, `tests/producer.media-info.test.ts` (JPEG/PNG/GIF/WebP headers, frame geometry, page-plate detection), `tests/producer.graphics.test.ts` (line/timeline/map/article markup + tween targets) and fit/overflow/duo/centering/media composition regressions; typecheck; hyperframes lint + runtime clean.
- Rebuilt the foundation film and ran `hyperframes check`: **13 layout errors → 0**.
- Rendered a seven-treatment media probe (landscape, portrait, tall screenshot, video plate, full-bleed image and video, small logo, duo) and a four-card graphics probe (timeline, map, article, line chart) and reviewed the stills. `hyperframes check` on both: 0 errors, 0 runtime warnings; remaining warnings are the known crossfade furniture overlap and `duo`/exhibit backdrop duplicate-media lint advisories.

---

## M9 — Narration-timed visual cut (implemented & verified 2026-11-17)

**Rationale.** The 2026-11-16 foundation film had a coherent scene-level plan, but each scene's cards were timed by the Director's authored duration weights — written before the voice-over existed. A card about the 1922 premiere could still be on screen during the 1989 Registry sentence, and a stat with no relation to the current sentence held for 10–20s. The voice-over is the film's clock; the visuals must be cut to it.

**Scope (all implemented)**
- **`src/main/producer/narration.ts`** reconstructs the spoken timeline from the script section body + `words.json`: Unicode sentence splitting (abbreviations preserved), em-dash/semicolon clause segments, claim-ref removal, TTS multi-word token expansion, and number-word normalization (`79` ↔ “seventy-nine”, `30,000` ↔ “thirty thousand”).
- **Shot→beat matching**: authored `narration_cue` wins; otherwise the card's title/headline/quote/events/markers/labels/values are matched with a light stem/synonym closure (restart/starts, rebuild, coined, premiere, staged, documentaire/documentary). A **monotonic cut DP** gives each shot one contiguous range of beats; lane caps stop a single-idea stat/title/article becoming a 25s backdrop while letting timelines/maps/lists/3+ bar charts summarize multiple beats.
- **Producer repairs**, all logged (`visuals.align`): drop a redundant single-idea card already covered by a neighbouring multi-beat card; replace an unmatched single-idea card with a title card carrying the dominant spoken phrase; give the final beat (often the rhetorical question/payoff) its own short title card; report any ≥2.5s narration stretch with no matching visual.
- **Pipeline integration**: `voWords` is loaded once after TTS; `planVisuals` output is aligned before the `visualsHash`, compositions, shot-list registration, retention cadence and visual QC. Workflow.json on disk stays the Director's authored plan; the Producer's effective plan carries the aligned durations. SAPI fallback (no word timings) keeps authored durations and discloses it.
- **Director craft rule 11 + schema**: every shot carries `narration_cue` — the exact phrase from the script it illustrates (3–15 words); `workflow_write` serializes it. The Director is told the Producer generates the voice-over first and cuts each visual to those words. Emitter `2026-11-17.1` forces a downstream rebuild on next produce.

**Verification**
- **255 unit tests** (6 new in `tests/producer.narration.test.ts`: sentence/word timing, number words, authored-duration rewrite, final-question card, mismatch replacement, honest no-timings fallback) + typecheck.
- Ran the real foundation project's script/workflow/word timings through the aligner: hook 6.2/6.1/7.7/3.3s, s02 21.5/4.7/2.1s (the redundant “79 minutes” stat dropped), s03 11.2/7.0/9.3/3.4s, s04 2.7/5.0/1.9s, s05 13.8/7.5/8.4s (mismatched “From French to English” bars replaced with the “man who called Nanook too Romantic” line), s06 20.9/5.5/11.1/9.3/1.9s, s07 8.8/9.0s. Built the aligned compositions and verified the compiled timelines cut at those times; rendered the key final-question/article/narration-card frames and reviewed them.
- The delivered 2026-11-16 MP4 predates this pass; a re-produce applies the narration-timed cut (the `visualsHash` changes and rebuilds compositions/render).

---

## Sequencing notes

- One developer-agent pairing per milestone is realistic; M1 and M2 internals can partially overlap (M2's digest builder only needs M1's CSVs, not its UI).
- Keep DWK untouched; every extensibility point is a wrapper in Studio (Bridge methods, tool schemas, templates).
- Risks to retire early: edge-tts stability (M3 spike, week 1), HyperFrames render perf at 1080p60 (M3 draft + M4 high), installer size (M0 spike on payload budget).
- After M3: dogfood rule — every future release ships a real film made with the previous build.
- M7's findings classes only count as proven if they fire on a real M6-made film, not just fixtures — the dogfood exit criterion is the bar, not the unit tests.
