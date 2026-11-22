import { describe, expect, it } from 'vitest'
import { alignVisualsToNarration, narrationSegments, wordUnits, shotCueText } from '../src/main/producer/narration'
import type { CompositionScene, RawWordTiming } from '../src/main/producer/compositions'

/**
 * Narration-driven visual timing (2026-11-16): the voice-over exists before the
 * cut, and each visual is placed on the words it illustrates.
 */

function words(pairs: Array<[string, number, number]>): RawWordTiming[] {
  return pairs.map(([word, start, dur]) => ({ word, start_s: start, dur_s: dur }))
}

const FIRE_WORDS = words([
  ['The', 0, 0.2],
  ['fire', 0.2, 0.3],
  ['burns.', 0.5, 0.4],
  ['Flaherty', 1.2, 0.3],
  ['starts', 1.5, 0.3],
  ['over.', 1.8, 0.4],
  ['Is', 2.5, 0.1],
  ['Nanook', 2.6, 0.4],
  ['a', 3.0, 0.1],
  ['lie?', 3.1, 0.4]
])

describe('narrationSegments', () => {
  it('splits sentences/clauses and maps them to word timings', () => {
    const segs = narrationSegments('The fire burns. Flaherty starts over. Is Nanook a lie?', FIRE_WORDS, 4)
    expect(segs).toHaveLength(3)
    expect(segs[0].text).toBe('The fire burns.')
    expect(segs[0].startS).toBe(0)
    expect(segs[0].endS).toBeCloseTo(0.9, 2)
    expect(segs[1].startS).toBeCloseTo(1.2, 2)
    expect(segs[2].text).toBe('Is Nanook a lie?')
    expect(segs[2].endS).toBe(4)
  })

  it('splits at em-dash clauses and understands number words', () => {
    const w = words([
      ['Seventy-nine', 0, 0.8],
      ['minutes', 0.8, 0.4],
      ['long', 1.2, 0.3],
      ['and', 1.5, 0.1],
      ['the', 1.6, 0.1],
      ['Registry', 1.7, 0.5],
      ['follows.', 2.2, 0.5]
    ])
    const segs = narrationSegments('Seventy-nine minutes long — and the Registry follows.', w, 3)
    expect(segs).toHaveLength(2)
    expect(segs[1].text).toContain('Registry')
    // "Seventy-nine" matches a stat value of 79.
    const units = wordUnits(w)
    expect(units.filter((u) => u.word === 'seventy' || u.word === 'nine')).toHaveLength(2)
  })
})

describe('alignVisualsToNarration', () => {
  const scene = (): CompositionScene => ({
    id: 'S01',
    vo: { script_section: 'hook', voice: 'v' },
    claims: [],
    shots: [
      { kind: 'composition', template: 'title-card', text: 'The fire', cue: 'The fire burns', dur_s: 10 },
      {
        kind: 'composition',
        template: 'article',
        cue: 'Flaherty starts over',
        dur_s: 1,
        data: { kind: 'article', items: [], headline: 'The restart', quote: 'Flaherty starts over', attribution: '' }
      }
    ]
  })

  it('rewrites authored durations onto the spoken words and gives the final question a card', () => {
    const res = alignVisualsToNarration([scene()], {
      sectionBodies: { hook: 'The fire burns. Flaherty starts over. Is Nanook a lie?' },
      wordsBySection: { hook: FIRE_WORDS },
      voDurations: { hook: 4 }
    })
    const shots = res.scenes[0].shots
    expect(shots).toHaveLength(3) // final question card appended
    expect(shots[0].dur_s).toBeCloseTo(1.2, 1) // was authored at 10
    expect(shots[1].dur_s).toBeCloseTo(1.3, 1)
    expect(shots[2].template).toBe('title-card')
    expect(String(shots[2].text)).toContain('lie?')
    const sum = shots.reduce((a, s) => a + s.dur_s, 0)
    expect(sum).toBeCloseTo(4, 1)
    expect(res.notes.join(' ')).toMatch(/aligned to 3 narration beats/)
    expect(res.notes.join(' ')).toMatch(/final narration beat/)
  })

  it('keeps scenes unchanged when word timings are unavailable (honest fallback)', () => {
    const res = alignVisualsToNarration([scene()], {
      sectionBodies: { hook: 'The fire burns.' },
      wordsBySection: {},
      voDurations: { hook: 4 }
    })
    expect(res.scenes[0].shots.map((s) => s.dur_s)).toEqual([10, 1])
    expect(res.notes.join(' ')).toMatch(/no word timings/)
  })

  it('prefers an authored cue over the card text', () => {
    const shot = scene().shots[0]
    expect(shotCueText({ ...shot, cue: 'the exact spoken phrase' })).toBe('the exact spoken phrase')
  })

  it('replaces a mismatched single-idea card with the spoken beat', () => {
    const body = 'The fire burns. The man who called Nanook too Romantic names the genre. The word is born.'
    const toks = body.match(/[A-Za-z0-9]+/g) ?? []
    const w: RawWordTiming[] = toks.map((word, i) => ({ word, start_s: i * 0.4, dur_s: 0.35 }))
    const sceneWithBars: CompositionScene = {
      id: 'S05',
      vo: { script_section: 's05', voice: 'v' },
      claims: [],
      shots: [
        { kind: 'composition', template: 'title-card', text: 'The fire', cue: 'The fire burns', dur_s: 3 },
        {
          kind: 'composition',
          template: 'data-bars',
          cue: 'From French to English',
          dur_s: 3,
          data: { kind: 'bars', items: [{ label: 'Documentaire', value: 1 }, { label: 'Documentary', value: 1 }] }
        },
        { kind: 'composition', template: 'title-card', text: 'The word', cue: 'The word is born', dur_s: 3 }
      ]
    }
    const res = alignVisualsToNarration([sceneWithBars], {
      sectionBodies: { s05: body },
      wordsBySection: { s05: w },
      voDurations: { s05: toks.length * 0.4 + 0.5 }
    })
    const shots = res.scenes[0].shots
    expect(shots[1].template).toBe('title-card')
    expect(String(shots[1].text)).toContain('Nanook')
    expect(res.notes.join(' ')).toMatch(/replaced mismatched visual/)
  })
})