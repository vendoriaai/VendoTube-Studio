import { describe, expect, it } from 'vitest'
import {
  chunkText,
  chunkTextShots,
  dataCardsForClaims,
  injectAssets,
  planVisuals,
  type AssetRow,
  type ClaimRow,
  type SourceRow
} from '../src/main/producer/visuals'
import { templateKind, type CompositionScene, type CompositionShot } from '../src/main/producer/compositions'

function scene(id: string, shots: CompositionShot[], opts: Partial<CompositionScene> = {}): CompositionScene {
  return {
    id,
    vo: { script_section: id.toLowerCase(), voice: 'en-US-AndrewMultilingualNeural' },
    shots,
    transitions: { in: 'fade', out: 'crossfade' },
    claims: [],
    ...opts
  }
}

const card = (text: string, dur_s = 4): CompositionShot => ({ kind: 'composition', template: 'vox-explainer/title-01', text, dur_s })

describe('chunkText', () => {
  it('splits on pipe separators and word-wraps overlong segments', () => {
    const chunks = chunkText('EIU Top 10: Vienna, Copenhagen, Zurich | Numbeo Top 10: The Hague, Eindhoven | Mercer: Zurich', 72)
    expect(chunks).toEqual(['EIU Top 10: Vienna, Copenhagen, Zurich', 'Numbeo Top 10: The Hague, Eindhoven', 'Mercer: Zurich'])
  })
  it('wraps a single mega-string into readable lines', () => {
    const chunks = chunkText('narration '.repeat(40).trim())
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 72 + 1)).toBe(true) // ≤ max + one word boundary tolerance
  })
})

describe('chunkTextShots', () => {
  it('expands an overlong title card into sequential chunk cards', () => {
    const mega = 'EIU Top 10: Vienna, Copenhagen, Zurich, Melbourne, Calgary, Geneva, Sydney, Vancouver, Osaka, Auckland | Numbeo Top 10: The Hague, Eindhoven'
    const out = chunkTextShots([scene('S01', [{ kind: 'composition', template: 'title-card', text: mega, dur_s: 12 }])])
    expect(out[0].shots.length).toBeGreaterThan(1)
    const total = out[0].shots.reduce((acc, s) => acc + (s.dur_s ?? 0), 0)
    expect(total).toBeCloseTo(12, 1)
    expect(out[0].shots.every((s) => (s.text ?? '').length <= 110)).toBe(true)
  })
  it('leaves short cards and asset shots untouched', () => {
    const scenes = [scene('S01', [card('Short headline'), { kind: 'asset', asset: 'media/images/a.jpg', dur_s: 4 }])]
    const out = chunkTextShots(scenes)
    expect(out[0].shots).toHaveLength(2)
  })
})

describe('dataCardsForClaims', () => {
  const claims: ClaimRow[] = [
    { claim_id: 'CLM-0004', claim_text: 'The Hague ranked #1 in Numbeo 2024 Quality of Life Index with a score of 217.3', source_id: 'WEB-0001' },
    { claim_id: 'CLM-0005', claim_text: 'Eindhoven ranked #2 with a score of 206.9', source_id: 'WEB-0001' },
    { claim_id: 'CLM-0008', claim_text: 'EIU Top 10: Vienna, Copenhagen, Zurich, Melbourne, Calgary, Geneva, Sydney', source_id: 'WEB-0002' }
  ]

  it('turns comparable scores into a bars card', () => {
    const scenes = [scene('S01', [card('Numbeo says the continent disagrees')], { claims: ['CLM-0004', 'CLM-0005'] })]
    const out = dataCardsForClaims(scenes, claims)
    const dataShot = out[0].shots.find((s) => s.data)
    expect(dataShot).toBeDefined()
    expect(templateKind(dataShot!.template)).toBe('bars')
    const items = dataShot!.data!.items
    expect(items).toHaveLength(2)
    expect(items[0].value).toBe(217.3)
    expect(items.map((i) => i.label)).toContain('The Hague')
  })

  it('turns a top-N claim into a ranked list card', () => {
    const scenes = [scene('S01', [card('Four indices, one question')], { claims: ['CLM-0008'] })]
    const out = dataCardsForClaims(scenes, claims)
    const dataShot = out[0].shots.find((s) => s.data)
    expect(templateKind(dataShot!.template)).toBe('list')
    expect(dataShot!.data!.items.length).toBeGreaterThanOrEqual(3)
  })

  it('falls back to a stat card for one standout figure', () => {
    // concrete magnitudes beat ranks for the stat callout…
    const claimsScore: ClaimRow[] = [{ claim_id: 'CLM-0009', claim_text: 'Vienna ranked #7 with a score of 189.1', source_id: 'WEB-0002' }]
    const out = dataCardsForClaims([scene('S01', [card('Vienna only seventh')], { claims: ['CLM-0009'] })], claimsScore)
    const stat = out[0].shots.find((s) => s.data)
    expect(templateKind(stat!.template)).toBe('stat')
    expect(stat!.data!.items[0].value).toBe(189.1)
    // …but a rank-only claim still becomes a #N stat
    const claimsRank: ClaimRow[] = [{ claim_id: 'CLM-0010', claim_text: 'Singapore ranked #30 overall in Mercer 2024', source_id: 'WEB-0003' }]
    const out2 = dataCardsForClaims([scene('S02', [card('Singapore at thirty')], { claims: ['CLM-0010'] })], claimsRank)
    const stat2 = out2[0].shots.find((s) => s.data)
    expect(templateKind(stat2!.template)).toBe('stat')
    expect(stat2!.data!.items[0].value).toBe(30)
    expect(stat2!.data!.unit).toBe('#')
  })

  it('never touches scenes the director already gave data (or without claims)', () => {
    const authored = scene('S01', [{ kind: 'composition', template: 'data-bars', text: 't', data: { kind: 'bars', items: [{ label: 'x', value: 1 }] }, dur_s: 4 }], { claims: ['CLM-0004'] })
    expect(dataCardsForClaims([authored], claims)[0].shots[0].data!.items[0].label).toBe('x')
    const noClaims = scene('S02', [card('nothing to chart')])
    expect(dataCardsForClaims([noClaims], claims)[0].shots).toHaveLength(1)
  })
})

describe('injectAssets', () => {
  const sources: SourceRow[] = [{ source_id: 'WEB-0001', url: 'https://www.numbeo.com/quality-of-life/rankings.jsp' }]
  const claims: ClaimRow[] = [{ claim_id: 'CLM-0004', claim_text: 'The Hague ranked #1', source_id: 'WEB-0001' }]
  const asset = (id: string, saved_path: string, page: string, status = 'approved', downloaded = true): AssetRow => ({
    asset_id: id,
    saved_path,
    asset_page_url: page,
    rights_status: status,
    downloaded,
    media_type: /\.(mp4)$/i.test(saved_path) ? 'video' : 'image',
    title: `Asset ${id}`
  })

  it('injects provenance-linked approved images and reports them', () => {
    const assets = [
      asset('A-0002', 'media/web/eiu.jpg', 'https://www.eiu.com/campaign'),
      asset('A-0006', 'media/screenshots/numbeo.jpg', 'https://www.numbeo.com/quality-of-life/rankings.jsp')
    ]
    const { scenes, injected } = injectAssets([scene('S01', [card('Numbeo crowns The Hague')], { claims: ['CLM-0004'] })], claims, sources, assets)
    expect(scenes[0].shots[0].kind).toBe('asset')
    expect(scenes[0].shots[0].asset).toBe('media/screenshots/numbeo.jpg')
    // linked numbeo asset first, then a round-robin pool pick (min-2 cadence)
    expect(injected).toHaveLength(2)
    expect(injected[0]).toMatchObject({ asset_id: 'A-0006', sceneId: 'S01', media_type: 'image', claim_id: 'CLM-0004', source_id: 'WEB-0001' })
    expect(injected[1].asset_id).toBe('A-0002')
  })

  it('round-robins unlinked images into scenes and skips review-status media', () => {
    const assets = [
      asset('A-0002', 'media/web/pool-a.jpg', 'https://example.com/x', 'review'),
      asset('A-0003', 'media/web/pool-b.jpg', 'https://example.com/y')
    ]
    const scenes = [scene('S01', [card('A')]), scene('S02', [card('B')], { claims: ['CLM-0004'] })]
    const { scenes: out, injected } = injectAssets(scenes, claims, sources, assets)
    // A-0002 is review → not usable; the only usable image (A-0003, unlinked) round-robins into S01, and provenance-less pool cannot fill a linked scene twice before others…
    const withAssets = out.filter((s) => s.shots.some((sh) => sh.kind === 'asset'))
    expect(withAssets.length).toBeGreaterThan(0)
    expect(injected.every((i) => i.asset_id !== 'A-0002')).toBe(true)
  })

  it('caps at one video per scene and never touches scenes that already reference assets', () => {
    const assets = [asset('A-0013', 'media/video/clip.mp4', 'https://www.numbeo.com/x'), asset('A-0014', 'media/video/clip2.mp4', 'https://www.numbeo.com/y')]
    const { scenes } = injectAssets([scene('S01', [card('V')], { claims: ['CLM-0004'] })], claims, sources, assets)
    const videos = scenes[0].shots.filter((s) => s.kind === 'asset' && /\.mp4$/i.test(s.asset ?? ''))
    expect(videos.length).toBeLessThanOrEqual(1)
    const authored = [scene('S02', [{ kind: 'asset', asset: 'media/images/mine.jpg', dur_s: 4 }])]
    const { scenes: untouched } = injectAssets(authored, claims, sources, assets)
    expect(untouched[0].shots).toHaveLength(1)
  })

  it('does not hand the same linked video clip to every scene', () => {
    // 2026-11-19: S01/S03/S04 all played the same clip because the injector
    // passed linkedVideos[0] to every scene without advancing a cursor.
    const vidSources: SourceRow[] = [
      { source_id: 'WEB-0001', url: 'https://www.youtube.com/watch?v=aaa' },
      { source_id: 'WEB-0002', url: 'https://www.youtube.com/watch?v=bbb' }
    ]
    const vidClaims: ClaimRow[] = [
      { claim_id: 'CLM-0001', claim_text: 'The studio was founded in 1998', source_id: 'WEB-0001' },
      { claim_id: 'CLM-0002', claim_text: 'The first game shipped in 2001', source_id: 'WEB-0002' }
    ]
    const video = (id: string, path: string, page: string): AssetRow => ({
      asset_id: id,
      saved_path: path,
      asset_page_url: page,
      rights_status: 'approved',
      downloaded: true,
      media_type: 'video',
      title: `Clip ${id}`
    })
    const assets = [
      video('A-0001', 'media/video/one.mp4', 'https://www.youtube.com/watch?v=aaa'),
      video('A-0002', 'media/video/two.mp4', 'https://www.youtube.com/watch?v=bbb')
    ]
    const scenes = [
      scene('S01', [card('Founded in 1998')], { claims: ['CLM-0001'] }),
      scene('S02', [card('First game in 2001')], { claims: ['CLM-0002'] }),
      scene('S03', [card('Founded again')], { claims: ['CLM-0001'] })
    ]
    const { scenes: out } = injectAssets(scenes, vidClaims, vidSources, assets)
    const picked = out.map((s) => s.shots.find((sh) => sh.kind === 'asset')?.asset).filter(Boolean)
    // Two clips, three scenes: each clip is used once and the third scene
    // simply carries no footage rather than replaying a worn-out clip.
    expect(picked).toHaveLength(2)
    expect(new Set(picked).size).toBe(picked.length)
    expect(picked).not.toContain(undefined)
  })

  it('places approved videos ahead of stills when a large image pool would starve them', () => {
    // 2026-11-18 marvel: 18 approved images + 3 approved videos. The sorted
    // round-robin filled every scene's two picks with the first images, so no
    // video ever reached the cut. Videos must be pulled first.
    const images = Array.from({ length: 18 }, (_, i) => asset(`A-00${String(i + 1).padStart(2, '0')}`, `media/web/img${i}.jpg`, 'https://en.wikipedia.org/x'))
    const videos = [
      asset('A-0019', 'media/video/one.mp4', 'https://www.youtube.com/a'),
      asset('A-0020', 'media/video/two.mp4', 'https://www.youtube.com/b'),
      asset('A-0021', 'media/video/three.mp4', 'https://www.youtube.com/c')
    ]
    const scenesIn = ['S01', 'S02', 'S03'].map((id) => scene(id, [card('x')], { claims: ['CLM-0004'] }))
    const { injected } = injectAssets(scenesIn, claims, sources, [...images, ...videos])
    const vids = injected.filter((i) => i.media_type === 'video')
    expect(vids.length).toBe(3)
  })

  it('any approved video may enter the cut (host need not match), with an exhibit caption', () => {
    // A downloaded, rights-approved video enters the cut even when its page
    // host (e.g. youtube.com) matches no claim source host — the 2026-11-18
    // marvel fix: strict host-linking silently dropped ALL YouTube footage.
    const unlinked = [asset('A-0020', 'media/video/drama.mp4', 'https://drama.example.com/x')]
    const { scenes: withVideo, injected: inj1 } = injectAssets([scene('S06', [card('Counterpoint')], { claims: ['CLM-0004'] })], claims, sources, unlinked)
    const vid = withVideo[0].shots.find((s) => /\.mp4$/i.test(s.asset ?? ''))
    expect(vid).toBeDefined()
    expect(vid!.text).toBe('Asset A-0020')
    expect(inj1[0].media_type).toBe('video')
    // A provenance-linked video still enters, also with a caption.
    const linked = [asset('A-0021', 'media/video/clip.mp4', 'https://www.numbeo.com/z')]
    const { scenes: withLinked, injected: inj2 } = injectAssets([scene('S06', [card('Counterpoint')], { claims: ['CLM-0004'] })], claims, sources, linked)
    const vid2 = withLinked[0].shots.find((s) => s.kind === 'asset' && /\.mp4$/i.test(s.asset ?? ''))
    expect(vid2).toBeDefined()
    expect(vid2!.text).toBe('Asset A-0021')
    expect(inj2[0].media_type).toBe('video')
  })

  it('leaves end-card-only scenes clean', () => {
    const assets = [asset('A-0003', 'media/web/pool.jpg', 'https://example.com')]
    const { scenes } = injectAssets([scene('S03', [{ kind: 'composition', template: 'end-card', text: 'The End', dur_s: 6 }])], claims, sources, assets)
    expect(scenes[0].shots[0].template).toBe('end-card')
  })

  it('visual direction: minimal/split scenes stay card-only, full-bleed leads with media, injected motion varies', () => {
    const assets = [asset('A-0003', 'media/web/pool.jpg', 'https://example.com'), asset('A-0004', 'media/web/pool2.jpg', 'https://example.com/2')]
    // minimal layout = card-forward by intent: no injection
    const minimal = injectAssets([scene('S01', [card('Data only')], { claims: ['CLM-0004'], visual: { layout: 'minimal' } })], claims, sources, assets)
    expect(minimal.injected).toHaveLength(0)
    expect(minimal.scenes[0].shots.every((sh) => sh.kind === 'composition')).toBe(true)
    // split layout ditto
    const split = injectAssets([scene('S01', [card('Data only')], { claims: ['CLM-0004'], visual: { layout: 'split' } })], claims, sources, assets)
    expect(split.injected).toHaveLength(0)
    // full-bleed = media-first: assets lead, cards follow
    const full = injectAssets([scene('S01', [card('Data only')], { claims: ['CLM-0004'], visual: { layout: 'full-bleed' } })], claims, sources, assets)
    expect(full.scenes[0].shots[0].kind).toBe('asset')
    expect(full.scenes[0].shots[1].kind).toBe('asset')
    expect(full.scenes[0].shots.at(-1)!.kind).toBe('composition')
    // injected motion is a deterministic per-scene cycle, not one fixed kenburns
    const two = injectAssets([scene('S01', [card('A')]), scene('S02', [card('B')], { claims: ['CLM-0004'] })], claims, sources, assets)
    const motions = two.scenes.flatMap((s) => s.shots.filter((sh) => sh.kind === 'asset').map((sh) => sh.motion))
    expect(motions).toContain('kenburns')
    expect(motions).toContain('push-in')
  })
})

describe('planVisuals (end-to-end plan)', () => {
  it('chunks text, derives data, injects media, and lists pending media for G-M', () => {
    const claims: ClaimRow[] = [
      { claim_id: 'CLM-0004', claim_text: 'The Hague ranked #1 with a score of 217.3', source_id: 'WEB-0001' },
      { claim_id: 'CLM-0005', claim_text: 'Eindhoven ranked #2 with a score of 206.9', source_id: 'WEB-0001' }
    ]
    const sources: SourceRow[] = [{ source_id: 'WEB-0001', url: 'https://www.numbeo.com/rankings' }]
    const assets: AssetRow[] = [
      { asset_id: 'A-0006', saved_path: 'media/screenshots/numbeo.jpg', asset_page_url: 'https://www.numbeo.com/rankings', rights_status: 'review', downloaded: true, media_type: 'image', title: 'Numbeo rankings' },
      { asset_id: 'A-0007', saved_path: 'media/web/other.jpg', asset_page_url: 'https://elsewhere.com/x', rights_status: 'approved', downloaded: true, media_type: 'image', title: 'Other' }
    ]
    const scenes = [scene('S01', [card('EIU: Vienna | Numbeo: The Hague | Mercer: Zurich | VisaGuide: Spain — four answers, one question')], { claims: ['CLM-0004', 'CLM-0005'] })]
    const plan = planVisuals({ scenes, claims, sources, assets })
    expect(plan.mediaPending.map((a) => a.asset_id)).toEqual(['A-0006'])
    expect(plan.scenes[0].shots.some((s) => s.kind === 'asset')).toBe(true) // approved A-0007 injected
    expect(plan.scenes[0].shots.some((s) => s.data?.kind === 'bars')).toBe(true) // scores → bars
    expect(plan.injected[0].asset_id).toBe('A-0007')
  })
})
