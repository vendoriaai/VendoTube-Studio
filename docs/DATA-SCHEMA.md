# Data Schema — VendoTube Studio

**Product:** VendoTube Studio
**Version:** 2.0
**Status:** Draft
**Last updated:** 2026-11-16
**References:** PRD.md · TAD.md · AGENT-SPEC.md · DWK `data-schema.md` (v1 baseline — research/production schemas are inherited unchanged)

---

## 1. Overview

Two persistence layers, same philosophy as v1:

1. **Project folder on disk** — the source of truth (portable, human-editable). It is a **superset of the DWK project layout**: all DWK files keep their exact schema so the `docflow` CLI stays interchangeable with the Studio.
2. **App-local SQLite** — crew chat, jobs, approvals, agent journals, settings.

All timestamps ISO 8601 UTC.

## 2. Project folder (v2 layout)

```
<project>/
├─ project.yml                  # extended (§2.1)
├─ research/
│  ├─ sources.csv               # DWK schema (unchanged)
│  ├─ evidence_ledger.csv       # DWK schema (unchanged)
│  ├─ assets_to_download.csv    # DWK schema (unchanged)
│  ├─ downloaded_assets.csv     # DWK downloader output (unchanged)
│  ├─ scholarly_candidates.csv  # DWK discover_sources output
│  ├─ article_text/             # extracted web text
│  ├─ documents/                # harvested PDFs/documents
│  └─ scout_sessions.jsonl      # Scout browsing journal (§2.6)
├─ media/                       # downloaded assets (DWK layout)
│  ├─ images/ · video/ · audio/ · documents/ · data/
├─ production/
│  ├─ script.md                 # DWK script (claim IDs) + voice front-matter (§2.4)
│  ├─ shot_list.csv             # DWK schema (unchanged)
│  ├─ bible.md                  # Documentary Bible (§3)
│  ├─ beats.json                # emotional curve / retention beats (§4)
│  ├─ subtitles.en.srt          # DWK
│  ├─ credits.md                # DWK
│  └─ vo/                       # narration audio per section + cache/
├─ studio/
│  ├─ workflow.json             # Director → Producer executable plan (§5)
│  ├─ style.json                # visual style tokens for this project (§6)
│  └─ compositions/             # scene_NN.html (+ referenced copied assets)
├─ delivery/
│  ├─ picture.mp4 · documentary.mp4 · project.zip(.sha256) · youtube_kit.md
└─ qc/
   ├─ validation_report.json    # DWK
   ├─ qc_report.json            # DWK
   ├─ retention_report.json     # §7
   ├─ visual_report.json        # §7.1 (M7)
   ├─ visual_frames/            # §7.2 sampled-frame cache (regenerable)
   └─ partial/                  # quarantined cancelled outputs
```

### 2.1 `project.yml` (DWK keys unchanged, additions marked +)

| Key | Notes |
|-----|-------|
| *(all DWK v1 keys)* | title, slug, language, audience, platform, target_runtime_seconds, resolution, fps, codecs… |
| `target_runtime_seconds` *(optional)* | **Omitted when the user leaves Home "Minutes" empty ("Auto")** — the Director then decides the runtime from the research and records the reason in bible.md `runtime_decision` (§3). The DWK CLI default (600) is unchanged. |
| `aspect` | `16:9` (default) or `9:16` |
| `style_preset` | `vox-explainer` \| `kallaway` \| `true-crime` \| `archival-history` \| `science-explainer` \| `investigative-cinema` \| `business-clean` \| custom path |
| `voice` | `{ primary, alternate?, rate, fallback: "sapi" }` |
| `tone` | free text (e.g. "reverent, quietly alarming") |
| `retention` | `{ hook_seconds: 15 (read by the rubric + report since the craft pass), max_dead_zone_s: 8, lufs: -14, cps_max: 17, cadence_variance_max: 0.6 }` |
| `visual_qc` | `{ enabled: true, samples_per_second: 1, vision: true, block_on_fail: true }` (M7) |
| `source_policy`, `music_policy` | DWK (unchanged) |

### 2.4 `production/script.md` front-matter addition

```yaml
---
voice: en-US-AndrewMultilingualNeural   # default; sections may override
sections:
  - id: hook
    voice: en-US-AvaMultilingualNeural
    pace: 1.05
    energy: high
---
```

Sections are `## [hook] Title` headings; only section bodies are narrated (stage directions in blockquotes are excluded — same rule as DWK TTS).

### 2.6 `research/scout_sessions.jsonl`

One JSON object per browser action:
`{ts, task_id, action: navigate|read|screenshot|extract|search, url, title, result_ref, bytes, notes}` — the audit trail for R11.

## 3. `bible.md` format

YAML front-matter + markdown:

```yaml
---
title: "The Forgotten City of Cahokia"
thesis: "…one line…"
target_runtime_seconds: 600
runtime_decision: "7 min — two strong claim arcs; more would pad"   # present only when the Director chose the runtime (no user Minutes)
style_preset: vox-explainer
emotional_promise: "wonder turning to unease, ending in resolve"
---
## Arc
(paragraph: hook → context → evidence & counterpoint → turn → payoff)
## Scenes
### S01 — Hook: "America's lost metropolis"        ← scene id
- shows: aerial mound imagery (ASSET003), title card, map zoom (CLM001, CLM002)
- feels: awe / disorientation — why they stay: impossible scale of a city older than London
- motion: slow Ken Burns 1.08x, kinetic title, low drone swell
- look: sepia grade, full-bleed aerial opener, slow push (visual plan, optional)   ← visual direction pass
- on-screen text: "600 years before Columbus…" (source-card S01-C1)
- duration_target_s: 22
### S02 — …
```

## 4. `beats.json`

```json
{
  "version": 1,
  "beats": [
    { "id": "B01", "scene": "S01", "label": "Hook", "start_s": 0, "dur_s": 22,
      "emotion": { "curiosity": 0.9, "tension": 0.3 },
      "rehook": false, "pattern_interrupt": null,
      "opens_loop": "who built the vault?", "closes_loop": null,
      "music": "drone-swell", "sfx": ["sub-boom"] }
  ],
  "rehooks": ["B04", "B09"],
  "chapter_markers": true
}
```

Note: `opens_loop` / `closes_loop` are the craft-pass open-loop bookkeeping fields (optional; `beats.json` carries them camelCase as `opensLoop`/`closesLoop`). The Director-side rubric and Bible UI read them.

Consumed by: Bible Reader arc chart, Preview beat markers, Producer (motion intensity + re-hook cards), youtube_kit chapters.

## 5. `workflow.json` (Director → Producer handoff)

```json
{
  "version": 1,
  "render": { "resolution": [1920, 1080], "fps": 60, "quality": "standard" },
  "scenes": [
    {
      "id": "S01", "beats": ["B01"],
      "vo": { "script_section": "hook", "voice": "en-US-AndrewMultilingualNeural" },
      "visual": { "mood": "sepia", "layout": "full-bleed", "accent": "#b3542f" },
      "shots": [
        { "asset": "media/images/aerial_mound.jpg", "motion": "kenburns",
          "zoom": 1.08, "dur_s": 6 },
        { "composition": "title-card", "template": "vox-explainer/title-01",
          "text": "America's Lost Metropolis", "dur_s": 3 },
        { "composition": "data-bars", "template": "data-bars",
          "text": "Mound sizes",
          "data": { "kind": "bars", "title": "Mound volumes (m³)",
                    "items": [{ "label": "Monks Mound", "value": 314000 },
                              { "label": "Mound 72", "value": 4200 }] },
          "dur_s": 5 },
        { "composition": "duo", "template": "duo", "dur_s": 8,
          "panels": [
            { "asset": "media/images/poster.jpg", "kicker": "The poster, 1922",
              "title": "A record of Eskimo life", "note": "the claim printed for the public" },
            { "asset": "media/images/set.jpg", "kicker": "The set",
              "title": "A family cast for the camera", "note": "a household staged for the film" }
          ] }
      ],
      "transitions": { "in": "fade", "out": "crossfade" },
      "sfx": ["sub-boom"], "claims": ["CLM001", "CLM002"]
    }
  ],
  "music": { "path": "user://score.mp3", "duck_under_vo": true }
}
```

**Visual direction (2026-11-16 pass).** Each scene may carry `visual`: `mood` (`neutral|warm|cool|sepia|noir|vivid` — a deterministic grade overlay + footage filter; text/panel colors are never touched, so light presets stay readable), `layout` (`standard|full-bleed|split|centered|minimal` — card composition; `full-bleed` also swaps framed exhibits for cover media + scrim caption), and an optional `accent` `#rrggbb` shift (act-break palette moves live here). Asset shots carry live `motion`: `kenburns|push-in|pull-out|pan-left|pan-right|still` (unknown values are rejected at `workflow_write`). `transitions` accepts `cut|fade|crossfade|dip-to-black` per scene side; when a scene authors none, the pair comes from `style.json` `transition_set` (`smooth|hard-cuts|cinematic|broadcast`), so `transitions` may be omitted entirely. All fields optional — absent = the film's global look (older projects unchanged).

Composition shots may additionally carry `data` (structured data card: `kind: bars|stat|list` + `items[{label, value?, note?}]`, rendered by the `data-bars` / `data-stat` / `data-list` templates) and `items` (chunked card lines).

**Video footage and in-points (2026-11-19).** Asset shots whose path ends in `.mp4/.webm/.mov` are **baked into a numbered JPEG sequence at produce time** (`src/main/producer/video-frames.ts`) and played back by a GSAP frame driver — never a live `<video>`, because the renderer's screenshot-capture path composites `<video>` as black. Each video shot (and each video `duo` panel) may carry `source_in`: **seconds into the source clip where the shot starts** (default `0`). The Producer's video-moment pass (`src/main/producer/videoMoments.ts`) writes it: when `agent.visual_model` is configured, an agent looks at stills sampled across the clip (bridge `media.frames_at` → `studio/video_frames/<tag>/`) and picks the moment matching the scene's narration; otherwise a deterministic spread walks the clip so consecutive shots never replay the same seconds. A model answer is snapped to a sampled still and clamped so the window never runs past the clip end. Because the pick lands before the `visualsHash` guard, changing an in-point rebuilds compositions → render → finalize.


**Duo / two boxes (2026-11-16 layout pass).** `template: "duo"` renders ONE shot as two equal image+text panels side by side (the "two boxes" composition): `panels` must contain exactly two entries, each `{asset?, kicker?, title?, note?, motion?, zoom?}`. Panel assets are rights-approved `saved_path` values (validated by `workflow_write`); each panel needs a title or note, the two assets must be distinct, and the comparison is the point (before/after, claim vs counterclaim, two people/eras). Duo shots are scene media for the Producer's injector, so an authored duo scene never receives extra auto-injected media.

**Text fitting (2026-11-16 layout pass).** The emitter fits every authored string to its actual box before writing HTML (`src/main/producer/fit.ts` + the `DESIGN_*_BOX` metrics in `skins.ts`): card headlines, data titles, bar/list labels and values, stat figures/labels/notes, quote bodies and attributions, exhibit/bleed captions, lower thirds, and duo panel kicker/title/note all receive an inline `font-size` when the nominal CSS size would overflow. A prose `data.items[0].note` on a `data-stat` (no numeric value) is rendered as a fitted `.stat-quote` pull-quote, never as a 190–218px display figure; a card title that merely repeats the figure is suppressed. Card panels stay horizontally centered in every layout (`split` keeps its text left-aligned but centers the panel; `minimal` centers its column), and the re-hook chapter chip sits below the masthead. `CompositionBuildResult.layoutNotes` reports every fallback (prose→pull-quote, duplicate title, split-without-media, unshortenable text) to the Producer activity log.

**Media treatment (2026-11-16 media pass).** Asset shots are framed from intrinsic image facts (`src/main/producer/media-info.ts` parses JPEG/PNG/GIF/WebP headers synchronously — no image library, no browser):
- **Images** — portrait, square and 4:3 sources render in an exact-aspect `.exhibit` plate (up to 950×700 design px) instead of a 1240×700 landscape frame; sources smaller than 600 px get a near-native plate (no giant upscale); wide landscapes keep the skin's own exhibit geometry. Duo portrait panels use a top-anchored cover crop.
- **Page screenshots** — a `media/screenshots/…` asset, or any image with height ≥ 2.2×width (a tall web scan), renders as a `.media-plate.screen-plate` with a browser chrome bar (dots + source host derived from the file name) and the page at full plate width, cropped from the top (`screen-body-top`). A viewport-shaped capture is contained whole. `shot.text` remains the caption below.
- **Video** — in `standard|split|centered|minimal` layouts a clip renders inside a framed 16:9 `.media-plate.video-plate` (1100×619 at 1080p design space) with its caption below; clips are never Ken Burns-zoomed (the footage carries its own motion). In `full-bleed` the clip covers the frame and gets the bleed caption.
- **Full-bleed media** (`full-bleed` layout) suppresses scene furniture (masthead/footer), forces a bottom scrim on every skin (newsprint normally disables the scrim), and renders the white caption with an accent rule.
- **Duo media** — panel images keep the panel's blurred backdrop for landscape sources; portrait sources fill the panel with a top-anchored cover crop.
- **Shot-list stills** remain content-true: a media shot points at its real file; a duo shot exports a two-panel SVG still. Per-skin `.media-plate` rules keep video/screen plates inside the design language (hard shadow, taped print, hairline, black frame, glow, rounded).

**Motion-graphics cards (2026-11-16 vocabulary pass).** Four new structured templates carry the "where / when / how much / what was written" questions:
- **`data-line`** — animated line/area chart. `data: {kind:'line', title?, unit?, note?, labels[2..12], series[1..3] [{label?, values[number × labels]}]}`. Axes, gridlines and labels are drawn from the data; the line stroke draws on (`pathLength=1` + dashoffset), the area fades, and the dots pop in per series. Values must come from the evidence — the Director prompt forbids invented points.
- **`data-timeline`** — animated chronology. `data: {kind:'timeline', title?, note?, events[2..10] [{label, year?, note?, highlight?}]}`. Events are sorted by year when all years are present; x is time-proportional. Cards use four lanes (above/below × two tiers) with per-lane collision checks, so close years (1922/1923/1926) never clip; the axis draws left→right, nodes pop, and the highlighted milestone gets an accent card and a pulsing ring. The year is printed inside each event card (no crowded axis year labels).
- **`data-map`** — animated location map. `data: {kind:'map', title?, note?, route?, markers[1..8] [{label, lat?, lon?, note?, highlight?}]}`. The map is a **Natural Earth 110m land dot-mask** (public domain, rasterized once to `src/main/producer/world-mask.ts`; render is fully offline) with equirectangular projection. Markers may carry `lat/lon`; otherwise a small offline gazetteer resolves common cities (Paris, New York, London, Moscow, Port Harrison/Inukjuak, Toronto, Berlin, Los Angeles, etc.). Unknown places are listed as "Not mapped" — a marker is never placed at a guessed coordinate. `route:true` draws an animated arc through the markers in order; the highlighted pin pulses and its label is accent-filled.
- **`article`** — reconstructed source clipping. `data: {kind:'article', publication?, date?, headline, body?, quote?, attribution?}`. The card recreates the clipping's editorial design (masthead line, serif headline, body excerpt, byline) and sweeps an accent highlighter behind `quote`; a fixed `FROM THE ARTICLE · RECONSTRUCTION` tag keeps the honesty boundary (a designed recreation, never a fake screenshot). All copy is fitted to the card.

`workflow_write` validates each payload before writing (line series length, timeline event count, map coordinate pairs/ranges, article content). The Director prompt gained craft rule 10 (use a map for *where*, a timeline for *when*, a line for *how much*, an article for *what was written* — one or two per film, evidence-true). `cardStillSvg` writes the title/headline into the DWK shot-list still for these cards.

**Narration-driven visual timing (2026-11-17 pass).** The voice-over is generated **before** the cut is timed. Shots may carry `narration_cue` — the exact/near-exact phrase from the script the shot illustrates (3–15 words; Director craft rule 11). After TTS, `src/main/producer/narration.ts` reconstructs the narration timeline from the section body + `words.json` (sentence punctuation and em-dash/semicolon clauses; claim refs removed; TTS multi-word tokens expanded; number words normalized so a stat value `79` matches “seventy-nine”), then:
- matches every shot to narration segments (authored cue first, then card title/labels/events/values; a small offline synonym/stem closure covers restart/starts, rebuild, coined, premiere, staged, documentaire/documentary, etc.);
- runs a monotonic **cut DP** that gives each shot one contiguous range of spoken beats, with lane caps (timelines/maps/lists/3+ bar charts may hold multiple beats; a stat/title/article is capped at ~3–4 so it cannot become a 25-second backdrop);
- rewrites the shot `dur_s` values on the **producer's effective plan** (workflow.json on disk is never rewritten) so each visual appears when its words are spoken;
- drops a redundant single-idea card when a neighbouring multi-beat card already carries the same content (e.g. a “79 minutes” stat beside a timeline that already covers 1922/1989);
- replaces a single-idea card that matched no narration beat and dominated a long beat with a title card carrying that spoken phrase (e.g. “The man who called Nanook too Romantic names the genre”);
- gives the final spoken beat (often the scene's rhetorical question/payoff) its own short title card when the last card is about something else (e.g. “Honored — as what, exactly?”).
Every repair is reported in the Producer activity log (`visuals.align`), including any long narration stretch with no matching visual (“s05 shot 2: 6.1s … has no matching visual — add a narration_cue or a shot”). Scenes without word timings (SAPI fallback) keep their authored durations and disclose it. The aligned plan is what drives compositions, the shot list, retention cadence, and visual QC; the `visualsHash` includes the aligned durations, so a TTS/word change rebuilds downstream phases.

**Produce-time visual enrichment (deterministic, gate G-M).** Before compositions are built, the Producer plans visuals from the evidence ledger and the Asset Library: overlong card text is chunked into sequential cards, numeric claims become data cards (conservative extraction), and rights-**approved** downloaded media is interleaved into scenes that reference none (provenance-linked via claim→source→asset-page host, round-robin otherwise). Downloaded media still at `rights_status=review` pauses produce at gate **G-M**; approving the gate flips the ledger status (the same human click as the Asset Library gate G-C) and the enriched plan (hashed in `studio/producer_state.json` as `visualsHash`) drives composition rebuild + `production/shot_list.csv` registration. Workflow.json on disk is never rewritten by the Producer.

Constraints validated before PRODUCE: every `asset` exists + `approved`; every duo panel `asset` exists + `approved` + distinct; every `claims` ref exists in ledger; shot durations sum ≈ section VO duration ± 3 s; `motion`/`visual.mood`/`visual.layout`/`visual.accent`/`transitions` within the visual-direction vocabularies.

## 6. `style.json`

Project visual identity (DATA-SCHEMA visual direction pass): authored by the Director's `style_write` tool during `/direct`, and overridable by the user in the Bible-stage Style panel — **last writer wins per key** (a Style panel save merges, so it never silently drops the Director's `look`/`transition_set`). Keys: `preset` (switch the preset family before token overrides; one of `vox-explainer`, `kallaway`, `true-crime`, `archival-history`, `science-explainer`, `investigative-cinema`, `business-clean`), `accent` color, `caption_style` (kinetic vs boxed vs off), `vignette`/`grain` on/off, `transition_set` (live since 2026-11-16: the film's default transition pair — `smooth` = fade/crossfade, `hard-cuts` = cut/cut, `cinematic` = dip-to-black in + crossfade out, `broadcast` = cut in + crossfade out — inherited by any scene that authors no `transitions`), and `look` (one line naming the film's visual identity, e.g. "1930s newsprint: oxblood accent, heavy grain, hard cuts on reveals"). The Director derives accent/signature from the thesis/period/subject (craft rule 7) so two films in the same niche don't look alike; the preset family stays the structural base (fonts, captions, panel language).

**Design systems (2026-11-16 pass).** A preset is no longer a palette — it selects a *design language* (`src/main/producer/skins.ts`, `DesignKey`), so two presets can never render the same film with different colours. The skin controls typography system (display face, case, tracking, weight), panel geometry (square paper vs. rounded glass), rule language (hairline vs. heavy bar vs. offset block), media treatment (halftone vs. colour), furniture (index numerals, case stamps, mastheads, letterbox) and texture (kraft fibre, newsprint, grid). Preset → design mapping: `vox-explainer` → `editorial` (Swiss/brutalist: near-black canvas, cream paper panels, acid accent, monospace micro-labels, square geometry, hard offset shadows); `true-crime` → `case-file` (forensic opener: aged kraft paper, letterpress serif, taped and rotated exhibits, redaction bars, heavy grain); `archival-history` → `newsprint` (broadsheet: cream stock, halftone photography, masthead double rules, literary serif); `investigative-cinema` → `noir` (letterboxed, mono timecodes, hairline amber, sparse centered type); `science-explainer` → `vivid` (deep navy, saturated gradients, glowing numerals, rounded glass); `business-clean` → `bright` (white field, hairline grid, tabular numerals, small-caps labels); `kallaway` → `glass` (premium dark glass, aurora bloom). Every skin emits its own furniture layer (`designFurniture`) and CSS override block (`designCss`) after the shared base rules, so per-scene `visual.layout` still wins. Fonts stay vendored (`Archivo`, `Fraunces`, `JetBrains Mono`, `Space Grotesk`, `Plus Jakarta Sans`, `Inter`) — a render must never fetch a webfont. `data-design` on each scene composition names the active skin.

## 7. `qc/retention_report.json`

```json
{ "dead_zones": [{"from_s": 214, "to_s": 226, "reason": "static frame, no VO change"}],
  "cut_cadence": {"mean_shot_s": 6.2, "variance": 0.4, "target_variance_max": 0.6, "within_target": true},
  "cps": {"max": 15.1, "limit": 17},
  "hook": {"target_s": 15, "hook_s": 22, "within_target": false},
  "loudness": {"target": -14, "before": -21.2, "after": -13.8, "conformed": true},
  "lufs": -13.8, "subtitle_drift_s": 0.2,
  "verdict": "pass|warn|fail", "suggestion": null, "notes": [] }
```

`hook` (craft pass) is advisory only — an over-target hook scene (S01 `dur_s` > `retention.hook_seconds`, default 15) lands in `notes`, never the verdict.

### 7.1 `qc/visual_report.json` (M7 — Visual QC)

```json
{
  "version": 1,
  "master_sha256": "…",
  "generated_at": "2026-11-15T10:00:00Z",
  "coverage": { "frames_sampled": 214,
                "detectors": ["blackdetect", "freezedetect", "silencedetect", "cut_assert"],
                "vision": true, "model": "…" },
  "findings": [
    { "id": "F001", "class": "subtitle_clip", "severity": "fail", "t_s": 41.2,
      "frame_ref": "qc/visual_frames/ab12cd34/f_0041200.jpg",
      "evidence": "caption line exceeds the safe area bottom edge",
      "suggestion": "shorten cue or raise the caption band", "scene_id": "S03" }
  ],
  "verdict": "pass|warn|fail",
  "notes": []
}
```

Finding classes: `black_frame` · `frozen_frame` · `silence_gap` · `cut_mismatch` (rendered cut ≠ composition timing) · `visual_mismatch` (pixels contradict shot intent/VO) · `subtitle_clip` · `caption_missing` · `wrong_asset` · `render_artifact` · `dead_air`. Severity: `fail` (blocks package behind gate **G-V** when `visual_qc.block_on_fail`), `warn` (advisory), `info`. `detectors` lists what actually ran; `vision: false` means Layer 1 was skipped (disabled or no vision-capable model — disclosed in `notes`). The report is stamped with the picture master's SHA-256; a stale stamp ⇒ re-run visual QC before packaging (§9).

### 7.2 `qc/visual_frames/`

Sampled JPEG cache: `<master-sha8>/f_<t_ms>.jpg`, max 768 px wide. Sampling: `visual_qc.samples_per_second` (default 1 fps) + ±0.5 s around every scene cut + transition midpoints; budget ≤ 600 frames per film (capped and disclosed on truncation). Regenerable cache only — excluded from the delivery ZIP (§10); pruned when the master is replaced.

## 8. App-local SQLite (`%LOCALAPPDATA%\VendoTubeStudio\app.db`)

| Table | Purpose / key columns |
|-------|----------------------|
| `projects` | id, name, path, slug, created/updated/last_opened, fps, runtime, status |
| `chat_messages` | id, project_id, role(user/showrunner/system), content, task_id?, created_at |
| `agent_runs` | id, project_id, agent, stage, model, tokens_in/out, cost_est, status, started/ended — the audit journal |
| `jobs` | TAD §4 columns: id, project_id, kind, agent, params JSON, status, progress JSON, artifacts, log_path, resumable, created/updated |
| `pending_approvals` | id, project_id, tool_name, tool_args JSON, status, created/resolved |
| `assets_index` | (derived cache) project_id, asset_id, path, type, thumb_path, duration_s, license, rights_status, sha256, source_id |
| `settings` | key/value (provider config refs, defaults) |
| `secrets` | key → `safeStorage` ciphertext (API keys; never plaintext) |

FTS5 virtual tables over `chat_messages` and ledger content for agent retrieval.

## 9. Integrity rules

All DWK v1 rules hold (claim→source, shot→asset existence + rights, frame contiguity). Added:

- `workflow.json` scene→beat refs must exist in `beats.json`; shot durations within tolerance of VO section duration
- Every asset referenced by `shot_list.csv` or `workflow.json` has `rights_status=approved` in `assets_to_download.csv` (hard gate, also enforced by DWK downloader)
- Downloaded media still at `rights_status=review` pauses produce at gate **G-M**; approving flips the ledger status (human click) and registers the media in `production/shot_list.csv`. `dwk.validate_project` errors are enforced at produce — except the automated license-allowlist findings, which the G-M human approval supersedes (disclosed in the producer activity log).
- `beats.json` rehooks must land on beat boundaries; `bible.md` scene ids must match workflow scene ids
- TTS cache keys must match the exact approved script hash — script edits invalidate VO (UI warns)
- `qc/retention_report.json` verdict `fail` blocks `package_project`
- `qc/visual_report.json` verdict `fail` blocks `package_project` behind gate **G-V** (human override = audited approval row) unless `visual_qc.block_on_fail=false`; the report must carry the current picture master's SHA-256 — a stale stamp re-runs visual QC before packaging
- Visual QC sampled frames stay in `qc/visual_frames/` (regenerable cache): never shipped in the ZIP, never telemetry; Layer 1 review sends them only to the user-configured provider (R11, PRD)

## 10. Delivery ZIP

DWK `package_project` manifest (documentary.mp4, subtitles, credits.md, project.yml, research CSVs, shot_list, qc reports, sha256 sidecar) + additions: `bible.md`, `beats.json`, `youtube_kit.md`, `qc/visual_report.json`. Exclusions unchanged (`.venv`, caches, `.env`, keys, `partial/`) plus `qc/visual_frames/` (M7).
