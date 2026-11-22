import { describe, expect, it } from 'vitest'
import { fitOneLine, fitText, measureText, wrapText } from '../src/main/producer/fit'

/**
 * Deterministic text fitting (2026-11-16 layout pass). The emitter must decide
 * BEFORE the browser renders whether a string fits; these tests pin the solver
 * to conservative, honest behaviour.
 */
describe('fitText', () => {
  const box = {
    family: "'Fraunces', Georgia, serif",
    weight: 900,
    maxWidth: 1176,
    maxHeight: 420,
    nominal: 58,
    lineHeight: 1.22,
    maxLines: 4
  }

  it('shrinks long prose until it fits the box instead of clipping it', () => {
    const text = "'a record of Eskimo life based on personal observation'"
    const fit = fitText(text, box)
    expect(fit.overflow).toBe(false)
    expect(fit.sizePx).toBeLessThanOrEqual(58)
    expect(fit.lines.length).toBeLessThanOrEqual(4)
    for (const line of fit.lines) {
      expect(measureText(line, fit.sizePx, box)).toBeLessThanOrEqual(box.maxWidth + 1)
    }
  })

  it('keeps a display figure on one line', () => {
    const fit = fitOneLine('1,000+', { ...box, nominal: 210, maxHeight: 260 })
    expect(fit.lines).toHaveLength(1)
    expect(fit.sizePx).toBe(210)
  })

  it('reports overflow when even the readability floor cannot fit', () => {
    const fit = fitText('X'.repeat(400), { ...box, maxWidth: 200, nominal: 90, min: 80, maxLines: 1 })
    expect(fit.overflow).toBe(true)
    expect(fit.sizePx).toBe(80)
  })

  it('wraps on word boundaries and never splits a word that fits', () => {
    const lines = wrapText('one two three four five', 140, 30, { family: "'Inter', sans-serif", weight: 400 })
    expect(lines.join(' ')).toBe('one two three four five')
    expect(lines.length).toBeGreaterThan(1)
  })

  it('measures monospace at fixed pitch', () => {
    const a = measureText('IIIII', 20, { family: "'JetBrains Mono', monospace", weight: 600 })
    const b = measureText('WWWWW', 20, { family: "'JetBrains Mono', monospace", weight: 600 })
    expect(a).toBeCloseTo(b, 5)
  })
})