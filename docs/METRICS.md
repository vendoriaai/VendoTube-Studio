# PRD success metrics — measured record (M5)

PRD §10 targets vs. what the pipeline verifiably achieves today. Machine: dev box
(Windows 11, 8-worker Chrome render). The end-to-end numbers below come from the
`VENDOTUBE_M3_SMOKE=1` harness chain (2026-11-13 run) and M4 measurements; the 8–10
minute dogfood film remains the pending user-driven demo (needs the user's provider
key + a real subject).

| Metric | PRD target | Measured (2026-11-13) | Status |
|--------|-----------|----------------------|--------|
| Brief → project initialized | < 30 s | sample-film seeding ≈ 2–4 s (DWK init + seed writes) | ✅ |
| Brief → Bible ready (10-min film) | < 15 min | mechanism verified end-to-end on the smoke (Director loop + validation); real 10-min timing pending dogfood | ⏳ dogfood |
| End-to-end documentary incl. render | < 45 min | draft chain (10.2s film): ~3.5 min total incl. 2 scene renders; draft factor ≈ 3.4× realtime at 720p24 vs 7.7× at 1080p30; final-quality full render on 8-min film pending dogfood | ⏳ dogfood (mechanism ✅) |
| First-render QC pass rate | ≥ 90% | smoke chain: 100% pass (streams + full decode) across all runs incl. post-conform re-QC | ✅ (n small) |
| Retention: dead zones > 8 s | 0 | 0 on the smoke chain; checker v2 enforces the ceiling with a re-pace proposal | ✅ (mechanism) |
| Caption CPS violations | 0 | worst cue 14.5 CPS vs limit 17 (was 63 before the words-mapping fix) | ✅ (mechanism) |
| Rights violations shipped | 0 | hard gates intact (G-C human click; DWK license gate; unapproved assets rejected by shots_write) | ✅ by construction |
| Agent actions visible/auditable | 100% | agent_runs journal writes on Scout/Director/Producer + Inspector audit view; Scout journal `scout_sessions.jsonl`; Director/Producer phase journals | ✅ |
| Visual QC fail-class findings at package (M7) | 0 open | Layer 0 live on the 2026-11-15 smoke chain: verdict `warn` (0 fail / 1 warn — the synthetic title card holds static ~3 s, a true advisory; cut assertion clean); Layer 1 vision review verified against a mock provider (≤12-frame batches with scene context, hard finding clamping, zero provider calls when `agent.visual_model` is empty — asserted in the smoke harness); fixture film with planted defects reports black [3–5s] / silence [4–8s] / frozen [9–12s] / cuts {3,5,9} exactly (`bridge/test_qc_scan.py`); real-film dogfood pending | ✅ mechanism (⏳ dogfood) |

## Render throughput reference (this machine)

- 1080p30 draft: ~7.7× realtime (M3 spike: 11.5 s film in 89 s)
- 720p24 draft: ~3.4× realtime (M4 smoke: 10.2 s film, 2 segments, ~35 s of render)
- Span-segmented renders make draft→final loops additive: only stale scenes re-render.
