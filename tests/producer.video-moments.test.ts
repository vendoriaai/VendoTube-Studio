import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MOMENT_SAMPLE_COUNT,
  applyVideoMoments,
  parseMomentAnswer,
  pickVideoMoments,
  sampleTimes,
  snapToSample,
  spreadStartS,
  usableRange,
  videoTargets
} from '../src/main/producer/videoMoments'
import type { ChatClient } from '../src/main/agent/chat'
import type { BridgeClient } from '../src/main/bridge'
import type { CompositionScene } from '../src/main/producer/compositions'

/**
 * Video moments (2026-11-19): every video shot used to play its clip from
 * 0:00, so the same opening seconds repeated in every scene. These tests pin
 * the two-tier picker: a vision-model choice when one is configured, and a
 * deterministic spread (distinct, non-overlapping windows) otherwise.
 */

function scene(id: string, section: string, shots: CompositionScene['shots']): CompositionScene {
  return { id, vo: { script_section: section, voice: 'v' }, shots, claims: [] }
}

/** A clip long enough that several non-overlapping windows fit. */
const CLIP = 'media/video/history.mp4'
const CLIP_S = 600

function fakeBridge(framesPerClip = MOMENT_SAMPLE_COUNT): BridgeClient {
  return {
    async request(method: string, params?: unknown) {
      const p = (params ?? {}) as { times?: number[]; tag?: string; media_path?: string }
      if (method !== 'media.frames_at') throw new Error(`unexpected bridge method: ${method}`)
      const times = p.times ?? []
      const tag = p.tag ?? 'clip'
      // Tiny placeholder JPEGs: pickVideoMoments only base64-encodes them.
      const dir = join(tmpProject!, 'studio', 'video_frames', tag)
      mkdirSync(dir, { recursive: true })
      const frames = times.slice(0, framesPerClip).map((t) => {
        const rel = `studio/video_frames/${tag}/f_${String(Math.round(t * 1000)).padStart(7, '0')}.jpg`
        writeFileSync(join(tmpProject!, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        return { t_s: t, path: rel }
      })
      return { dir: `studio/video_frames/${tag}`, duration_s: CLIP_S, frames, requested: times.length }
    }
  } as unknown as BridgeClient
}

let tmpProject: string | null = null

describe('usableRange / spreadStartS', () => {
  it('leaves a margin at both clip edges', () => {
    const r = usableRange(100, 5)!
    expect(r.from).toBeGreaterThanOrEqual(0)
    expect(r.to).toBeLessThanOrEqual(95)
  })

  it('spreads consecutive shots across the clip without overlap', () => {
    const windowS = 4
    const starts = [0, 1, 2].map((i) => spreadStartS(i, 3, CLIP_S, windowS))
    for (let i = 1; i < starts.length; i++) {
      // Never the same seconds, never overlapping the previous window.
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(windowS)
    }
    // And always inside the playable range.
    const range = usableRange(CLIP_S, windowS)!
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(range.from)
      expect(s).toBeLessThanOrEqual(range.to)
    }
  })

  it('keeps a barely-longer clip inside its one playable span', () => {
    // 4.2s clip, 4s shot: only 0.2s of freedom, so every shot lands in it.
    for (const s of [spreadStartS(0, 3, 4.2, 4), spreadStartS(2, 3, 4.2, 4)]) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s + 4).toBeLessThanOrEqual(4.2 + 1e-9)
    }
  })

  it('never repeats a clip from 0:00 for later shots', () => {
    // The reported symptom: every scene showed the clip's opening seconds.
    expect(spreadStartS(1, 3, CLIP_S, 4)).toBeGreaterThan(1)
    expect(spreadStartS(2, 3, CLIP_S, 4)).toBeGreaterThan(1)
  })

  it('does not park a LONE shot in the clip\u2019s intro', () => {
    // A documentary upload opens on a title card/logo. One shot on one clip is
    // the common case, and starting it at 1s showed exactly that card
    // everywhere (2026-11-19 verification on the real film).
    for (const f of [0, 0.5, 1]) {
      const start = spreadStartS(0, 1, CLIP_S, 5, f)
      expect(start).toBeGreaterThan(CLIP_S * 0.1) // well past the opening
      expect(start).toBeLessThanOrEqual(usableRange(CLIP_S, 5)!.to)
    }
    // Position in the film still moves it, so it is not one fixed second.
    expect(spreadStartS(0, 1, CLIP_S, 5, 0)).not.toBe(spreadStartS(0, 1, CLIP_S, 5, 1))
  })

  it('wraps without becoming pixel-identical when there are more shots than lanes', () => {
    const a = spreadStartS(0, 2, CLIP_S, 4)
    const b = spreadStartS(2, 2, CLIP_S, 4) // second pass over the same clip
    expect(b).not.toBe(a)
  })
})

describe('sampling + snapping', () => {
  it('spaces samples evenly and inclusively', () => {
    const t = sampleTimes(10, 20, 3)
    expect(t).toEqual([10, 15, 20])
  })

  it('snaps a model answer to the nearest sampled still', () => {
    expect(snapToSample(15.8, [10, 15, 20])).toBe(15)
  })

  it('rejects a timestamp that matches no still (hallucination guard)', () => {
    expect(snapToSample(400, [10, 15, 20])).toBeNull()
  })

  it('parses a JSON object, a clock, or a bare number reply', () => {
    expect(parseMomentAnswer('{"t_s":42,"reason":"arcade"}')?.t_s).toBe(42)
    expect(parseMomentAnswer('I pick 1:23 of the clip')?.t_s).toBe(83)
    expect(parseMomentAnswer('`{"t_s":7}`')?.t_s).toBe(7)
  })
})

describe('pickVideoMoments', () => {
  it('gives every video shot a distinct in-point without a vision model', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-'))
    const scenes = [
      scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 4 }]),
      scene('S02', 'S02', [{ kind: 'composition', template: 'title-card', text: 'Chapter', dur_s: 3 }]),
      scene('S03', 'S03', [{ kind: 'asset', asset: CLIP, dur_s: 4 }]),
      scene('S04', 'S04', [{ kind: 'asset', asset: CLIP, dur_s: 4 }])
    ]
    const res = await pickVideoMoments({ projectPath: tmpProject, scenes, bridge: fakeBridge(), chat: null })

    expect(res.visionUsed).toBe(false)
    const starts = ['S01', 'S03', 'S04'].map((id) => res.picks.get(id)!.get(0)!.startS)
    expect(new Set(starts).size).toBe(3)
    expect(Math.min(...starts)).toBeGreaterThan(0)
    expect(res.picks.get('S02')).toBeUndefined() // a card shot has no moment
    for (const id of ['S01', 'S03', 'S04']) expect(res.picks.get(id)!.get(0)!.source).toBe('spread')
  })

  it('accepts a vision pick that matches a sampled still', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-vision-'))
    // The real samples span the clip's usable range, so answer with one of them.
    const range = usableRange(CLIP_S, 4)!
    const answerAt = sampleTimes(range.from, range.to, MOMENT_SAMPLE_COUNT)[3]
    const chat = {
      async complete() {
        return { content: JSON.stringify({ t_s: answerAt, reason: 'the arcade cabinet' }), toolCalls: [] }
      }
    } as unknown as ChatClient

    const scenes = [scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 4 }])]
    const res = await pickVideoMoments({
      projectPath: tmpProject,
      scenes,
      bridge: fakeBridge(5),
      chat,
      narrationBySection: { S01: 'Developers build arcade cabinets in 1995.' }
    })

    expect(res.notes.join(' | ')).not.toMatch(/failed|no sampled still/)
    const pick = res.picks.get('S01')!.get(0)!
    expect(res.visionUsed).toBe(true)
    expect(pick.source).toBe('vision')
    expect(pick.startS).toBeGreaterThan(0)
    expect(pick.reason).toContain('arcade')
  })

  it('falls back to the spread when the model hallucinates a timestamp', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-halluc-'))
    const notes: string[] = []
    const chat = {
      async complete() {
        return { content: '{"t_s":590}', toolCalls: [] } // no still is near 590
      }
    } as unknown as ChatClient

    const scenes = [scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 4 }])]
    const res = await pickVideoMoments({
      projectPath: tmpProject,
      scenes,
      bridge: fakeBridge(5),
      chat,
      onNote: (n) => notes.push(n)
    })

    expect(res.picks.get('S01')!.get(0)!.source).toBe('spread')
    expect(notes.join(' ')).toMatch(/matches no sampled still/)
  })

  it('falls back to the spread when the provider errors', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-err-'))
    const chat = {
      async complete() {
        throw new Error('provider exploded')
      }
    } as unknown as ChatClient

    const scenes = [scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 4 }])]
    const res = await pickVideoMoments({ projectPath: tmpProject, scenes, bridge: fakeBridge(5), chat })

    expect(res.picks.get('S01')!.get(0)!.source).toBe('spread')
    expect(res.notes.join(' ')).toMatch(/vision moment pick failed/)
  })

  it('never starts so late that the shot runs past the clip end', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-clamp-'))
    const chat = {
      // Picks the last still, which only works if the window still fits.
      async complete() {
        return { content: JSON.stringify({ t_s: 100 }), toolCalls: [] }
      }
    } as unknown as ChatClient
    const scenes = [scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 10 }])]
    const res = await pickVideoMoments({ projectPath: tmpProject, scenes, bridge: fakeBridge(5), chat })
    const pick = res.picks.get('S01')!.get(0)!
    expect(pick.startS + pick.windowS).toBeLessThanOrEqual(CLIP_S)
  })
})

describe('applyVideoMoments', () => {
  it('writes source_in onto the matching shots only', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-apply-'))
    const scenes = [
      scene('S01', 'S01', [
        { kind: 'composition', template: 'title-card', text: 'Intro', dur_s: 3 },
        { kind: 'asset', asset: CLIP, dur_s: 4 }
      ])
    ]
    const res = await pickVideoMoments({ projectPath: tmpProject, scenes, bridge: fakeBridge(), chat: null })
    const out = applyVideoMoments(scenes, res.picks)

    expect(out[0].shots![0].source_in).toBeUndefined() // card untouched
    expect(out[0].shots![1].source_in).toBeGreaterThan(0)
    // The input scenes are not mutated.
    expect(scenes[0].shots![1].source_in).toBeUndefined()
  })
})

describe('videoTargets', () => {
  it('collects asset and duo-panel video shots in film order', () => {
    const scenes = [
      scene('S01', 'S01', [
        { kind: 'asset', asset: CLIP, dur_s: 4 },
        {
          kind: 'composition',
          template: 'duo',
          dur_s: 5,
          panels: [{ asset: 'media/images/a.jpg' }, { asset: 'media/video/b.mp4' }]
        }
      ])
    ]
    const targets = videoTargets(scenes, 30)
    expect(targets.map((t) => t.asset)).toEqual([CLIP, 'media/video/b.mp4'])
  })
})

describe('bridge contract', () => {
  it('writes frames under studio/video_frames/<tag>/', async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'vf-moments-frames-'))
    const scenes = [scene('S01', 'S01', [{ kind: 'asset', asset: CLIP, dur_s: 4 }])]
    await pickVideoMoments({ projectPath: tmpProject, scenes, bridge: fakeBridge(), chat: null })
    // The picker probes duration via the same method, so the cache exists.
    expect(existsSync(join(tmpProject, 'studio', 'video_frames'))).toBe(true)
  })
})
