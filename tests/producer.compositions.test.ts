import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  applyStyleOverrides,
  buildCompositions,
  computeSceneTimings,
  resolveSceneStyle,
  resolveStyle,
  resolveTransitionSet,
  safeName,
  scaleShotsToDuration,
  templateKind,
  transitionOverlap,
  type CompositionScene,
  type WorkflowJson
} from '../src/main/producer/compositions'

function scene(id: string, section: string, shots: CompositionScene['shots'], opts: Partial<CompositionScene> = {}): CompositionScene {
  return {
    id,
    vo: { script_section: section, voice: 'en-US-AndrewMultilingualNeural' },
    shots,
    transitions: { in: 'fade', out: 'crossfade' },
    claims: [],
    ...opts
  }
}

/** Write a real 2s test clip (frame baking needs a decodable source). */
function writeTestClip(file: string): boolean {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12', '-pix_fmt', 'yuv420p', file],
    { encoding: 'utf-8', windowsHide: true }
  )
  return r.status === 0 && existsSync(file)
}

describe('video in-points (source_in)', () => {
  it('bakes the frames at the shot\u2019s source_in, so clips are not replayed from 0:00', () => {
    // The reported symptom: every scene showed the same opening seconds. The
    // in-point must reach bakeVideoFrames (and the baked window must differ).
    const dir = mkdtempSync(join(tmpdir(), 'vf-srccin-'))
    mkdirSync(join(dir, 'media', 'video'), { recursive: true })
    const clip = join(dir, 'media', 'video', 'broll.mp4')
    if (!writeTestClip(clip)) return
    // A 2s test pattern is too short to seek in; build a 6s one instead.
    spawnSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x240:rate=12', clip], { windowsHide: true })

    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'asset', asset: 'media/video/broll.mp4', source_in: 4, dur_s: 2 }])
      ]
    }
    const res = buildCompositions({
      projectPath: dir,
      workflow,
      voDurations: { hook: 2 },
      stylePreset: 'vox-explainer',
      projectTitle: 'In-point Film'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    const seqDir = /assets\/(seq_S01_broll[^/]*)\//.exec(html)?.[1]
    expect(seqDir).toBeTruthy()

    // The baked window starts at source_in, so its first frame is NOT the
    // clip's first frame: compare against a bake of the whole clip.
    const bakedFirst = readFileSync(join(res.dir, 'assets', seqDir!, 'f0001.jpg'))
    const fullFirst = join(dir, 'whole-f0001.jpg')
    spawnSync('ffmpeg', ['-hide_banner', '-y', '-ss', '0', '-i', clip, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', fullFirst], { windowsHide: true })
    expect(bakedFirst.equals(readFileSync(fullFirst))).toBe(false)
  })
})

describe('plan size (PLAN_TOO_LARGE guard)', () => {
  it('does not copy the full source clip when frames bake, and prunes stale ones', () => {
    // A 2.3 GB source copied into assets/ pushed the renderer plan dir past its
    // 2 GiB ceiling and every render failed (2026-11-19). Only baked frames
    // should ever reach the compositions dir.
    const dir = mkdtempSync(join(tmpdir(), 'vf-plansize-'))
    mkdirSync(join(dir, 'media', 'video'), { recursive: true })
    writeTestClip(join(dir, 'media', 'video', 'broll.mp4'))
    // A stale source from an earlier build must disappear.
    const assetDir = join(dir, 'studio', 'compositions', 'assets')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'S01_old_source.mp4'), Buffer.alloc(2048, 1))

    const res = buildCompositions({
      projectPath: dir,
      workflow: {
        version: 1,
        render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
        scenes: [scene('S01', 'hook', [{ kind: 'asset', asset: 'media/video/broll.mp4', text: 'Archive b-roll', dur_s: 4 }])]
      },
      voDurations: { hook: 4 },
      stylePreset: 'vox-explainer',
      projectTitle: 'Plan Size'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')

    // The scene references frames, never the source file.
    expect(html).toContain('assets/seq_')
    expect(html).not.toMatch(/src="assets\/S01_broll\.mp4"/)
    // No multi-MB source lands in the staged assets folder.
    expect(existsSync(join(assetDir, 'S01_broll.mp4'))).toBe(false)
    // The stale source from the previous build is pruned.
    expect(existsSync(join(assetDir, 'S01_old_source.mp4'))).toBe(false)
  })
})

describe('safeName', () => {
  it('keeps the scene prefix and extension when a long title is truncated', () => {
    // A 90-char YouTube title used to keep only its TAIL, dropping the `S01_`
    // scene tag and collapsing distinct sources onto one staged name.
    const long = 'GRAND THEFT AUTO 1996 Making Of - GTA - Retro Gaming BBC Archive Collection Full Documentary.mp4'
    const staged = safeName(`S01_${long}`)
    expect(staged.startsWith('S01_')).toBe(true)
    expect(staged.endsWith('.mp4')).toBe(true)
    expect(staged.length).toBeLessThanOrEqual(70)
  })

  it('keeps two long titles in one scene distinct', () => {
    const a = safeName('S01_en.wikipedia.org_Grand_Theft_Auto_video_game_-_Wikipedia_1795015284.jpg')
    const b = safeName('S01_en.wikipedia.org_Grand_Theft_Auto_video_game_-_Wikipedia_1795015295.jpg')
    expect(a).not.toBe(b)
    expect(a.startsWith('S01_')).toBe(true)
  })

  it('leaves short names untouched apart from sanitizing', () => {
    expect(safeName('S01_GTA_-_Box_Front.jpg')).toBe('S01_GTA_-_Box_Front.jpg')
  })
})

describe('narration caption placement', () => {
  it('pins the caption to the bottom center of the frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-cap-'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [scene('S01', 'hook', [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The Lost City', dur_s: 3 }])]
    }
    const res = buildCompositions({
      projectPath: dir,
      workflow,
      voDurations: { hook: 3 },
      stylePreset: 'vox-explainer',
      projectTitle: 'Caption Film',
      voWords: { hook: [{ word: 'The', start_s: 0.1, dur_s: 0.3 }, { word: 'Lost', start_s: 0.4, dur_s: 0.5 }] }
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    const capRule = html.slice(html.indexOf(' .cap {'), html.indexOf(' .cap {') + 400)
    expect(capRule).toContain('left: 50%')
    expect(capRule).toContain('transform: translateX(-50%)')
    expect(capRule).toContain('text-align: center')
  })
})

describe('transitionOverlap', () => {
  it('crossfades overlap by 0.5s', () => {
    expect(transitionOverlap('crossfade', 'crossfade')).toBe(0.5)
  })
  it('fades overlap by 0.4s', () => {
    expect(transitionOverlap('fade', 'fade')).toBe(0.4)
  })
  it('cuts do not overlap', () => {
    expect(transitionOverlap('cut', 'cut')).toBe(0)
  })
})

describe('computeSceneTimings', () => {
  it('makes the VO the timeline authority (scene starts follow narration)', () => {
    const scenes = [
      scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', text: 'A', dur_s: 6 }]),
      scene('S02', 's01', [{ kind: 'composition', template: 'title-card', text: 'B', dur_s: 8 }])
    ]
    const fps = 30
    const { timings, totalFrames, totalDurationS } = computeSceneTimings(scenes, { hook: 6.5, s01: 8.2 }, fps)
    expect(timings[0].startS).toBe(0)
    expect(timings[0].frames).toBe(Math.round(6.5 * fps))
    // S02 starts at S01's audio end minus the crossfade overlap (out=crossfade → 0.5s)
    expect(timings[1].startFrame).toBe(Math.round(6.5 * fps) - Math.round(0.5 * fps))
    // The final scene absorbs the overlap so the picture lasts exactly as long as the narration.
    expect(totalFrames).toBe(Math.round((6.5 + 8.2) * fps))
    expect(totalDurationS).toBeCloseTo((6.5 + 8.2), 1)
  })

  it('clamps the overlap so a scene never starts before its predecessor begins', () => {
    const scenes = [
      scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', dur_s: 2 }]),
      scene('S02', 's01', [{ kind: 'composition', template: 'title-card', dur_s: 2 }])
    ]
    const { timings } = computeSceneTimings(scenes, { hook: 0.5, s01: 0.5 }, 30)
    expect(timings[1].startFrame).toBeGreaterThan(timings[0].startFrame)
  })

  it('enforces a minimum scene length', () => {
    const scenes = [scene('S01', 'hook', [{ kind: 'composition', dur_s: 1 }])]
    const { timings } = computeSceneTimings(scenes, { hook: 0.01 }, 30)
    expect(timings[0].frames).toBeGreaterThanOrEqual(24)
  })
})

describe('scaleShotsToDuration', () => {
  it('scales shot durations to fill the scene exactly on the frame grid', () => {
    const shots = [
      { kind: 'asset' as const, asset: 'media/images/a.jpg', dur_s: 4 },
      { kind: 'composition' as const, template: 'title-card', dur_s: 2 }
    ]
    const scaled = scaleShotsToDuration(shots, 10, 30)
    const frames = scaled.reduce((acc, s) => acc + s.frames, 0)
    expect(frames).toBe(300)
    expect(scaled[0].frames).toBeGreaterThan(scaled[1].frames) // weights respected
    expect(scaled.every((s) => s.frames >= 1)).toBe(true)
  })

  it('substitutes a title card when a scene has no shots', () => {
    const scaled = scaleShotsToDuration([], 6, 30)
    expect(scaled).toHaveLength(1)
    expect(scaled[0].shot.kind).toBe('composition')
    expect(scaled[0].frames).toBe(180)
  })
})

describe('templateKind', () => {
  it('maps template ids to card kinds', () => {
    expect(templateKind('vox-explainer/title-01')).toBe('title')
    expect(templateKind('end-card')).toBe('end')
    expect(templateKind('lower-third')).toBe('lower')
    expect(templateKind('quote-card')).toBe('quote')
    expect(templateKind('source-card')).toBe('source')
    expect(templateKind('data-line')).toBe('line')
    expect(templateKind('data-timeline')).toBe('timeline')
    expect(templateKind('data-map')).toBe('map')
    expect(templateKind('article-card')).toBe('article')
    expect(templateKind(undefined)).toBe('title')
  })
})

describe('resolveStyle', () => {
  it('knows both bundled presets and falls back honestly', () => {
    const vox = resolveStyle('vox-explainer')
    expect(vox.bg).toBe('#0b0b0c') // editorial: black canvas
    expect(vox.paper).toBe('#e7e3d4') // cream panel
    expect(vox.design).toBe('editorial')
    expect(vox.fontHead).toContain('Archivo')
    const kal = resolveStyle('kallaway')
    expect(kal.bg).toBe('#0A0E14')
    expect(kal.glowHeadline).toBe(true)
    expect(kal.design).toBe('glass')
    const custom = resolveStyle('something-custom')
    expect(custom.key).toBe('something-custom')
    expect(custom.glowHeadline).toBe(false) // editorial house fallback
    expect(custom.design).toBe('editorial')
  })

  it('knows the craft-pass niche presets (research §3.1)', () => {
    const crime = resolveStyle('true-crime')
    expect(crime.key).toBe('true-crime')
    expect(crime.design).toBe('case-file')
    expect(crime.captions).toBe('boxed')
    expect(crime.vignette).toBe(true)
    expect(crime.fontHead).toContain('Fraunces')
    const history = resolveStyle('archival-history')
    expect(history.key).toBe('archival-history')
    expect(history.design).toBe('newsprint')
    expect(history.fontHead).toContain('Fraunces')
    expect(history.vignette).toBe(true)
    // 'science-explainer' contains "explainer" — it must resolve as its own family, not vox
    const science = resolveStyle('science-explainer')
    expect(science.key).toBe('science-explainer')
    expect(science.design).toBe('vivid')
    expect(science.glowHeadline).toBe(true)
    const investigative = resolveStyle('investigative-cinema')
    expect(investigative.key).toBe('investigative-cinema')
    expect(investigative.design).toBe('noir')
    expect(investigative.captions).toBe('boxed')
    const business = resolveStyle('business-clean')
    expect(business.key).toBe('business-clean')
    expect(business.design).toBe('bright')
    expect(business.grain).toBe(0)
    expect(business.accents).toBe('none')
  })

  it('gives every preset a distinct design language, not just a palette', () => {
    const presets = [
      'vox-explainer',
      'kallaway',
      'true-crime',
      'archival-history',
      'science-explainer',
      'investigative-cinema',
      'business-clean'
    ]
    const designs = presets.map((p) => resolveStyle(p).design)
    expect(new Set(designs).size).toBe(presets.length) // seven presets, seven skeletons
    for (const p of presets) {
      const st = resolveStyle(p)
      expect(st.mono, `${p} needs a mono stack`).toContain('JetBrains Mono')
      expect(st.fonts.length, `${p} needs vendored fonts`).toBeGreaterThan(0)
    }
  })

  it('lets style.json switch the preset family (craft-pass presets included)', () => {
    const switched = applyStyleOverrides(resolveStyle('vox-explainer'), { preset: 'true-crime' })
    expect(switched.key).toBe('true-crime')
    expect(switched.captions).toBe('boxed')
    expect(switched.design).toBe('case-file')
    expect(switched.fonts).toEqual(resolveStyle('true-crime').fonts)
  })
})

describe('kenburns craft pass (research §4.1)', () => {
  it('keeps long shots inside the ~1.5%/s zoom band and eases the move', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-kb-'))
    const mediaDir = join(dir, 'media', 'images')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'long.jpg'), Buffer.from('fakejpg'))

    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [scene('S01', 'hook', [{ kind: 'asset', asset: 'media/images/long.jpg', motion: 'kenburns', zoom: 1.08, dur_s: 15 }])]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 15 }, stylePreset: 'vox-explainer', projectTitle: 'KB' })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    // 15s shot: speed floor 1 + 0.015*15 = 1.225 travel over authored 1.08 → end ≈1.305
    expect(html).toMatch(/tl\.fromTo\('\.kb-0'.*ease: 'power1\.inOut'/)
    expect(html).toContain('scale: 1.305')
    expect(html).toContain('scale: 1.08,')
  })
})

describe('buildCompositions', () => {
  it('never renders an empty card: payload-less data shots become chapter cards, exhibits contain+blur small sources', () => {
    // Regression (2026-11-15, stock-market film): the Director wrote data-stat/
    // bars/list shells with text:'' and no payload; the emitter fell through to
    // a title-card with an EMPTY headline — the viewer saw a blank cream frame
    // with only the kicker for 10s at a time. Same film: a tiny logo under
    // cover-zoom filled the exhibit frame as giant blurry letters.
    const dir = mkdtempSync(join(tmpdir(), 'vf-antiblank-'))
    mkdirSync(join(dir, 'media', 'images'), { recursive: true })
    writeFileSync(join(dir, 'media', 'images', 'logo.png'), Buffer.from('fakepng'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          { kind: 'composition', template: 'data-stat', text: '', dur_s: 6 },
          { kind: 'composition', template: 'data-list', dur_s: 4 },
          { kind: 'asset', asset: 'media/images/logo.png', text: 'Exchange history logo', dur_s: 4 }
        ])
      ]
    }
    const res = buildCompositions({
      projectPath: dir,
      workflow,
      voDurations: { hook: 14 },
      stylePreset: 'kallaway',
      projectTitle: 'Anti-blank'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    // no empty headline anywhere in the scene (attribute-bounded so the match
    // cannot span into the timeline JS)
    expect(html).not.toMatch(/class="card-headline[^"]*">\s*<\/div>/)
    // both payload-less data shots became chapter cards carrying the scene label
    expect((html.match(/chapter-card/g) ?? []).length).toBe(2)
    // timeline mirrors the markup: card tweens, not stat tweens on missing nodes
    expect(html).not.toMatch(/\.shot-0 \.stat-value/)
    expect(html).toMatch(/\.shot-0 \.card-headline/)
    // exhibits render the blurred-backdrop + contain-foreground pair
    expect(html).toContain('kb-bg')
    expect(html).toContain('kb-fg')
    expect(html).toMatch(/object-fit: contain/)
  })

  it('renders data cards, video b-roll layers, and auto-sized headlines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-data-'))
    const projectPath = dir
    const mediaDir = join(projectPath, 'media')
    mkdirSync(join(mediaDir, 'images'), { recursive: true })
    mkdirSync(join(mediaDir, 'video'), { recursive: true })
    writeFileSync(join(mediaDir, 'images', 'city.jpg'), Buffer.from('fakejpg'))
    writeTestClip(join(mediaDir, 'video', 'broll.mp4'))

    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          {
            kind: 'composition',
            template: 'data-bars',
            text: 'Quality of Life Index',
            data: {
              kind: 'bars',
              title: 'Quality of Life Index',
              items: [
                { label: 'The Hague', value: 217.3 },
                { label: 'Vienna', value: 189.1 }
              ]
            },
            dur_s: 6
          },
          { kind: 'asset', asset: 'media/images/city.jpg', dur_s: 3 },
          { kind: 'asset', asset: 'media/video/broll.mp4', dur_s: 3 },
          { kind: 'composition', template: 'title-card', text: 'A headline that runs much longer than forty comfortable characters would ever need to', dur_s: 3 }
        ])
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 12 },
      stylePreset: 'vox-explainer',
      projectTitle: 'Data Film'
    })

    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    // bars card: fills + widths + GSAP growth tween
    expect(html).toContain('data-card')
    expect(html).toContain('bar-fill-0')
    expect(html).toContain('width:100%') // max value row
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.bar-fill-0'/)
    expect(html).toContain('Quality of Life Index')
    expect(html).toContain('217.3')
    // video asset layer (baked frames, timed by the shot's own GSAP driver) + image layer + Ken Burns
    expect(html).not.toContain('<video')
    expect(html).toContain('class="kvf kvf-0"')
    expect(html).toMatch(/tl\.set\('\.shot-\d+ \.kvf-0', \{ display: 'block' \}/)
    expect(html).toContain('src="assets/S01_city.jpg"')
    expect(html).toMatch(/tl\.fromTo\('\.kb-1'/)
    // long headline auto-shrinks into the safe tier; caption-safe card padding present
    expect(html).toContain('headline-sm')
    expect(html).toContain('padding-bottom: 110px')
  })

  it('emits a self-contained HyperFrames project (root, scenes, assets, gsap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-comp-'))
    const projectPath = dir
    // fake asset on disk
    const mediaDir = join(projectPath, 'media', 'images')
    const img = join(mediaDir, 'a_test.jpg')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(img, Buffer.from('fakejpg'))

    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The Lost City', dur_s: 6 }]),
        scene('S02', 's01', [
          { kind: 'asset', asset: 'media/images/a_test.jpg', motion: 'kenburns', zoom: 1.08, dur_s: 4 },
          { kind: 'composition', template: 'lower-third', text: 'Cahokia — Illinois', dur_s: 2 }
        ], { transitions: { in: 'crossfade', out: 'crossfade' } }),
        scene('S03', 's02', [{ kind: 'composition', template: 'end-card', text: 'The End', dur_s: 5 }], { transitions: { in: 'fade', out: 'fade' } })
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 6.0, s01: 8.0, s02: 5.0 },
      stylePreset: 'vox-explainer',
      projectTitle: 'Test Film'
    })

    expect(existsSync(join(res.dir, 'index.html'))).toBe(true)
    expect(existsSync(join(res.dir, 'vendor', 'gsap.min.js'))).toBe(true)
    for (const f of res.sceneFiles) expect(existsSync(join(res.dir, f))).toBe(true)
    expect(existsSync(join(res.dir, 'assets', 'S02_a_test.jpg'))).toBe(true)
    expect(res.sceneTimings).toHaveLength(3)
    expect(res.totalFrames).toBeGreaterThan(0)

    const root = readFileSync(join(res.dir, 'index.html'), 'utf-8')
    expect(root).toContain('data-composition-id="film-master"')
    expect(root).toContain('data-composition-src="compositions/scene-S01.html"')
    expect(root).toContain('data-start="0"')
    expect(root).toContain('data-no-timeline') // root carries clips only — skip the 45s timeline poll
    expect(root).toContain(`data-duration="${res.totalDurationS}"`)
    expect(root).toContain('id="clip-S01"')

    const scene1 = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(scene1).toContain('<template id="scene-S01-template">')
    expect(scene1).toContain('window.__timelines["scene-S01"]')
    expect(scene1).toContain('paused: true')
    expect(scene1).toContain('vendor/gsap.min.js')
    expect(scene1).toContain('#0b0b0c') // editorial canvas
    expect(scene1).toContain('data-design="editorial"')
    expect(scene1).toContain('furn-idx') // design furniture, not just a palette
    expect(scene1).toContain("@font-face { font-family: 'Archivo'") // vendored fonts, no web fetches
    expect(scene1).toContain("@font-face { font-family: 'JetBrains Mono'")
    expect(existsSync(join(res.dir, 'assets', 'fonts', 'Archivo-var.woff2'))).toBe(true)
    expect(existsSync(join(res.dir, 'assets', 'fonts', 'JetBrainsMono-var.woff2'))).toBe(true)

    const scene2 = readFileSync(join(res.dir, 'compositions', 'scene-S02.html'), 'utf-8')
    expect(scene2).toContain('assets/S02_a_test.jpg')
    expect(scene2).toContain("tl.fromTo('.kb-0'") // Ken Burns tween present
    expect(scene2).toContain('.lower-third')

    // Missing asset → honest error naming the scene
    const badWorkflow: WorkflowJson = {
      ...workflow,
      scenes: [scene('S01', 'hook', [{ kind: 'asset', asset: 'media/images/missing.jpg', dur_s: 4 }])]
    }
    expect(() =>
      buildCompositions({ projectPath, workflow: badWorkflow, voDurations: { hook: 4 }, stylePreset: 'vox-explainer', projectTitle: 'x' })
    ).toThrow(/missing.jpg/)
  })
})

describe('dark-exhibit restyle invariants', () => {
  const mediaDirBase = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-exhibit-'))
    const mediaDir = join(dir, 'media', 'images')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'shot.jpg'), Buffer.from('fakejpg'))
    return dir
  }

  it('renders screenshots as framed exhibits with source captions, not full-bleed layers', () => {
    const projectPath = mediaDirBase()
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'asset', asset: 'media/images/shot.jpg', text: 'Nature — AlphaFold 3, May 2024', dur_s: 6 }])
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 6 },
      stylePreset: 'kallaway',
      projectTitle: 'Exhibit Film'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toContain('exhibit-shot')
    expect(html).toContain('class="exhibit"')
    expect(html).toContain('exhibit-cap')
    expect(html).toContain('Nature — AlphaFold 3, May 2024')
    // the frame clips the media; no full-bleed img layer anymore
    expect(html).not.toMatch(/\[data-composition-id="scene-S01"\] \.shot \+ \.shot/)
  })

  it('never renders authored stage directions; interrupts are motion (flash + punch)', () => {
    const projectPath = mediaDirBase()
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', text: 'The Hook', dur_s: 8 }], { claims: [] })
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 8 },
      stylePreset: 'kallaway',
      projectTitle: 'Beat Film',
      sectionTitles: { hook: 'One Architecture, Three Miracles' },
      beats: [
        { id: 'B01', scene: 'S01', label: 'Hook', startS: 0, rehook: true, patternInterrupt: 'Triptych reveal — three domains flash in rhythm' }
      ]
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).not.toContain('pi-stamp')
    expect(html).not.toContain('rhcard')
    expect(html).not.toContain('Triptych reveal')
    expect(html).toContain('class="flash"')
    expect(html).toContain('class="chapter"')
    expect(html).toContain('>Hook</span>')
    // kicker is the section title, not the scene id
    expect(html).toContain('One Architecture, Three Miracles')
    expect(html).not.toContain('>S01<')
    // punch stays single-writer on the shot layer
    expect(html).toMatch(/tl\.to\('\.shot-0', \{ scale: '\+=0\.05'/)
  })

  it('fades the outgoing shot out at every cut (no layer stacking)', () => {
    const projectPath = mediaDirBase()
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          { kind: 'asset', asset: 'media/images/shot.jpg', dur_s: 4 },
          { kind: 'composition', template: 'title-card', text: 'After the shot', dur_s: 4 }
        ])
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 8 },
      stylePreset: 'kallaway',
      projectTitle: 'Cut Film'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toMatch(/tl\.to\('\.shot-0', \{ opacity: 0, duration: 0\.3/)
  })

  it('stat cards lead with the number; prose notes become annotations', () => {
    const projectPath = mediaDirBase()
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          {
            kind: 'composition',
            template: 'data-stat',
            text: '',
            data: { kind: 'stat', title: 'Protein-Ligand Accuracy', unit: '%', items: [{ label: 'Protein-Ligand Accuracy', value: 50, note: 'vs AlphaFold 2' }] },
            dur_s: 6
          }
        ])
      ]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 6 },
      stylePreset: 'kallaway',
      projectTitle: 'Stat Film'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toContain('<div class="stat-value">50%</div>')
    expect(html).toContain('<div class="stat-note">vs AlphaFold 2</div>')
  })

  it('fonts load on Windows: css urls are posix, never backslashed', () => {
    const projectPath = mediaDirBase()
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', text: 'Fonts', dur_s: 4 }])]
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 4 },
      stylePreset: 'kallaway',
      projectTitle: 'Font Film'
    })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toContain("url('../assets/fonts/")
    expect(html).not.toContain('assets\\fonts')
  })

  it('style.json preset override switches the whole preset family', () => {
    const kal = applyStyleOverrides(resolveStyle('vox-explainer'), { preset: 'kallaway' })
    expect(kal.key).toBe('kallaway')
    expect(kal.bg).toBe('#0A0E14')
    expect(kal.fonts).toEqual(resolveStyle('kallaway').fonts)
  })
})

// ------------------------------------------------- visual direction (2026-11-16)

describe('visual direction: resolveSceneStyle', () => {
  const base = resolveStyle('kallaway')

  it('is the identity for an absent or empty visual (back-compat)', () => {
    const none = resolveSceneStyle(base, undefined)
    expect(none.accent).toBe(base.accent)
    expect(none.grade).toBeNull()
    expect(none.grain).toBe(base.grain)
    expect(none.vignette).toBe(base.vignette)
  })

  it('shifts the accent and grades the moods deterministically', () => {
    const warm = resolveSceneStyle(base, { accent: '#b3542f', mood: 'warm' })
    expect(warm.accent).toBe('#b3542f')
    expect(warm.grade).not.toBeNull()
    expect(warm.grade!.color).toBe('#c96a2b')
    // deterministic: same input, same tokens
    expect(resolveSceneStyle(base, { accent: '#b3542f', mood: 'warm' })).toEqual(warm)
    // neutral = identity grade even with an accent shift
    expect(resolveSceneStyle(base, { mood: 'neutral' }).grade).toBeNull()
  })

  it('noir raises grain, forces the vignette, and desaturates the footage', () => {
    const bright = resolveStyle('business-clean') // grain 0, vignette false
    const noir = resolveSceneStyle(bright, { mood: 'noir' })
    expect(noir.vignette).toBe(true)
    expect(noir.grain).toBeGreaterThan(0)
    expect(noir.grade!.filter).toContain('grayscale(1)')
    expect(noir.grade!.blend).toBe('multiply')
  })

  it('never touches text/panel colors — light themes stay readable in every mood', () => {
    for (const mood of ['warm', 'cool', 'sepia', 'noir', 'vivid']) {
      const graded = resolveSceneStyle(base, { mood })
      expect(graded.text).toBe(base.text)
      expect(graded.panel).toBe(base.panel)
      expect(graded.panelBorder).toBe(base.panelBorder)
      expect(graded.fonts).toBe(base.fonts)
    }
  })

  it('falls back honestly on an invalid mood', () => {
    expect(resolveSceneStyle(base, { mood: 'neon-cyberpunk' }).grade).toBeNull()
  })
})

describe('visual direction: transition_set + dip-to-black', () => {
  const film = (overrides: Partial<CompositionScene> = {}): CompositionScene[] => [
    { id: 'S01', vo: { script_section: 'hook', voice: 'v' }, shots: [], claims: [], ...overrides },
    { id: 'S02', vo: { script_section: 's01', voice: 'v' }, shots: [], claims: [] }
  ]

  it('maps the four signatures (unknown → historical defaults)', () => {
    expect(resolveTransitionSet(undefined)).toEqual({ in: 'fade', out: 'crossfade' })
    expect(resolveTransitionSet('smooth')).toEqual({ in: 'fade', out: 'crossfade' })
    expect(resolveTransitionSet('hard-cuts')).toEqual({ in: 'cut', out: 'cut' })
    expect(resolveTransitionSet('cinematic').in).toBe('dip-to-black')
    expect(resolveTransitionSet('cinematic').out).toBe('crossfade')
    expect(resolveTransitionSet('broadcast')).toEqual({ in: 'cut', out: 'crossfade' })
    expect(resolveTransitionSet('whip-pans')).toEqual({ in: 'fade', out: 'crossfade' })
  })

  it('scenes without authored transitions inherit the transition_set', () => {
    const scenes = film() as CompositionScene[] // no transitions key at all
    const { timings } = computeSceneTimings(scenes, { hook: 6, s01: 6 }, 30, resolveTransitionSet('cinematic'))
    expect(timings[1].transitionIn).toBe('dip-to-black')
    expect(timings[1].entranceKind).toBe('dip-to-black')
    expect(timings[1].overlapInS).toBe(0.5)
    // explicit authored values win over the set (S02 authors cut, S01 authors its own out)
    const authored: CompositionScene[] = [
      { id: 'S01', vo: { script_section: 'hook', voice: 'v' }, shots: [], claims: [], transitions: { in: 'fade', out: 'cut' } },
      { id: 'S02', vo: { script_section: 's01', voice: 'v' }, shots: [], claims: [], transitions: { in: 'cut', out: 'crossfade' } }
    ]
    const t2 = computeSceneTimings(authored, { hook: 6, s01: 6 }, 30, resolveTransitionSet('cinematic')).timings
    expect(t2[1].entranceKind).toBe('cut')
    expect(t2[1].overlapInS).toBe(0)
  })

  it('dip-to-black keeps the gapless VO math (final scene absorbs the overlap)', () => {
    const scenes = film() as CompositionScene[]
    const { totalFrames, totalDurationS } = computeSceneTimings(scenes, { hook: 6, s01: 6 }, 30, resolveTransitionSet('cinematic'))
    expect(totalFrames).toBe(Math.round(12 * 30))
    expect(totalDurationS).toBeCloseTo(12, 1)
  })
})

describe('visual direction: motion grammar', () => {
  it('renders every motion variant; still locks the frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-motion-'))
    mkdirSync(join(dir, 'media', 'images'), { recursive: true })
    writeFileSync(join(dir, 'media', 'images', 'evidence.jpg'), Buffer.from('fakejpg'))
    const shot = (motion: string): CompositionScene['shots'] => [{ kind: 'asset', asset: 'media/images/evidence.jpg', motion, zoom: 1.1, dur_s: 4 }]
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', shot('push-in')),
        scene('S02', 's01', shot('pull-out')),
        scene('S03', 's02', shot('pan-left')),
        scene('S04', 's03', shot('still')),
        scene('S05', 's04', shot('kenburns'))
      ]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 4, s01: 4, s02: 4, s03: 4, s04: 4 }, stylePreset: 'kallaway', projectTitle: 'Motion' })
    const htmlOf = (id: string): string => readFileSync(join(res.dir, 'compositions', `scene-${id}.html`), 'utf-8')
    // push-in: axial scale 1.0 → authored zoom (≥ attention-band floor), no x/y drift
    const push = htmlOf('S01')
    expect(push).toContain("tl.fromTo('.kb-0', { scale: 1.0 }, { scale: 1.1, duration: 4")
    expect(push).not.toMatch(/\.kb-0'.*xPercent/)
    // pull-out: high → 1.0
    expect(htmlOf('S02')).toContain("tl.fromTo('.kb-0', { scale: 1.1 }, { scale: 1.0, duration: 4")
    // pan-left: lateral travel at scale headroom (+half → -half)
    expect(htmlOf('S03')).toContain("tl.fromTo('.kb-0', { scale: 1.12, xPercent: 2 }, { scale: 1.12, xPercent: -2, duration: 4")
    // still: no motion tween on the kb layer at all
    expect(htmlOf('S04')).not.toMatch(/tl\.(fromTo|to)\('\.kb-0'/)
    // kenburns unchanged: the 4-path diagonal drift
    expect(htmlOf('S05')).toMatch(/tl\.fromTo\('\.kb-0'.*xPercent: -1\.2/)
  })
})

describe('visual direction: scene look rendering', () => {
  const lookFilm = (): { htmlOf: (id: string) => string } => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-look-'))
    mkdirSync(join(dir, 'media', 'images'), { recursive: true })
    writeFileSync(join(dir, 'media', 'images', 'evidence.jpg'), Buffer.from('fakejpg'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        // noir + split cards + dip-to-black OUT (into S02)
        scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', text: 'The Turn', dur_s: 6 }], {
          visual: { mood: 'noir', layout: 'split' },
          transitions: { in: 'fade', out: 'dip-to-black' }
        }),
        // full-bleed exhibit + dip-to-black IN + scene accent shift
        scene('S02', 's01', [{ kind: 'asset', asset: 'media/images/evidence.jpg', text: 'The archive plate', dur_s: 6 }], {
          visual: { mood: 'sepia', layout: 'full-bleed', accent: '#b3542f' },
          transitions: { in: 'dip-to-black', out: 'crossfade' }
        }),
        // untouched scene: today's look, unchanged
        scene('S03', 's02', [{ kind: 'composition', template: 'title-card', text: 'The End', dur_s: 4 }])
      ]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 6, s01: 6, s02: 4 }, stylePreset: 'kallaway', projectTitle: 'Look' })
    return { htmlOf: (id: string): string => readFileSync(join(res.dir, 'compositions', `scene-${id}.html`), 'utf-8') }
  }

  it('grades the scene: overlay + footage filter, cards crisp', () => {
    const { htmlOf } = lookFilm()
    const noir = htmlOf('S01')
    expect(noir).toContain('class="grade"')
    expect(noir).toMatch(/\.grade \{[^}]*mix-blend-mode: multiply/)
    expect(noir).toMatch(/\.shot \.kb \{ filter: grayscale\(1\)/)
    // layout variant class present with its CSS
    expect(noir).toContain('ly-split')
    expect(noir).toMatch(/\.card \{ text-align: left; align-items: flex-start/)
  })

  it('full-bleed swaps the exhibit frame for cover media + scrim caption', () => {
    const { htmlOf } = lookFilm()
    const bleed = htmlOf('S02')
    expect(bleed).toContain('bleed-shot')
    expect(bleed).toContain('bleed-cap')
    expect(bleed).toContain('The archive plate')
    // no framed exhibit MARKUP (the base CSS keeps the .exhibit rules for other scenes)
    expect(bleed).not.toMatch(/<div class="exhibit">/)
    // scene accent shift reaches the ambient aurora tint
    expect(bleed).toContain('#b3542f38')
    // sepia grade + dip-in overlay
    expect(bleed).toMatch(/\.grade \{[^}]*#b0722d/)
    expect(bleed).toMatch(/tl\.fromTo\('\.dip', \{ opacity: 1 \}, \{ opacity: 0/)
  })

  it('dip-to-black OUT raises the black overlay before the cut', () => {
    const { htmlOf } = lookFilm()
    expect(htmlOf('S01')).toMatch(/tl\.to\('\.dip', \{ opacity: 1, duration: 0\.35/)
  })

  it('an untouched scene stays unchanged: no grade, no dip, no layout class', () => {
    const { htmlOf } = lookFilm()
    const plain = htmlOf('S03')
    expect(plain).not.toContain('class="grade"')
    expect(plain).not.toContain('class="dip"')
    expect(plain).not.toMatch(/ly-(split|centered|minimal|full-bleed)/)
    expect(plain).not.toMatch(/\.shot \.kb \{ filter/)
  })
})

describe('visual direction: transition_set drives buildCompositions', () => {
  const tsetWorkflow: WorkflowJson = {
    version: 1,
    render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
    scenes: [
      { id: 'S01', vo: { script_section: 'hook', voice: 'v' }, shots: [{ kind: 'composition', template: 'title-card', text: 'A', dur_s: 6 }], claims: [] },
      { id: 'S02', vo: { script_section: 's01', voice: 'v' }, shots: [{ kind: 'composition', template: 'title-card', text: 'B', dur_s: 6 }], claims: [] }
    ]
  }

  it('scenes without authored transitions get the film signature (cinematic → dips)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-tset-'))
    const res = buildCompositions({
      projectPath: dir,
      workflow: tsetWorkflow,
      voDurations: { hook: 6, s01: 6 },
      stylePreset: 'kallaway',
      projectTitle: 'TSet',
      styleOverrides: { transition_set: 'cinematic' }
    })
    expect(res.sceneTimings[1].entranceKind).toBe('dip-to-black')
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S02.html'), 'utf-8')
    expect(html).toMatch(/tl\.fromTo\('\.dip', \{ opacity: 1 \}/)
  })

  it('hard-cuts: no entrance fade, no overlap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-tset2-'))
    const res = buildCompositions({
      projectPath: dir,
      workflow: tsetWorkflow,
      voDurations: { hook: 6, s01: 6 },
      stylePreset: 'kallaway',
      projectTitle: 'TSet',
      styleOverrides: { transition_set: 'hard-cuts' }
    })
    expect(res.sceneTimings[1].overlapInS).toBe(0)
    expect(readFileSync(join(res.dir, 'compositions', 'scene-S02.html'), 'utf-8')).not.toMatch(/tl\.fromTo\('\.shot-0', \{ opacity: 0 \}/)
  })
})

// ------------------------------------------------- layout-fit + duo (2026-11-16)

describe('layout-fit pass: copy never overflows its box', () => {
  const buildOne = (shots: CompositionScene['shots'], stylePreset = 'archival-history'): { html: string; notes: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-fit-'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [scene('S01', 'hook', shots)]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 8 }, stylePreset, projectTitle: 'Fit' })
    return { html: readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8'), notes: res.layoutNotes }
  }

  it('renders a prose stat note as a fitted pull-quote, never as a 200px figure', () => {
    const { html, notes } = buildOne([
      {
        kind: 'composition',
        template: 'data-stat',
        text: '',
        data: {
          kind: 'stat',
          title: 'The record',
          items: [{ label: 'Britannica', note: "'a record of Eskimo life based on personal observation'" }]
        },
        dur_s: 8
      }
    ])
    expect(html).toContain('class="stat-quote"')
    expect(html).not.toContain('class="stat-value"')
    expect(html).toContain('Britannica')
    expect(notes.join(' ')).toMatch(/pull-quote/)
    // the quote is the only display block; no 190-218px nominal leaks through
    expect(html).not.toMatch(/class="stat-value"/)
  })

  it('keeps a numeric stat a figure and drops a title that repeats it', () => {
    const { html, notes } = buildOne([
      {
        kind: 'composition',
        template: 'data-stat',
        data: { kind: 'stat', title: '1,000+', items: [{ label: 'Actuality films, 1895–1905', value: 1000 }] },
        dur_s: 8
      }
    ])
    expect(html).toContain('<div class="stat-value">1000</div>')
    expect(html).not.toContain('1,000+')
    expect(notes.join(' ')).toMatch(/repeats the figure/)
  })

  it('shrinks a headline that cannot fit the card even after wrapping', () => {
    const text = Array.from({ length: 14 }, () => 'this headline keeps going well past any comfortable card length').join(' ')
    const { html } = buildOne([{ kind: 'composition', template: 'title-card', text, dur_s: 8 }])
    expect(html).toMatch(/class="card-headline headline-sm" style="font-size:\d+px"/)
  })

  it('centers card panels and keeps the chapter chip below the masthead', () => {
    const { html } = buildOne([{ kind: 'composition', template: 'title-card', text: 'Centered', dur_s: 8 }], 'archival-history')
    // newsprint used to hug the left edge with padding: 0 130px / flex-start
    expect(html).toMatch(/\.card-shot:not\(\.overlay-shot\) \{ padding: 0 130px; justify-content: center; \}/)
    expect(html).toContain('top: 118px')
    expect(html).toContain('left: 130px')
  })

  it('split cards are centered as a panel while their text stays left-aligned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-split-'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'composition', template: 'title-card', text: 'Split', dur_s: 8 }], {
          visual: { layout: 'split' }
        })
      ]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 8 }, stylePreset: 'archival-history', projectTitle: 'Split' })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toMatch(/\.card-shot \{ justify-content: center; padding: 0 120px; \}/)
    expect(html).toContain('text-align: left; align-items: flex-start; max-width: 1100px; margin: 0 auto;')
    expect(res.layoutNotes.join(' ')).toMatch(/split layout has no media/)
  })

  it('never animates text nodes that were not rendered (no GSAP missing-target warnings)', () => {
    const quote = buildOne([{ kind: 'composition', template: 'quote-card', text: '"A line with no byline"', dur_s: 4 }]).html
    expect(quote).not.toContain("tl.from('.shot-0 .quote-attr'")
    const stat = buildOne([
      { kind: 'composition', template: 'data-stat', data: { kind: 'stat', items: [{ label: 'Registry', value: 25 }] }, dur_s: 4 }
    ]).html
    expect(stat).not.toContain("tl.from('.shot-0 .stat-note'")
  })
})

describe('duo (two-box) composition', () => {
  it('renders two image+text panels, copies both assets, and moves each panel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-duo-'))
    mkdirSync(join(dir, 'media', 'images'), { recursive: true })
    writeFileSync(join(dir, 'media', 'images', 'before.jpg'), Buffer.from('fakejpg'))
    writeFileSync(join(dir, 'media', 'images', 'after.jpg'), Buffer.from('fakejpg'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          {
            kind: 'composition',
            template: 'duo',
            panels: [
              { asset: 'media/images/before.jpg', kicker: 'Port Harrison, 1920', title: 'A record of Eskimo life', note: 'the claim on the poster' },
              { asset: 'media/images/after.jpg', kicker: 'The set', title: 'A family cast for the camera', note: 'a staged household' }
            ],
            dur_s: 8
          }
        ])
      ]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 8 }, stylePreset: 'archival-history', projectTitle: 'Duo' })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toContain('duo-shot')
    expect(html).toContain('duo-panel-0')
    expect(html).toContain('duo-panel-1')
    expect(html).toContain('src="assets/S01_p0_0_before.jpg"')
    expect(html).toContain('src="assets/S01_p0_1_after.jpg"')
    expect(res.assetCount).toBe(2)
    expect(existsSync(join(res.dir, 'assets', 'S01_p0_0_before.jpg'))).toBe(true)
    expect(existsSync(join(res.dir, 'assets', 'S01_p0_1_after.jpg'))).toBe(true)
    // both panels carry media motion + a staggered entrance
    expect(html).toMatch(/tl\.fromTo\('\.kb-0-0'/)
    expect(html).toMatch(/tl\.fromTo\('\.kb-0-1'/)
    expect(html).toMatch(/\.duo-panel-0', \{ y: 30, opacity: 0/)
    expect(html).toMatch(/\.duo-panel-1', \{ y: 30, opacity: 0/)
  })

  it('fits long duo panel titles and notes to the panel text inset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-duo-fit-'))
    mkdirSync(join(dir, 'media', 'images'), { recursive: true })
    writeFileSync(join(dir, 'media', 'images', 'one.jpg'), Buffer.from('fakejpg'))
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [
          {
            kind: 'composition',
            template: 'duo',
            panels: [
              {
                asset: 'media/images/one.jpg',
                title: Array.from({ length: 8 }, () => 'a panel headline that keeps running past its own box').join(' '),
                note: Array.from({ length: 5 }, () => 'and an annotation that also has to wrap inside the panel').join(' ')
              },
              { title: 'Text-only panel' }
            ],
            dur_s: 8
          }
        ])
      ]
    }
    const res = buildCompositions({ projectPath: dir, workflow, voDurations: { hook: 8 }, stylePreset: 'vox-explainer', projectTitle: 'Duo Fit' })
    const html = readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
    expect(html).toMatch(/class="duo-title" style="font-size:\d+px"/)
    expect(html).toMatch(/class="duo-note" style="font-size:\d+px"/)
    expect(html).toContain('duo-panel-text') // second panel has no media — still a box
  })
})

describe('media treatments (2026-11-16 pass)', () => {
  const pngHeader = (path: string, width: number, height: number): void => {
    const b = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, b)
  }

  const build = (projectPath: string, scenes: CompositionScene[]): string => {
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes
    }
    const res = buildCompositions({
      projectPath,
      workflow,
      voDurations: Object.fromEntries(scenes.map((s) => [s.vo.script_section, 6])),
      stylePreset: 'archival-history',
      projectTitle: 'Media'
    })
    return readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8')
  }

  it('gives portrait sources a portrait plate instead of a landscape letterbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-media-portrait-'))
    pngHeader(join(dir, 'media', 'images', 'portrait.png'), 900, 1400)
    const html = build(dir, [
      scene('S01', 'hook', [{ kind: 'asset', asset: 'media/images/portrait.png', text: 'Portrait of John Grierson', dur_s: 6 }])
    ])
    expect(html).toContain('class="exhibit" style="width:450px;height:700px"')
    expect(html).toContain('Portrait of John Grierson')
  })

  it('renders a tall page screenshot as a browser plate cropped from the top', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-media-screen-'))
    pngHeader(join(dir, 'media', 'screenshots', 'en.wikipedia.org_John_Grierson_1.png'), 1200, 3600)
    const html = build(dir, [
      scene('S01', 'hook', [{ kind: 'asset', asset: 'media/screenshots/en.wikipedia.org_John_Grierson_1.png', text: 'Wikipedia — John Grierson', dur_s: 6 }])
    ])
    expect(html).toContain('screen-plate')
    expect(html).toContain('class="screen-bar"')
    expect(html).toContain('class="screen-url">en.wikipedia.org<')
    expect(html).toContain('screen-body-top')
    expect(html).toContain('Wikipedia — John Grierson')
    // exactly one writer on the page node: the top-anchored push-in
    expect(html).toContain("tl.fromTo('.shot-0 .screen-body .kb'")
    expect(html).not.toContain("tl.fromTo('.kb-0'")
  })

  it('frames video as a plate with a caption and never zooms the clip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-media-video-'))
    mkdirSync(join(dir, 'media', 'video'), { recursive: true })
    writeTestClip(join(dir, 'media', 'video', 'broll.mp4'))
    const html = build(dir, [
      scene('S01', 'hook', [{ kind: 'asset', asset: 'media/video/broll.mp4', motion: 'kenburns', text: 'Archive b-roll — actuality', dur_s: 6 }])
    ])
    expect(html).toContain('video-shot')
    expect(html).toContain('media-plate video-plate')
    expect(html).toContain('Archive b-roll — actuality')
    // Footage plays from baked frames, never a live <video>: the capture
    // falls back to screenshots where <video> paints black (2026-11-18).
    expect(html).not.toContain('<video')
    expect(html).toContain('class="kvf kvf-0"')
    expect(html).toMatch(/tl\.set\('\.shot-0 \.kvf-0', \{ display: 'block' \}/)
    // footage has its own motion: no Ken Burns scale/pan on the clip
    expect(html).not.toContain("tl.fromTo('.kb-0'")
  })

  it('lets full-bleed media own the frame: no furniture, strong scrim, captioned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-media-bleed-'))
    pngHeader(join(dir, 'media', 'images', 'plate.png'), 1920, 1080)
    const html = build(dir, [
      scene('S01', 'hook', [{ kind: 'asset', asset: 'media/images/plate.png', text: 'Full-bleed archive plate', dur_s: 6 }], {
        visual: { layout: 'full-bleed' }
      })
    ])
    expect(html).toContain('bleed-shot')
    expect(html).toContain('Full-bleed archive plate')
    expect(html).not.toContain('<div class="furn furn-np">') // page furniture would sit on the footage
    expect(html).toContain('.bleed-shot .scrim')
    expect(html).toContain('rgba(0,0,0,.88)')
  })
})
