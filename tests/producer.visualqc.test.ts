import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SceneTiming, WorkflowJson } from '../src/main/producer/compositions'
import type { BridgeClient } from '../src/main/bridge'
import { ChatClient } from '../src/main/agent/chat'
import {
  buildVisionBatches,
  buildVisualReport,
  classifyScan,
  expectedHardCuts,
  gateShouldPark,
  planSampling,
  readVisualQcConfig,
  reviewBatch,
  sceneIntent,
  type QcScanResult,
  type ScanContext
} from '../src/main/producer/visualQc'
import { runVisionStage } from '../src/main/producer/pipeline'

/**
 * Visual QC Layer 0 (M7): the pure classification layer — raw ffmpeg detector
 * output + composition timings → findings with severities → qc/visual_report
 * verdicts + the G-V gate decision. The fixture-film bridge E2E lives in
 * bridge/test_qc_scan.py; here every threshold rule is pinned so a detector
 * or model change cannot silently re-grade a verdict.
 */

function timing(id: string, startS: number, durS: number, overlapInS = 0): SceneTiming {
  return { id, voSection: `sec-${id}`, startFrame: 0, frames: 0, startS, durS, trackIndex: 1, overlapInS, entranceS: 0.4 }
}

/** S01 0–10 · hard cut · S02 10–20 · crossfade · S03 19.5–30 */
const CTX: ScanContext = {
  durationS: 30,
  timings: [timing('S01', 0, 10), timing('S02', 10, 10), timing('S03', 19.5, 10.5, 0.5)]
}

const scan = (over: Partial<QcScanResult>): QcScanResult => ({
  sha256: 'a'.repeat(64),
  sha8: 'a'.repeat(8),
  duration_s: 30,
  black: [],
  freeze: [],
  silence: [],
  // The CTX fixture's expected hard cut (S02 at 10s) detected on cue — tests
  // that exercise other detectors inherit a satisfied cut assertion.
  cuts: [10.05],
  detectors: { black_min_s: 0.5, freeze_min_s: 2, silence_min_s: 1, scene_thresh: 0.2 },
  ...over
})

describe('expectedHardCuts / softBoundaries', () => {
  it('asserts only overlap-0 boundaries after the opening', () => {
    expect(expectedHardCuts(CTX.timings)).toEqual([{ t_s: 10, sceneId: 'S02' }])
  })
})

describe('classifyScan — black_frame', () => {
  it('fails an interior ≥2s black range and attributes its scene', () => {
    const f = classifyScan(scan({ black: [{ from_s: 12, to_s: 14.5 }] }), CTX)
    expect(f).toHaveLength(1)
    expect(f[0].class).toBe('black_frame')
    expect(f[0].severity).toBe('fail')
    expect(f[0].scene_id).toBe('S02')
    expect(f[0].id).toBe('F001')
  })

  it('warns (not fails) for black inside the film-edge fade window', () => {
    const f = classifyScan(scan({ black: [{ from_s: 27.5, to_s: 30 }] }), CTX)
    expect(f[0].severity).toBe('warn')
    expect(f[0].evidence).toContain('fade window')
  })

  it('skips sub-0.5s black flickers', () => {
    expect(classifyScan(scan({ black: [{ from_s: 12, to_s: 12.4 }] }), CTX)).toHaveLength(0)
  })
})

describe('classifyScan — frozen_frame / silence_gap', () => {
  it('fails an ≥8s freeze and warns on a 2–8s one', () => {
    const f = classifyScan(scan({ freeze: [{ from_s: 2, to_s: 11 }] }), CTX)
    expect(f[0].severity).toBe('fail')
    const w = classifyScan(scan({ freeze: [{ from_s: 2, to_s: 4.5 }] }), CTX)
    expect(w[0].severity).toBe('warn')
    expect(classifyScan(scan({ freeze: [{ from_s: 2, to_s: 3.5 }] }), CTX)).toHaveLength(0)
  })

  it('fails interior dead air ≥6s and skips lead-in/tail silence', () => {
    const f = classifyScan(scan({ silence: [{ from_s: 10, to_s: 17 }] }), CTX)
    expect(f[0].severity).toBe('fail')
    const w = classifyScan(scan({ silence: [{ from_s: 10, to_s: 13 }] }), CTX)
    expect(w[0].severity).toBe('warn')
    // lead-in ≤0.5s and tail (from ≥29s) are normal and never findings
    expect(classifyScan(scan({ silence: [{ from_s: 0, to_s: 0.5 }] }), CTX)).toHaveLength(0)
    expect(classifyScan(scan({ silence: [{ from_s: 29.2, to_s: 30 }] }), CTX)).toHaveLength(0)
    expect(classifyScan(scan({ silence: [{ from_s: 10, to_s: 11.5 }] }), CTX)).toHaveLength(0)
  })
})

describe('classifyScan — cut_mismatch assertion', () => {
  it('flags an unexpected detected cut (the off-by-one case)', () => {
    const f = classifyScan(scan({ cuts: [10.05, 14.3] }), CTX) // 14.3 has no boundary
    expect(f).toHaveLength(1)
    expect(f[0].class).toBe('cut_mismatch')
    expect(f[0].severity).toBe('warn')
    expect(f[0].t_s).toBe(14.3)
    expect(f[0].evidence).toContain('unexpected cut')
  })

  it('flags a missing expected hard cut', () => {
    const f = classifyScan(scan({ cuts: [] }), CTX) // boundary at 10 asserted, none detected
    expect(f).toHaveLength(1)
    expect(f[0].class).toBe('cut_mismatch')
    expect(f[0].evidence).toContain('not detected')
  })

  it('suppresses detected cuts near crossfade boundaries (S03 fades in)', () => {
    const f = classifyScan(scan({ cuts: [10.05, 19.6] }), CTX)
    expect(f).toHaveLength(0) // 10.05 matches the hard cut; 19.6 is the S03 fade midpoint
  })

  it('matches detected cuts within tolerance', () => {
    expect(classifyScan(scan({ cuts: [10.55] }), CTX)).toHaveLength(0) // ±0.6s
  })

  it('reports a drifted cut once (paired, not unexpected+missing)', () => {
    const f = classifyScan(scan({ cuts: [10.7] }), CTX) // 0.7s off the boundary
    expect(f).toHaveLength(1)
    expect(f[0].evidence).toContain('drifted')
    expect(f[0].evidence).toContain('0.7s off')
  })
})

describe('buildVisualReport + gateShouldPark', () => {
  it('derives the verdict from finding severities and stamps the master sha', () => {
    const fail = buildVisualReport(scan({}), classifyScan(scan({ black: [{ from_s: 12, to_s: 15 }] }), CTX), { vision: false })
    expect(fail.verdict).toBe('fail')
    expect(fail.master_sha256).toBe('a'.repeat(64))
    expect(fail.coverage.vision).toBe(false)
    expect(fail.coverage.detectors).toContain('cut_assert')
    expect(fail.notes.join(' ')).toContain('no provider call')

    const warn = buildVisualReport(scan({}), classifyScan(scan({ freeze: [{ from_s: 2, to_s: 4 }] }), CTX), { vision: false })
    expect(warn.verdict).toBe('warn')

    const pass = buildVisualReport(scan({}), [], { vision: false })
    expect(pass.verdict).toBe('pass')
  })

  it('parks G-V only on fail with blocking enabled', () => {
    const failReport = buildVisualReport(scan({}), classifyScan(scan({ black: [{ from_s: 12, to_s: 15 }] }), CTX), { vision: false })
    const warnReport = buildVisualReport(scan({}), classifyScan(scan({ freeze: [{ from_s: 2, to_s: 4 }] }), CTX), { vision: false })
    const cfg = { enabled: true, samplesPerSecond: 1, vision: true, blockOnFail: true }
    expect(gateShouldPark(failReport, cfg)).toBe(true)
    expect(gateShouldPark(warnReport, cfg)).toBe(false)
    expect(gateShouldPark(failReport, { ...cfg, blockOnFail: false })).toBe(false)
  })
})

describe('readVisualQcConfig', () => {
  it('defaults to enabled / 1 fps / vision on / blocking on', () => {
    expect(readVisualQcConfig(mkdtempSync(join(tmpdir(), 'vt-vqc-')))).toEqual({
      enabled: true,
      samplesPerSecond: 1,
      vision: true,
      blockOnFail: true
    })
  })

  it('reads the visual_qc block from project.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-vqc-'))
    writeFileSync(
      join(dir, 'project.yml'),
      ['title: X', 'visual_qc:', '  enabled: false', '  samples_per_second: 2', '  vision: false', '  block_on_fail: false', ''].join('\n'),
      'utf-8'
    )
    expect(readVisualQcConfig(dir)).toEqual({ enabled: false, samplesPerSecond: 2, vision: false, blockOnFail: false })
  })
})

// ------------------------------------------------------------------ Layer 1

describe('planSampling', () => {
  it('covers the uniform grid plus every boundary and transition midpoint', () => {
    const plan = planSampling(CTX.timings, 30, { samplesPerSecond: 1 })
    const has = (t: number): boolean => plan.times.some((x) => Math.abs(x - t) < 0.05)
    expect(has(0.1)).toBe(true) // grid start
    expect(has(10)).toBe(true) // hard-cut boundary
    expect(has(19.75)).toBe(true) // crossfade midpoint (19.5 + 0.5/2)
    expect(plan.truncated).toBe(false)
    expect(plan.times.length).toBeGreaterThanOrEqual(30)
  })

  it('caps at the budget, keeps cut points, and discloses truncation', () => {
    const plan = planSampling(CTX.timings, 30, { samplesPerSecond: 1 }, 10)
    expect(plan.times.length).toBeLessThanOrEqual(10)
    expect(plan.truncated).toBe(true)
    expect(plan.times.some((t) => Math.abs(t - 10) < 0.05)).toBe(true) // boundary survives the cap
  })
})

describe('buildVisionBatches + sceneIntent', () => {
  it('chunks ≤12 frames per batch in master-clock order', () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({
      t_s: i + 0.1,
      dataUrl: 'data:image/jpeg;base64,AA',
      intent: 'card title-01 "X"',
      vo: 'narration'
    }))
    const batches = buildVisionBatches(frames, 12)
    expect(batches.map((b) => b.frames.length)).toEqual([12, 12, 6])
    expect(batches[0].frames[0].t_s).toBeLessThan(batches[1].frames[0].t_s)
  })

  it('formats card and asset shots into a one-line plan', () => {
    expect(
      sceneIntent({
        shots: [
          { template: 'title-01', text: 'America\'s Lost Metropolis' },
          { asset: 'media\\images\\aerial_mound.jpg', motion: 'kenburns' }
        ]
      })
    ).toBe('card title-01 "America\'s Lost Metropolis"; kenburns aerial_mound.jpg')
  })
})

describe('reviewBatch (mock provider)', () => {
  const makeChat = (content: string): { chat: ChatClient; calls: Array<Record<string, unknown>> } => {
    const calls: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch
    return { chat: new ChatClient({ baseUrl: 'http://mock/v1', apiKey: 'k', model: 'vision-mock', fetchImpl, maxTokens: 512 }), calls }
  }

  const batch = {
    frames: [
      { t_s: 4.1, dataUrl: 'data:image/jpeg;base64,AA', scene_id: 'S02', intent: 'card title-01 "X"', vo: 'spoken words' },
      { t_s: 5.1, dataUrl: 'data:image/jpeg;base64,BB', scene_id: 'S02', intent: 'card title-01 "X"', vo: 'spoken words' }
    ]
  }

  it('sends image parts + scene context and clamps the findings hard', async () => {
    const { chat, calls } = makeChat(
      'Here is my review:\n[{"class":"visual_mismatch","t_s":4.05,"severity":"fail","evidence":"narration says city, frame shows a map","suggestion":"swap the shot"},' +
        '{"class":"render_artifact","t_s":5.1,"severity":"fail","evidence":"torn border"},' +
        '{"class":"made_up_class","t_s":4.1,"severity":"fail","evidence":"junk"},' +
        '{"class":"subtitle_clip","t_s":99.9,"severity":"fail","evidence":"hallucinated time"}]'
    )
    const res = await reviewBatch(chat, batch)
    expect(res.findings).toHaveLength(2)
    // severity clamped: render_artifact may not fail
    expect(res.findings[0]).toMatchObject({ class: 'visual_mismatch', severity: 'fail', t_s: 4.1, scene_id: 'S02' })
    expect(res.findings[1]).toMatchObject({ class: 'render_artifact', severity: 'warn', t_s: 5.1 })
    expect(res.dropped).toBe(2)
    // request shape: multimodal content parts + scene context text
    const body = calls[0] as { messages: Array<{ content: unknown }> }
    const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(Array.isArray(parts)).toBe(true)
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2)
    expect(parts.find((p) => p.type === 'text')?.text).toContain('t=4.1s (S02)')
    expect(parts.find((p) => p.type === 'text')?.text).toContain('card title-01 "X"')
    expect(parts.find((p) => p.type === 'text')?.text).toContain('spoken words')
  })

  it('rejects non-JSON answers instead of guessing', async () => {
    const { chat } = makeChat('The frames look fine to me, no issues found!')
    await expect(reviewBatch(chat, batch)).rejects.toThrow(/no JSON array/)
  })
})

describe('runVisionStage (integration, mock provider + fake bridge)', () => {
  it('samples, reviews with context, merges findings; ids continue after Layer 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-vqc-stage-'))
    const sha8 = 'a'.repeat(8)
    const frameDir = join(dir, 'qc', 'visual_frames', sha8)
    mkdirSync(frameDir, { recursive: true })
    // Pre-write the full sampling plan like the real bridge would produce.
    const plan = planSampling(CTX.timings, 30, { samplesPerSecond: 1 })
    for (const t of plan.times) writeFileSync(join(frameDir, `f_${String(Math.round(t * 1000)).padStart(7, '0')}.jpg`), Buffer.from('fake-jpeg'))
    const bridgeCalls: string[] = []
    const bridge = {
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        bridgeCalls.push(method)
        if (method === 'qc.sample_frames') {
          return { frames: (params.times as number[]).map((t) => `qc/visual_frames/${sha8}/f_${String(Math.round(t * 1000)).padStart(7, '0')}.jpg`) }
        }
        throw new Error(`unexpected bridge call ${method}`)
      }
    }
    let fetchCalls = 0
    const fetchImpl: typeof fetch = (async (_url, init) => {
      fetchCalls++
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"class":"visual_mismatch","t_s":10.2,"severity":"fail","evidence":"mismatch"}, {"class":"caption_missing","t_s":10.3,"severity":"fail","evidence":"no caption"}]' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
    const chat = new ChatClient({ baseUrl: 'http://mock/v1', apiKey: 'k', model: 'vision-mock', fetchImpl })

    const res = await runVisionStage({
      bridge: bridge as unknown as Pick<BridgeClient, 'request'>,
      projectPath: dir,
      cfg: { enabled: true, samplesPerSecond: 1, vision: true, blockOnFail: true },
      timings: CTX.timings,
      scan: scan({ sha8 }),
      l0Count: 1,
      scenes: [
        { id: 'S01', vo: { script_section: 'sec-S01' } },
        { id: 'S02', vo: { script_section: 'sec-S02' } },
        { id: 'S03', vo: { script_section: 'sec-S03' } }
      ] as unknown as WorkflowJson['scenes'],
      voTextByScene: { S01: 'opening words', S02: 'mid words', S03: 'closing words' },
      vision: { chat, model: 'vision-mock' },
      setProgress: () => undefined,
      throwIfCancelled: () => undefined
    })

    expect(bridgeCalls).toEqual(['qc.sample_frames']) // exactly the sampling call
    expect(fetchCalls).toBe(Math.ceil(plan.times.length / 12)) // ≤12 frames/request
    expect(res.meta.vision).toBe(true)
    expect(res.meta.model).toBe('vision-mock')
    expect(res.meta.framesSampled).toBe(plan.times.length)
    // The mock answers the same 2 findings per batch: batches whose labels sit
    // within ±2s of t_s=10.2/10.3 accept them (t snapped to the labeled frame);
    // the last batch (>22s) drops both as hallucinated times.
    const mismatches = res.findings.filter((f) => f.class === 'visual_mismatch')
    expect(mismatches.length).toBeGreaterThanOrEqual(1)
    expect(mismatches[0]).toMatchObject({ severity: 'fail', t_s: 10.1, scene_id: 'S02' }) // snapped to the labeled frame
    expect(res.findings.filter((f) => f.class === 'caption_missing').every((f) => f.severity === 'warn')).toBe(true)
    // ids continue after the single Layer 0 finding (F001) → F002…
    expect(res.findings[0].id).toBe('F002')
    expect(res.findings[res.findings.length - 1].id).toBe(`F${String(res.findings.length + 1).padStart(3, '0')}`)
    expect(res.summary).toContain(`in ${Math.ceil(plan.times.length / 12)} batch(es)`)
  })
})
