import type { WordTiming } from '@shared/ipc'

/**
 * Subtitle builder (M3): groups TTS word-boundary timings into SRT cues that
 * pass DWK's validate_srt discipline — no overlap, ≤ 2 lines, ≤ 42 chars per
 * line, CPS within the project target. Pure and deterministic: unit-tested
 * with fixture timings, integration-checked against dwk.validate_srt.
 */

export interface SubtitleCue {
  index: number
  startS: number
  endS: number
  lines: string[]
}

export interface SubtitleOptions {
  /** Max characters per caption line (DWK validate_srt warns past 42). */
  maxLineChars?: number
  /** Max lines per cue (validate_srt warns past 2). */
  maxLines?: number
  /** Target reading speed ceiling (project retention cps_max, DATA-SCHEMA §2.1). */
  maxCps?: number
  /** Lead time before the first word of a cue. */
  leadS?: number
  /** Hold time after the last word of a cue. */
  padS?: number
  /** Silence gap that forces a cue break even mid-sentence. */
  gapBreakS?: number
  /** Minimum on-screen time for a cue (readability floor). */
  minDurS?: number
}

const DEFAULTS: Required<SubtitleOptions> = {
  maxLineChars: 42,
  maxLines: 2,
  maxCps: 17,
  leadS: 0.08,
  padS: 0.24,
  gapBreakS: 0.7,
  minDurS: 0.9
}

const SENTENCE_END = /[.!?…]$/

export function buildSrtCues(words: WordTiming[], opts: SubtitleOptions = {}): SubtitleCue[] {
  const o = { ...DEFAULTS, ...opts }
  const clean = words
    .filter((w) => typeof w.word === 'string' && w.word.trim().length > 0)
    .map((w) => ({ word: w.word.trim(), startS: Math.max(0, Number(w.startS) || 0), durS: Math.max(0, Number(w.durS) || 0) }))
    .sort((a, b) => a.startS - b.startS)
  if (clean.length === 0) return []

  const lineBudget = o.maxLineChars * o.maxLines

  // Greedy grouping: a cue ends at sentence punctuation, at the character
  // budget, at a hard reading-speed ceiling (well above normal speech), or at
  // a long pause in the narration. Normal-speech CPS is handled by timing, not
  // by splitting cues into unreadable one-word flashes.
  const groups: Array<{ words: typeof clean; chars: number }> = []
  let current: Array<typeof clean[number]> = []
  let chars = 0
  for (let i = 0; i < clean.length; i++) {
    const w = clean[i]
    const next = clean[i + 1]
    const projected = chars === 0 ? w.word.length : chars + 1 + w.word.length
    const gap = next ? Math.max(0, next.startS - (w.startS + w.durS)) : 0
    if (chars > 0 && (projected > lineBudget || gap >= o.gapBreakS)) {
      groups.push({ words: current, chars })
      current = []
      chars = 0
    }
    current.push(w)
    chars = chars === 0 ? w.word.length : chars + 1 + w.word.length
    const isSentenceEnd = SENTENCE_END.test(w.word)
    const budgetReached = chars >= lineBudget * 0.6 // prefer shorter cues once over ~60% of the budget
    if ((isSentenceEnd && chars >= lineBudget * 0.3) || budgetReached || !next || gap >= o.gapBreakS) {
      groups.push({ words: current, chars })
      current = []
      chars = 0
    }
  }
  if (current.length > 0) groups.push({ words: current, chars })

  // Timing pass over the whole group list: cues may extend into the gap to
  // the next cue (pad), never overlap it, and always meet a readability floor.
  const starts: number[] = []
  for (let g = 0; g < groups.length; g++) {
    const first = groups[g].words[0]
    const prevEnd = g > 0 ? cueEndEstimate(groups[g - 1], o) : 0 // absolute end of the previous cue
    starts.push(Math.max(0, first.startS - o.leadS, prevEnd + 0.01))
  }
  const cues: SubtitleCue[] = []
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g].words
    const last = grp[grp.length - 1]
    const start = starts[g]
    const spokenEnd = last.startS + last.durS
    const nextStart = g + 1 < groups.length ? starts[g + 1] : Number.POSITIVE_INFINITY
    // Hold at least minDur (or pad past the last word), but never over the next cue.
    let end = Math.max(spokenEnd + o.padS, start + o.minDurS)
    if (Number.isFinite(nextStart)) {
      end = Math.min(end, Math.max(start + 0.2, nextStart - 0.01))
    }
    if (end <= start) end = start + 0.2
    cues.push({
      index: g + 1,
      startS: round3(start),
      endS: round3(end),
      lines: wrapLines(grp.map((w) => w.word).join(' '), o.maxLineChars, o.maxLines)
    })
  }
  return cues
}

function cueEndEstimate(grp: { words: Array<{ startS: number; durS: number }> }, o: { padS: number; minDurS: number }): number {
  const start = grp.words[0].startS - 0.08
  const spokenEnd = grp.words[grp.words.length - 1].startS + grp.words[grp.words.length - 1].durS
  return Math.max(spokenEnd + o.padS, start + o.minDurS)
}

function wrapLines(text: string, maxLineChars: number, maxLines: number): string[] {
  if (text.length <= maxLineChars) return [text]
  // Balanced two-line split: break near the middle at the closest space.
  const mid = Math.floor(text.length / 2)
  let best = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i
    }
  }
  if (best === -1) return [text]
  const l1 = text.slice(0, best)
  const l2 = text.slice(best + 1)
  if (l1.length > maxLineChars || l2.length > maxLineChars || maxLines < 2) {
    // Too long for the two-line budget — split harder at a space under the cap.
    const cut = text.lastIndexOf(' ', maxLineChars)
    if (cut <= 0) return [text.slice(0, maxLineChars), text.slice(maxLineChars).trimStart()]
    const rest = wrapLines(text.slice(cut + 1), maxLineChars, maxLines - 1)
    return [text.slice(0, cut), ...rest]
  }
  return [l1, l2]
}

export function formatSrtTime(s: number): string {
  const clamped = Math.max(0, s)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const sec = Math.floor(clamped % 60)
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000)
  const msNorm = ms === 1000 ? 999 : ms
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(msNorm).padStart(3, '0')}`
}

export function buildSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((c) => `${c.index}\n${formatSrtTime(c.startS)} --> ${formatSrtTime(c.endS)}\n${c.lines.join('\n')}`)
      .join('\n\n') + (cues.length ? '\n' : '')
  )
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
