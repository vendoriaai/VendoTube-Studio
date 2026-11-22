# VendoTube Studio — Privacy & Data Note

**Version:** 2.0 (M5) · **Last updated:** 2026-11-13

## What stays on your machine

- **Projects** (research ledgers, media, scripts, bibles, compositions, renders, QC
  reports, delivery ZIPs) live under your projects root — `Documents/VendoTube Studio`
  by default, changeable in Settings/data. Deleting a project via the app never touches
  folders opened from outside that root.
- **Databases:** `%APPDATA%\VendoTube Studio\app.db` (SQLite) holds projects, chat,
  jobs, approvals, and agent-run journals. WAL mode; no cloud sync.
- **Keys:** the model provider key is DPAPI-encrypted (Electron `safeStorage`) and shown
  last-4 only. It is sent ONLY to the endpoint you configure in Settings.
- **No telemetry:** the app makes no analytics/error-reporting calls. Ever.

## What leaves your machine, and where

| Data | Destination | When |
|------|-------------|------|
| Your research briefs + LLM prompts (crew system prompts + digests) | the provider endpoint you configure (OpenRouter/Z.ai/Ollama…) | during Scout/Director runs |
| Narration text (script sections, claim ids stripped) | Microsoft Edge voices (`speech.platform.bing.com`, via edge-tts) | during TTS |
| Research page requests | the sites you research, with a plain app UA; robots.txt honored; no paywall/login bypass | during Scout browsing |
| Media downloads | the candidate file's origin (Commons/LOC/Archive/YouTube/web) | after your rights approval (G-B) or during research-time fetch (labeled, rights stay `review`) |

## Third-party components (license audit, M5)

| Component | License | Distribution note |
|-----------|---------|-------------------|
| DWK documentary_workflow_kit | MIT | bundled; copyright retained |
| HyperFrames CLI | Apache-2.0 | bundled as npm dependency |
| herk-edit-kit style library | MIT + kit use-permission (retain notice) | THIRD_PARTY_NOTICES + LICENSE retained in the repo; style-library tokens/layouts adapted, cards re-implemented in Studio's builder |
| GSAP | Standard GSAP "standard no-charge" license | bundled as npm dependency (webfonts/GSAP render locally) |
| edge-tts | GPL-3.0 | executed as an independent Python subprocess (bridge sidecar) — aggregation, not linking; its license text + source URL ship in THIRD_PARTY_NOTICES |
| yt-dlp, FFmpeg | GPL-2.0/LGPL-2.1 | external runtime dependencies (user-provided binaries; not redistributed in the dev milestone) |
| Microsoft Edge voices | Microsoft Online Services Terms | text sent for synthesis; disclosed in-app; SAPI offline fallback available |

## In-app disclosure

Settings → Data & privacy shows this summary in-app. edge-tts is an unofficial endpoint
(Microsoft may change it) — the app degrades to the offline SAPI fallback and discloses
the engine per section (PRD R3).
