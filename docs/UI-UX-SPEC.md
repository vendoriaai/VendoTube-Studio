# UI/UX Spec — VendoTube Studio

**Product:** VendoTube Studio
**Version:** 2.0
**Status:** Draft
**Last updated:** 2026-11-15
**References:** PRD.md · TAD.md

---

## 1. Design principles

| Principle | Meaning |
|-----------|---------|
| **Screening room** | The app feels like a dim, focused edit suite: dark canvas, content glows, chrome recedes. Default theme is dark. |
| **Crew in the room** | Agents are characters with presence (avatar, status, live activity), not invisible pipes. You always know who is working and on what. |
| **One stage** | A single central Stage area whose tabs carry the workflow (Chat → Bible → Assets → Script → Preview → Delivery). No nested windows except Scout's browser. |
| **Evidence on tap** | Provenance is one click away everywhere: claim chips, license badges, source links. Nothing hides provenance. |
| **Calm automation** | Long jobs render as slim progress rails, not modal walls. Approval cards are the only interruptions. |
| **Fast to first frame** | New project in < 30 s; draft preview is always the celebrated milestone. |

## 2. Design language — "Aurora Studio"

Deliberately distinct from Vendoria.ai (warm cream paper + amber-gold + serif, light-first, paper-grain, soft scholarly). VendoTube Studio is **dark-first, cool, cinematic, geometric**.

### 2.1 Color system (CSS variables, dual theme)

Dark "Screening" (default):

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0A0D14` | App canvas (deep blue-black) |
| `--bg-elevated` | `#0E131D` | Rails, drawers |
| `--surface` | `#141A26` | Cards, panels |
| `--surface-2` | `#1A2233` | Hover/raised, inputs |
| `--ink` | `#EAF0F7` | Primary text |
| `--ink-muted` | `#8B95A7` | Secondary text |
| `--line` | `#232C3E` | Borders/dividers |
| `--accent` | `#8B7CFF` (violet) | Primary actions, active agent, focus |
| `--accent-soft` | `#8B7CFF @ 14%` | Tints, selected states |
| `--signal` | `#3CE0D0` (teal) | Data, live status, success-ish highlights |
| `--warm` | `#FFB454` (amber) | Warnings, pending approvals |
| `--danger` | `#FF5D6C` | Errors, blocked gates |
| `--glow` | radial violet/teal 6–10% alpha | Ambient aurora behind Stage header only |

Light "Daylight" (secondary): bg `#F4F6FB`, surface `#FFFFFF`, ink `#161B26`, line `#E1E6F0`, same accents (violet darkened to `#6B5CE8` for contrast). Full AA contrast in both themes.

### 2.2 Typography

| Role | Font | Notes |
|------|------|-------|
| Display/headings | **Space Grotesk** (bundled) | Geometric, cinematic; 600/500 |
| UI/body | **Inter** (bundled) | 13–14 px base, 400/500 |
| Data/code/paths | **JetBrains Mono** (bundled) | Tool args, JSON, timecodes |
| Scale | 12 / 13 / 14 / 16 / 20 / 26 / 34 px | lh 1.3–1.55 |

### 2.3 Shape, depth, motion

- Radii: inputs/buttons 8 px · cards 14 px · sheets/modals 20 px · media 10 px
- Elevation: 3 shadow levels, very soft (`rgb(4 8 16 / 0.28–0.5)` dark theme); glass top bar (`backdrop-blur 14px`, `--surface @ 72%`)
- Borders 1 px `--line`; active/left-status rails 2 px accent
- Motion: 150/200/250 ms, `cubic-bezier(0.22, 1, 0.36, 1)`; respects reduced-motion; no large parallax — motion is reserved for: agent status pulses, progress rails, tab transitions, approval card entrance, aurora breathing (8 s loop, subtle)
- Iconography: single custom set (24 px grid, 1.5 px stroke) — matches Vendoria's approach but different glyphs/weight

## 3. Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ ◈ VendoTube Studio   [Project: Cahokia ▾]            ⌘K  ⚙  theme  □ │ ← glass top bar
├───────────┬───────────────────────────────────────────┬───────────────┤
│ CREW      │  STAGE                                    │ INSPECTOR     │
│           │  [Chat] [Bible] [Assets] [Script]         │ (contextual)  │
│ ◉ Showr.  │        [Preview] [Delivery]               │               │
│   ready   │ ┌───────────────────────────────────────┐ │ · item detail │
│ ◉ Scout   │ │  … stage content …                    │ │ · claim links │
│   browsing│ │                                       │ │ · job logs    │
│ ○ Director│ │                                       │ │ · rights info │
│   idle    │ └───────────────────────────────────────┘ │               │
│ ○ Producer│  ── jobs rail (slim, bottom of stage) ──  │               │
├───────────┴───────────────────────────────────────────┴───────────────┤
│ status: ready · provider: OpenRouter (gpt-x) · ffmpeg ok · 2 jobs     │ ← status bar
└───────────────────────────────────────────────────────────────────────┘
```

- **Crew rail (left, 232 px):** project switcher, agent roster with live status (idle / working / awaiting you), project tree (research/, production/, studio/, delivery/, qc/)
- **Stage (center, tabs):** the six workflow surfaces (§5)
- **Inspector (right, 300–340 px, collapsible):** details for whatever is selected — asset, claim, job, approval, beat
- **Jobs rail:** persistent slim progress list for running jobs; click → Inspector log view

## 4. Screens

### 4.1 Home (no project)
Hero: app mark + one input — "What story do we tell today?" + runtime/format chips (runtime optional — empty shows "Auto" and the Director picks the best runtime from the research) + style preset picker. Recent projects grid below (poster = last rendered frame or style swatch). Drag-drop folder = open project.

### 4.2 Crew Chat (default tab)
Mixed message stream:

| Element | Style |
|---------|-------|
| User bubble | Right-aligned, `--surface-2`, 14 px |
| Showrunner message | Left, crew avatar, markdown; artifact links as chips |
| Plan card | Violet left-rail; tasks with agent badges + estimates; **[Approve] [Edit] [Cancel]** |
| Tool-call card | Mono header `scout · browser.read`, collapsible JSON args |
| Tool-result card | Teal/red left-rail; summary + counts; "open" deep-links into Assets/Bible/QC |
| Approval card | Amber left-rail, elevated; action, affected files, size/time estimate, rationale, buttons (PRD §8 gates) |
| Progress card | Slim bar + phase label + cancel |
| Live browser pane | Inline card mirroring Scout's page (screenshot stream), "focus window" button |

Composer: input + attach + @mention crew + slash commands (`/plan`, `/research`, `/bible`, `/produce`, `/render`, `/package`, `/status`).

### 4.3 Bible Reader (Director's output)
- Header: title, thesis line, runtime target ("≈ N min — decided from research" + the Director's one-line rationale when no user runtime was set), style preset
- **Emotional arc chart**: SVG curve (intensity × time) with beat chips (Hook, Context, Turn, Payoff…); clicking a chip seeks Preview
- Scene cards: thumbnail strip (assigned assets), intended-emotion tag, visual language summary, the Director's one-line scene look (`look:` — mood/layout/motion intent, visual direction pass), on-screen text plan, claim chips; beat chips carry open-loop markers (↺ opens / ✓ pays)
- Retention strip: re-hooks and pattern interrupts marked on a timeline ruler
- Style panel: preset picker (bible default or one of the seven niche presets) + accent/caption/vignette/grain overrides → `studio/style.json`; shows the Director-authored identity (`look` note + `transition_set` signature) and stays the user's last-writer override over it
- Edit affordances: inline text edit → versioned saves; "ask Director to revise selection" sends the selection back with a note

### 4.4 Asset Library
Grid (adaptive 120–200 px cells), filters: type / license / rights status / source provider; sort by relevance-added. Asset card: thumbnail, duration/size, license badge (PD / CC0 / CC BY / REVIEW / BLOCKED), claim-link count. Detail (Inspector): preview, provenance, SHA-256, "approve for download" (batch), "add to scene" (suggests to Director).

### 4.5 Script & VO
- Sections with voice direction chips (voice, pace, energy); claim IDs inline `(CLM004)`
- Per-section: estimated spoken time (measured voice pace), listen button (TTS preview), re-generate
- Subtitle pane: cue list with CPS warnings

### 4.6 Preview
In-app player (local protocol streaming); transport with beat markers; A/B: draft vs final; frame inspector (beginning/middle/end); QC + retention report panel (dead zones highlighted on timeline, LUFS meter, CPS issues). Visual QC findings (M7) render as severity-colored timeline markers (fail ▲ / warn ●) — clicking seeks to `t_s`, shows the sampled frame + evidence + suggestion, and offers the `/direct` re-pace/re-shot proposal when a `scene_id` is attached.

### 4.7 Delivery
Checklist card (MP4 ✓, SRT ✓, credits ✓, rights complete ✓), ZIP build button (gate G-F), YouTube kit: title options (radio), description+chapters editor, tags, thumbnail concept cards (3), end-screen plan, copy/export buttons. Visual QC badge (pass/warn/fail) with the findings list; when verdict `fail` parks gate G-V: "Package blocked — N fail-class findings" + Approve override (audited) / Fix & re-render.

### 4.8 Settings
Provider (key via secure field, model per agent), TTS (voice grid with play previews), media engine paths, appearance, project defaults, data & privacy (location, clear history, export).

## 5. Interaction states

| State | Indicator |
|-------|-----------|
| Agent working | Crew rail pulse + activity ticker in status bar |
| Awaiting you | Approval card + amber dot on Showrunner + optional toast |
| Job running | Jobs rail entry + progress card |
| Error | Red left-rail card with retry/fix actions; crew status `needs attention` |
| Offline/provider down | Status bar badge; composer disabled with reason |

Keyboard: `Enter` send · `Shift+Enter` newline · `⌘K` command palette · `1–6` stage tabs · `Space` play/pause (Preview) · `Esc` cancel job/dismiss.

## 6. Empty states

- No project: hero input (4.1)
- Chat, no brief: three example briefs as chips
- Assets empty: "Scout hasn't harvested anything yet — approve a research plan first"
- Bible empty: "Director writes the Bible after research is approved"
- Delivery empty: render checklist preview with locked/unlocked gates

## 7. Accessibility

WCAG 2.1 AA both themes: 4.5:1 text contrast, focus ring 2 px `--accent`, status never color-only (icon + label: ● running, ⏸ awaiting you, ✓ done, ✕ failed), full keyboard traversal, screen-reader labels on cards/progress, respects OS scale 100–225 % and reduced motion.

## 8. Component inventory (build order)

1. Design tokens + primitives (Button, Input, Chip, Badge, Card, Tabs, Rail, StatusDot)
2. Crew avatar set + status pulse
3. Chat message set (7 card types)
4. Approval card + edit-args sheet
5. Jobs rail + progress
6. Asset grid + Inspector detail
7. Beat map (SVG) + scene cards
8. Player + transport + beat markers
9. Settings forms
10. Command palette
