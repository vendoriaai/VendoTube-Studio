# VendoTube Studio — User Guide

**Version:** 2.0 (M5) · **Platform:** Windows 10/11 · **Last updated:** 2026-11-13

Make an evidence-led documentary from one sentence: Scout researches the live web in a
visible browser, Director designs the film, Producer narrates, composes, renders, and
packages it — with human approval gates on every side effect.

---

## 1. First run

1. **Install** (or run from source: `npm install` → `npm run dev`).
2. **Add your provider key** — Home → Get started → *open Settings* → Provider key. Any
   OpenAI-compatible endpoint works (OpenRouter, Z.ai `https://api.z.ai/api/paas/v4` with a
   `glm-4.6`-class model, Ollama local). Keys are DPAPI-encrypted on disk.
3. **Make your first film in two minutes** — Home → Get started → *create sample film* →
   Preview → **produce (draft)**. Approve the narration (G-D), render (G-E), and package
   (G-F) gates as they pause. You get a finished MP4 + subtitles + delivery ZIP.
4. **Voice** — Settings → Narration voice: pick an Edge neural voice and press *preview*.
5. **Visual QC (optional)** — Settings → Models per agent → *Visual QC model*: set a
   vision-capable model and every production will also review sampled frames of the render
   (narration↔picture match, caption clipping, artifacts) before packaging. Empty = the review
   stays fully local (ffmpeg detectors + cut assertions only, nothing leaves your machine).

## 2. The workflow (three commands — or none at all)

**Make my film (autopilot, M6).** Type an idea on Home and press **Make my film** — the
Showrunner runs the whole crew for you: Scout researches, the Director designs the film,
the Producer renders a draft preview, which opens automatically. Narration, rendering and
packaging are pre-approved by your click (each still recorded in the audit log); the run
pauses exactly **once** — the media-rights gate G-M — to ask whether research images/videos
may appear on screen. After the draft, refine it with a prompt in **Preview → Refine**
("make the hook punchier, cut scene 3") — the Director revises and a fresh draft renders
automatically. Happy? **Export final** renders the full-resolution master. Plain text in
Chat works too: with a film designed, it's a revision note; without one, it's the brief.

| Command | What it does |
|---------|--------------|
| `/research <topic>` | Scout browses the live internet in a visible browser; sources, claims, and media candidates land in the project ledgers; candidates are auto-fetched during research but stay *rights: review* until you approve them in **Assets**. |
| `/direct [notes]` | Director studies the evidence and writes the Documentary Bible, script, shot list, and workflow. The Bible stage shows the arc, scenes, and a style editor. |
| `/produce` | Producer executes the workflow: narration (edge-tts neural voices, honest SAPI fallback) → word-timed subtitles → compositions → render → QC + loudness conform → retention check → YouTube kit + thumbnails → delivery ZIP. |

Every long operation is a **job** (jobs rail, bottom) that survives app restarts.
`⌘K` / `Ctrl+K` opens the command palette; `1–6` switch stages.

## 3. Approval gates (your say-so)

| Gate | Pauses before | Where you approve |
|------|---------------|-------------------|
| G-B | asset downloads | Assets tab (rights approval G-C first) |
| G-D | narration generation | Jobs rail / Delivery card |
| G-M | research media appearing on screen | Jobs rail / Delivery card |
| G-E | picture render | Jobs rail / Delivery card |
| G-F | delivery ZIP | Jobs rail / Delivery card |

Approve resumes the run exactly where it paused (narration cache + per-scene render
segments skip what's already done). Decline cancels honestly.

**Autopilot (Showrunner make/refine/export):** G-D, G-E and G-F are pre-authorized by
your kickoff click and approved automatically — every auto-approval is recorded as an
`approved` row in the audit database, and Preview's activity feed shows each one. **G-M
is never auto-approved**: the film always stops and waits for you before research media
shows up on screen. The manual commands (`/produce`) keep every gate as a click.

## 4. Quality ladder

Preview → produce (draft) renders 720p24 in minutes for iteration; produce (standard /
high) renders the full-resolution master. Draft and final masters are kept side-by-side
for A/B in Preview. Renders are segmented per scene — a failed scene retries alone.

**Render performance (Settings):** *Background* (default) renders at low OS priority, so
your PC stays responsive while a film renders — renders just take a bit longer while you
work. *Full speed* uses the whole machine for the fastest render. Films never render two
at once — a second one waits its turn.

## 5. QC, retention, loudness

After every render the master is fully decoded (QC) and loudness-conformed to the
project target (default −14 LUFS). `qc/retention_report.json` records dead zones, cut
cadence, caption reading speed, and loudness with a pass/warn/fail verdict; a `fail`
blocks packaging. Dead zones appear as amber bars on the Preview timeline.

## 6. Delivery

The Delivery tab lists the master, subtitles, YouTube kit (title, beats-based chapters,
sources, tags), three thumbnail concepts, and the ZIP with SHA-256.

## 7. Privacy & data

No telemetry. Projects live under your projects root (`Documents/VendoTube Studio` by
default); journals, renders, and keys stay local. Narration uses Microsoft Edge voices
(edge-tts — unofficial endpoint); the offline SAPI fallback needs no network. See
`docs/PRIVACY.md`.

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bridge shows "starting" forever | Check python on PATH (`python bridge/test_bridge.py`); a hung Electron instance can hold the single-instance lock — kill `electron.exe` and relaunch. |
| Scout finds nothing | Weak/free models may stall — use a mid-tier model; check the journal in `research/scout_sessions.jsonl`. |
| Render scene fails | It retries twice, then the job fails honestly; fix the named scene (composition/asset) and re-run — other scenes render from cache. |
| Loudness warn | The conform could not reach the target — check narration/music levels; the original master is kept and disclosed. |
