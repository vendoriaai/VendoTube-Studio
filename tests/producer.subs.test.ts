import { describe, expect, it } from 'vitest'
import { buildSrt, buildSrtCues, formatSrtTime, type SubtitleCue } from '../src/main/producer/subs'
import type { WordTiming } from '../src/shared/ipc'

/** Fixture: natural-pace narration words (~150 wpm, ~12 CPS). */
function naturalWords(): WordTiming[] {
  const text =
    'In 1905 a patent clerk changed physics forever. Einstein published four papers that year. ' +
    'Each one reshaped how we see the universe. ' +
    'This is the story of that miraculous year, told through the evidence he left behind.'
  const words: WordTiming[] = []
  let t = 0.12
  for (const w of text.split(/\s+/)) {
    const dur = Math.max(0.08, Math.min(0.6, w.replace(/[.,]/g, '').length * 0.055 + 0.09))
    words.push({ word: w.replace(/[,]/g, ''), startS: Math.round(t * 1000) / 1000, durS: Math.round(dur * 1000) / 1000 })
    t += dur + 0.06 // inter-word pause
  }
  return words
}

describe('buildSrtCues', () => {
  it('produces monotonic, non-overlapping cues', () => {
    const cues = buildSrtCues(naturalWords())
    expect(cues.length).toBeGreaterThan(1)
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].endS).toBeGreaterThan(cues[i].startS)
      if (i > 0) expect(cues[i].startS).toBeGreaterThanOrEqual(cues[i - 1].endS)
    }
  })

  it('respects the two-line and 42-char budgets', () => {
    const cues = buildSrtCues(naturalWords())
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2)
      for (const line of c.lines) expect(line.length).toBeLessThanOrEqual(42)
    }
  })

  it('keeps natural speech under the 17 CPS ceiling', () => {
    const cues = buildSrtCues(naturalWords())
    for (const c of cues) {
      const chars = c.lines.join('').length
      const cps = chars / Math.max(0.001, c.endS - c.startS)
      expect(cps).toBeLessThanOrEqual(19) // validate_srt default warns at 20; we target 17
    }
  })

  it('breaks at sentence punctuation', () => {
    const cues = buildSrtCues(naturalWords())
    const joined = cues.map((c) => c.lines.join(' '))
    // No cue should contain the end of one sentence and the start of the next.
    for (const text of joined) {
      const periods = (text.match(/\./g) ?? []).length
      expect(periods).toBeLessThanOrEqual(1)
    }
  })

  it('handles a single word', () => {
    const cues = buildSrtCues([{ word: 'Wow.', startS: 1, durS: 0.3 }])
    expect(cues).toHaveLength(1)
    expect(cues[0].lines).toEqual(['Wow.'])
    expect(cues[0].startS).toBeCloseTo(0.92, 2) // 1 - lead
    expect(cues[0].endS).toBeGreaterThan(1.3)
  })

  it('returns no cues for empty input', () => {
    expect(buildSrtCues([])).toEqual([])
    expect(buildSrtCues([{ word: '   ', startS: 0, durS: 0 }])).toEqual([])
  })

  it('merges short adjacent words into one readable cue', () => {
    const cues = buildSrtCues([
      { word: 'Quick', startS: 0, durS: 0.2 },
      { word: 'brown', startS: 0.3, durS: 0.2 }
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0].lines.join(' ')).toBe('Quick brown')
    expect(cues[0].endS - cues[0].startS).toBeGreaterThanOrEqual(0.8) // readability floor
  })

  it('clamps the readability floor against the next cue to avoid overlap', () => {
    const cues = buildSrtCues([
      { word: 'Quick', startS: 0, durS: 0.2 },
      { word: 'brown', startS: 0.95, durS: 0.2 } // 0.75s gap ≥ 0.7s → separate cues
    ])
    expect(cues).toHaveLength(2)
    expect(cues[0].endS).toBeLessThanOrEqual(cues[1].startS)
  })

  it('never produces word-flicker cues on fast narration', () => {
    // edge-tts style word timings: short word durations, tight gaps
    const words: WordTiming[] = 'This is the M3 smoke film of the studio producer pipeline.'
      .split(' ')
      .map((w, i) => ({ word: w, startS: Math.round(i * 0.22 * 1000) / 1000, durS: 0.14 }))
    const cues = buildSrtCues(words)
    for (const c of cues) {
      expect(c.endS - c.startS).toBeGreaterThanOrEqual(0.2)
    }
    expect(cues.length).toBeLessThan(words.length) // not one cue per word
  })
})

describe('buildSrt', () => {
  it('emits valid SRT blocks (index, comma timecode, text)', () => {
    const cues: SubtitleCue[] = [
      { index: 1, startS: 0, endS: 2.5, lines: ['Hello there.'] },
      { index: 2, startS: 2.6, endS: 4.0, lines: ['General Kenobi.', 'This is a long cue that wraps.'] }
    ]
    const srt = buildSrt(cues)
    const blocks = srt.trim().split(/\n\n/)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatch(/^1\n00:00:00,000 --> 00:00:02,500\nHello there\.$/)
    expect(blocks[1]).toMatch(/^2\n00:00:02,600 --> 00:00:04,000\n/)
    expect(blocks[1].split('\n').length).toBe(4) // index + timecode + 2 lines
  })

  it('formats hours and clamps rounding to 999 ms', () => {
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500')
    expect(formatSrtTime(0)).toBe('00:00:00,000')
    expect(formatSrtTime(59.9994)).toBe('00:00:59,999')
    expect(formatSrtTime(-1)).toBe('00:00:00,000')
  })

  it('produces an empty string with no cues', () => {
    expect(buildSrt([])).toBe('')
  })
})
