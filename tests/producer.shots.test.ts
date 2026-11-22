import { describe, expect, it } from 'vitest'
import { computeSceneTimings, type CompositionScene, type CompositionShot } from '../src/main/producer/compositions'
import { buildShotListRows, type AssetRow } from '../src/main/producer/visuals'

/**
 * Regression: the produce-time shot_list.csv registration used to emit ONLY
 * injected-media rows, so any graphics-only stretch between media produced a
 * timeline gap — the bridge (and dwk.validate_project) rejected the write with
 * "shot row N: timeline gap/overlap". DWK v1 requires frame-contiguous rows
 * covering the whole picture, every row pointing at a local image/video file;
 * card stretches are exported as SVG stills into media/graphics/.
 */

const FPS = 24

function scene(id: string, shots: CompositionShot[], voS = 10): CompositionScene {
  return {
    id,
    vo: { script_section: id, voice: 'en-US-AndrewMultilingualNeural' },
    shots,
    transitions: { in: 'crossfade', out: 'crossfade' },
    claims: []
  }
}

const card = (text: string, dur = 5): CompositionShot => ({ kind: 'composition', template: 'title-card', text, dur_s: dur })
const barsCard = (dur = 10): CompositionShot => ({
  kind: 'composition',
  template: 'data-bars',
  text: 'Rankings',
  dur_s: dur,
  data: { kind: 'bars', title: 'Rankings', items: [{ label: 'Alpha', value: 10 }, { label: 'Beta', value: 5 }] }
})

const INJECTED = [
  {
    asset_id: 'AST-0001',
    sceneId: 's2',
    saved_path: 'media/images/x.jpg',
    media_type: 'image',
    claim_id: 'CLM-0001',
    source_id: 'SRC-0001',
    title: 'X photo'
  }
]

const LEDGER: AssetRow[] = [
  { asset_id: 'AST-0001', saved_path: 'media\\images\\x.jpg', source_id: 'SRC-0001', title: 'X photo' },
  { asset_id: 'AST-0002', saved_path: 'media/video/clip.mp4', source_id: 'SRC-0002', title: 'Archive clip' }
]

function build(scenes: CompositionScene[], voDurations: Record<string, number>) {
  const { timings, totalFrames } = computeSceneTimings(scenes, voDurations, FPS)
  return {
    ...buildShotListRows({ scenes, timings, fps: FPS, injected: INJECTED, ledger: LEDGER }),
    totalFrames
  }
}

describe('buildShotListRows (DWK contiguity)', () => {
  const scenes = [
    scene('s1', [card('A & B <intro>', 10)]),
    scene('s2', [card('Media scene', 5), { kind: 'asset', asset: 'media/images/x.jpg', dur_s: 5 }]),
    scene('s3', [barsCard()]),
    scene('s4', [card('Closing', 5), { kind: 'asset', asset: 'media/video/clip.mp4', dur_s: 5 }])
  ]
  const vo = { s1: 10, s2: 10, s3: 10, s4: 10 }
  const { rows, cardStills, mediaCount, totalFrames } = build(scenes, vo)

  it('tiles the whole picture timeline contiguously from frame 0', () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].start_frame).toBe(0)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].start_frame, `row ${i + 1} gap/overlap`).toBe(rows[i - 1].end_frame)
    }
    expect(rows[rows.length - 1].end_frame).toBe(totalFrames)
  })

  it('keeps media provenance on media rows', () => {
    const media = rows.filter((r) => r.asset_path === 'media/images/x.jpg')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      asset_type: 'image',
      source_id: 'SRC-0001',
      claim_id: 'CLM-0001',
      visual_label: 'X photo',
      notes: 'auto-injected research media (approved via gate G-M)'
    })
    expect(mediaCount).toBe(2) // x.jpg + the workflow-native clip.mp4
  })

  it('resolves workflow-native asset shots from the ledger (extension type, backslash-normalized)', () => {
    const clip = rows.filter((r) => r.asset_path === 'media/video/clip.mp4')
    expect(clip).toHaveLength(1)
    expect(clip[0]).toMatchObject({
      asset_type: 'video',
      source_id: 'SRC-0002',
      visual_label: 'Archive clip',
      notes: 'workflow shot (rights-approved)'
    })
  })

  it('backs every card stretch with an exported still (designed-graphic row)', () => {
    const cardRows = rows.filter((r) => r.notes === 'designed graphic (HyperFrames card still)')
    expect(cardRows.length).toBeGreaterThan(0)
    expect(cardStills).toHaveLength(cardRows.length)
    const rels = new Set(cardStills.map((s) => s.rel))
    for (const row of cardRows) {
      expect(row.asset_type).toBe('image')
      expect(rels.has(row.asset_path)).toBe(true)
      expect(row.asset_path.startsWith('media/graphics/card_')).toBe(true)
    }
  })

  it('renders content-true stills with XML-escaped text', () => {
    const svg = cardStills.find((s) => s.svg.includes('A &amp; B'))
    expect(svg).toBeDefined()
    expect(svg?.svg).not.toMatch(/<(?!\/?(svg|rect|text)\b)/) // no unescaped markup fragments
    const bars = cardStills.find((s) => s.svg.includes('Alpha'))
    expect(bars?.svg).toContain('fill="#6ea8fe"') // proportional bar drawn
  })
})
