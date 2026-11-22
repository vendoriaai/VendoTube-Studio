import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  readBibleBundle,
  readScriptSections,
  writeBeats,
  writeBible,
  writeScript,
  writeStyle,
  writeWorkflow,
  type BeatInput,
  type BibleInput,
  type WorkflowInput
} from '../src/main/artifacts'

/** Bible round-trip (regression: matchAll demanded /g; claims/assets must survive md→parse). */

const dir = mkdtempSync(join(tmpdir(), 'vendotube-artifacts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bible: BibleInput = {
  title: 'Round Trip Film',
  thesis: 'Evidence leads.',
  targetRuntimeSeconds: 60,
  runtimeDecision: '1 min — two-claim story; a longer cut would pad',
  stylePreset: 'vox-explainer',
  emotionalPromise: 'curiosity resolved into resolve',
  arc: 'Hook, turn, resolve.',
  scenes: [
    {
      id: 'S01',
      label: 'Hook',
      title: 'Opening',
      shows: 'archive map of Yerevan',
      feels: 'curious',
      motion: 'ken-burns push on the map',
      look: 'noir grade, hard cut in, slow push on the archive photo',
      onScreenText: '1915',
      durationTargetS: 30,
      claims: ['CLM-001', 'CLM-002'],
      assetIds: ['AS-001', 'AS-002']
    },
    {
      id: 'S02',
      label: 'Turn',
      title: 'Aftermath',
      shows: 'interview still',
      feels: 'somber',
      motion: 'crossfade',
      look: null,
      onScreenText: '',
      durationTargetS: 30,
      claims: [],
      assetIds: []
    }
  ]
}

describe('bible artifact round-trip', () => {
  it('parses back claims, asset ids, and clean scene text', () => {
    writeBible(dir, bible)
    const bundle = readBibleBundle(dir)
    expect(bundle).not.toBeNull()
    const s1 = bundle!.bible!.scenes[0]
    expect(s1.claims).toEqual(['CLM-001', 'CLM-002'])
    expect(s1.assetIds).toEqual(['AS-001', 'AS-002'])
    // shows must not leak the serializer's " assets: …" segment
    expect(s1.shows).toBe('archive map of Yerevan')
    expect(s1.title).toBe('Opening')
    // scene without claims/assets stays clean
    const s2 = bundle!.bible!.scenes[1]
    expect(s2.claims).toEqual([])
    expect(s2.assetIds).toEqual([])
    expect(s2.shows).toBe('interview still')
    // bundle header fields survive
    expect(bundle!.bible!.title).toBe('Round Trip Film')
    expect(bundle!.bible!.runtimeDecision).toBe('1 min — two-claim story; a longer cut would pad')
    expect(bundle!.bible!.scenes).toHaveLength(2)
  })

  it('omits runtime_decision from the front-matter when the user set the runtime', () => {
    writeBible(dir, { ...bible, runtimeDecision: null })
    const bundle = readBibleBundle(dir)
    expect(bundle!.bible!.runtimeDecision).toBeNull()
  })

  it('round-trips open-loop bookkeeping on beats (craft pass)', () => {
    const beat = (id: string, scene: string, startS: number, loop: { opensLoop: string | null; closesLoop: string | null }): BeatInput => ({
      id,
      scene,
      label: 'Hook',
      startS,
      durS: 30,
      curiosity: 0.8,
      tension: 0.3,
      rehook: false,
      patternInterrupt: null,
      ...loop,
      music: '',
      sfx: []
    })
    const beats: BeatInput[] = [
      beat('B01', 'S01', 0, { opensLoop: 'who built the vault?', closesLoop: null }),
      beat('B02', 'S02', 30, { opensLoop: null, closesLoop: 'who built the vault?' })
    ]
    writeBeats(dir, beats)
    const bundle = readBibleBundle(dir)
    expect(bundle!.beats[0].opensLoop).toBe('who built the vault?')
    expect(bundle!.beats[0].closesLoop).toBeNull()
    expect(bundle!.beats[1].closesLoop).toBe('who built the vault?')
    expect(bundle!.beats[1].opensLoop).toBeNull()
  })

  it('round-trips the per-scene look line (visual direction pass)', () => {
    writeBible(dir, bible)
    const bundle = readBibleBundle(dir)
    expect(bundle!.bible!.scenes[0].look).toBe('noir grade, hard cut in, slow push on the archive photo')
    // a scene without a look stays null — no empty-string noise
    expect(bundle!.bible!.scenes[1].look).toBeNull()
  })
})

describe('visual direction artifacts', () => {
  it('serializes scene.visual and omits unauthored transitions from workflow.json', () => {
    const wf: WorkflowInput = {
      resolution: [1920, 1080],
      fps: 30,
      quality: 'standard',
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo: { scriptSection: 'hook', voice: 'v' },
          shots: [{ kind: 'composition', template: 'title-card', text: 'Hook', durS: 6 }],
          visual: { mood: 'noir', layout: 'full-bleed', accent: '#b3542f' },
          sfx: [],
          claims: ['CLM-001']
        },
        {
          id: 'S02',
          beats: ['B02'],
          vo: { scriptSection: 's01', voice: 'v' },
          shots: [{ kind: 'composition', template: 'title-card', text: 'Turn', durS: 6 }],
          transitionIn: 'dip-to-black',
          sfx: [],
          claims: []
        }
      ]
    }
    const file = writeWorkflow(dir, wf)
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      scenes: Array<{ visual?: { mood?: string }; transitions?: { in?: string; out?: string } }>
    }
    // authored look survives verbatim
    expect(parsed.scenes[0].visual).toEqual({ mood: 'noir', layout: 'full-bleed', accent: '#b3542f' })
    expect(parsed.scenes[1].visual).toBeUndefined()
    // scene with no authored transitions → key omitted (transition_set seeds it)
    expect(parsed.scenes[0].transitions).toBeUndefined()
    // one authored side fills the other with the historical defaults
    expect(parsed.scenes[1].transitions).toEqual({ in: 'dip-to-black', out: 'crossfade' })
  })

  it('writes style.json via writeStyle (the Director style_write channel)', () => {
    const file = writeStyle(dir, {
      preset: 'archival-history',
      accent: '#b3542f',
      transition_set: 'cinematic',
      look: '1930s newsprint: oxblood accent, heavy grain, hard cuts on reveals'
    })
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { accent?: string; transition_set?: string; look?: string }
    expect(parsed.accent).toBe('#b3542f')
    expect(parsed.transition_set).toBe('cinematic')
    expect(parsed.look).toContain('newsprint')
  })
})

describe('script artifact round-trip', () => {
  it('readScriptSections parses back what writeScript wrote (append-mode base)', () => {
    writeScript(dir, {
      voice: 'en-US-AndrewMultilingualNeural',
      sections: [
        { id: 'hook', title: 'One Prompt', body: 'Opened on the evidence. (CLM-0001)', voice: 'en-GB-SoniaNeural', pace: 1.1, energy: 'high' },
        { id: 'S02', title: 'The Turn', body: 'The counterpoint lands. (CLM-0002)' }
      ]
    })
    const sections = readScriptSections(dir)
    expect(sections).toHaveLength(2)
    expect(sections[0].id).toBe('hook')
    expect(sections[0].title).toBe('One Prompt')
    expect(sections[0].body).toBe('Opened on the evidence. (CLM-0001)')
    expect(sections[0].voice).toBe('en-GB-SoniaNeural')
    expect(sections[0].pace).toBe(1.1)
    expect(sections[0].energy).toBe('high')
    // per-section metadata falls back to the film voice / defaults in the
    // front-matter, so the reader returns the materialized values
    expect(sections[1].id).toBe('S02')
    expect(sections[1].body).toBe('The counterpoint lands. (CLM-0002)')
    expect(sections[1].voice).toBe('en-US-AndrewMultilingualNeural')
    expect(sections[1].pace).toBe(1)
    expect(sections[1].energy).toBe('neutral')
  })

  it('readScriptSections returns [] for a missing or unstructured file', () => {
    expect(readScriptSections(join(dir, 'no-such-project'))).toEqual([])
  })
})
