import type { CompositionScene, CompositionShot, RawWordTiming } from './compositions'

/**
 * Narration-driven visual timing (2026-11-16 pass).
 *
 * The Director authors shots before the voice-over exists, so their authored
 * `dur_s` weights cannot know where a sentence lands. After TTS we have word
 * timings; this module reconstructs the narration's sentence/clause timeline,
 * matches every shot to the narration it illustrates, and rewrites the shot
 * durations so each visual is on screen when its words are spoken.
 *
 * Matching is deterministic and offline: authored `narration_cue` wins, then
 * the card's own text/labels/events are matched against the spoken words. A
 * monotonic cut DP chooses the boundaries between shots; every shot gets one
 * contiguous narration range, and cuts land on spoken segment boundaries.
 */

export interface NarrationSegment {
  index: number
  text: string
  startS: number
  endS: number
  /** Content tokens for matching (stopwords removed, light stems). */
  tokens: Set<string>
}

export interface AlignedShot {
  shot: number
  startS: number
  durS: number
  /** First/last segment indices owned by this shot. */
  segmentFrom: number
  segmentTo: number
  /** Best cue/sentence similarity in the range (0 = position-only). */
  bestScore: number
}

export interface AlignmentResult {
  scenes: CompositionScene[]
  notes: string[]
  alignment: Record<string, AlignedShot[]>
}

const STOPWORDS = new Set(
  `a an the and or but of to in on at for from with as is are was were be been being it its this that these those
   he she they them his her their we you i not no so then here there what which who whom whose how why when where
   do does did has have had will would can could may might must just very more most also about into over after before
   than too only own same such up down out off again once all any both each few other some nor if because while during
   between through against under around without within upon per via one two three four five six seven eight nine ten
   first second third new old last next another much many`
    .split(/\s+/)
    .filter(Boolean)
)

function tokenize(text: string): string[] {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean)
}

/** Light, conservative stem so "documentaries"/"documentary", "coins"/"coined"
 *  and "premieres"/"premiere" match. Raw tokens stay in the set too. */
function stems(t: string): string[] {
  const out = [t]
  if (t.length > 4 && t.endsWith('ies')) out.push(`${t.slice(0, -3)}y`)
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1))
  if (t.length > 4 && t.endsWith('ed')) out.push(t.slice(0, -2))
  if (t.length > 5 && t.endsWith('ing')) out.push(t.slice(0, -3))
  return out
}

/** Small, domain-specific synonym closure (documentary language). */
const SYNONYMS: Record<string, string> = {
  restart: 'start',
  restarts: 'start',
  restarted: 'start',
  starts: 'start',
  started: 'start',
  starting: 'start',
  begins: 'start',
  began: 'start',
  rebuild: 'build',
  rebuilds: 'build',
  rebuilt: 'build',
  coin: 'name',
  coins: 'name',
  coined: 'name',
  naming: 'name',
  premiere: 'release',
  premieres: 'release',
  premiered: 'release',
  debuted: 'release',
  released: 'release',
  staged: 'stage',
  staging: 'stage',
  reconstruct: 'stage',
  reconstructs: 'stage',
  reconstruction: 'stage',
  reconstructing: 'stage',
  burned: 'fire',
  burning: 'fire',
  burns: 'fire',
  documentaire: 'documentary'
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}

function numberValue(group: string[]): number | null {
  let total = 0
  let current = 0
  let any = false
  for (const tok of group) {
    if (tok === 'hundred') {
      current = (current || 1) * 100
      any = true
    } else if (tok === 'thousand' || tok === 'million') {
      const mult = tok === 'thousand' ? 1000 : 1_000_000
      total += (current || 1) * mult
      current = 0
      any = true
    } else if (NUMBER_WORDS[tok] !== undefined) {
      current += NUMBER_WORDS[tok]
      any = true
    } else {
      return null
    }
  }
  return any ? total + current : null
}

function contentTokens(text: string): Set<string> {
  const raw = tokenize(text)
  const out = new Set<string>()
  // Number words → digits, so a stat's 79 matches "seventy-nine" and
  // 30,000 matches "thirty thousand".
  let numberGroup: string[] = []
  const flush = (): void => {
    if (numberGroup.length === 0) return
    const n = numberValue(numberGroup)
    if (n !== null) out.add(String(n))
    numberGroup = []
  }
  for (const t of raw) {
    if (NUMBER_WORDS[t] !== undefined || t === 'hundred' || t === 'thousand' || t === 'million') {
      numberGroup.push(t)
      continue
    }
    flush()
    if (STOPWORDS.has(t)) continue
    if (t.length < 2 && !/^\d$/.test(t)) continue
    for (const s of stems(t)) {
      out.add(s)
      const syn = SYNONYMS[s]
      if (syn) out.add(syn)
    }
  }
  flush()
  return out
}

/** Remove the script's inline ledger refs; TTS never speaks them. */
function stripClaimRefs(text: string): string {
  return String(text ?? '')
    .replace(/\([^)]*CLM[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split prose into sentence/clause segments: sentence punctuation plus strong
 *  em-dash/semicolon clause breaks. Abbreviations like "H." / "U.S." are not
 *  split (two alphanumerics are required before the punctuation). */
export function narrationSegments(body: string, words: RawWordTiming[], sceneDurS?: number): NarrationSegment[] {
  const clean = stripClaimRefs(body)
  if (!clean) return []
  const sentences = clean
    .split(/(?<=[\p{L}\p{N}]{2}[.!?])\s+(?=[\p{Lu}\p{N}“"'])/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const segments: string[] = []
  for (const sentence of sentences) {
    const clauses = sentence
      .split(/\s+[—–]\s+|\s*;\s+/)
      .map((s) => s.trim())
      .filter((s) => s.split(/\s+/).length >= 2)
    if (clauses.length > 1) segments.push(...clauses)
    else segments.push(sentence)
  }

  const units = wordUnits(words)
  if (units.length === 0 || segments.length === 0) return []

  const segTokens = segments.map((s) => tokenize(s))
  const totalScriptTokens = segTokens.reduce((a, t) => a + t.length, 0)
  const exact = totalScriptTokens === units.length
  const out: NarrationSegment[] = []
  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    const tokenCount = segTokens[i].length
    if (tokenCount === 0) continue
    let startIdx: number
    let endIdx: number
    if (exact) {
      startIdx = cursor
      endIdx = Math.min(units.length - 1, cursor + tokenCount - 1)
      cursor += tokenCount
    } else {
      // Token-normalization drift (numbers/abbreviations): map proportionally
      // by character position so the timeline still tracks the audio.
      const before = segTokens.slice(0, i).reduce((a, t) => a + t.length, 0)
      const after = before + tokenCount
      startIdx = Math.floor((before / Math.max(1, totalScriptTokens)) * units.length)
      endIdx = Math.max(startIdx, Math.ceil((after / Math.max(1, totalScriptTokens)) * units.length) - 1)
      endIdx = Math.min(units.length - 1, endIdx)
    }
    const start = units[startIdx]
    const end = units[endIdx]
    if (!start || !end) break
    out.push({
      index: out.length,
      text: segments[i],
      startS: round3(start.startS),
      endS: round3(end.startS + end.durS),
      tokens: contentTokens(segments[i])
    })
  }
  if (out.length && typeof sceneDurS === 'number' && Number.isFinite(sceneDurS)) {
    out[out.length - 1].endS = Math.max(out[out.length - 1].endS, round3(sceneDurS))
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].startS < out[i - 1].endS) out[i].startS = out[i - 1].endS
  }
  return out
}

/** Expand TTS tokens into word-level units. TTS sometimes returns multi-word
 *  tokens ("June 1922", "Bayonne, New Jersey"); split them consistently with
 *  the script tokenization and divide the token's duration by characters. */
export function wordUnits(words: RawWordTiming[]): Array<{ word: string; startS: number; durS: number }> {
  const out: Array<{ word: string; startS: number; durS: number }> = []
  for (const w of words ?? []) {
    const parts = tokenize(String(w.word ?? ''))
    if (parts.length === 0) continue
    const dur = Math.max(0.01, Number(w.dur_s) || 0.01)
    const start = Math.max(0, Number(w.start_s) || 0)
    if (parts.length === 1) {
      out.push({ word: parts[0], startS: start, durS: dur })
      continue
    }
    const chars = parts.reduce((a, p) => a + p.length, 0)
    let cursor = start
    for (const p of parts) {
      const d = (dur * p.length) / Math.max(1, chars)
      out.push({ word: p, startS: cursor, durS: d })
      cursor += d
    }
  }
  return out
}

/** The narration phrase a shot illustrates: authored cue first, then the card's
 *  own on-screen text (headline/quote/events/labels). */
export function shotCueText(shot: CompositionShot): string {
  if (shot.cue && String(shot.cue).trim()) return String(shot.cue).trim()
  const parts: string[] = []
  if (shot.text) parts.push(String(shot.text))
  const d = shot.data
  if (d) {
    for (const v of [d.title, d.headline, d.quote, d.attribution, d.publication]) {
      if (v && String(v).trim()) parts.push(String(v))
    }
    for (const it of d.items ?? []) {
      parts.push(`${it.label} ${it.note ?? ''} ${it.value !== undefined && Number.isFinite(it.value) ? String(it.value) : ''}`)
    }
    for (const e of d.events ?? []) parts.push(`${e.label} ${e.note ?? ''}`)
    for (const m of d.markers ?? []) parts.push(`${m.label} ${m.note ?? ''}`)
    for (const s of d.series ?? []) if (s.label) parts.push(String(s.label))
    for (const l of d.labels ?? []) parts.push(String(l))
  }
  return parts.join(' ').trim()
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function similarity(cue: Set<string>, seg: Set<string>, cueText: string, segText: string): number {
  if (cue.size === 0 || seg.size === 0) return 0
  let overlap = 0
  for (const t of cue) if (seg.has(t)) overlap++
  const cueCoverage = overlap / cue.size
  const segCoverage = overlap / seg.size
  const normCue = cueText.toLowerCase().replace(/\s+/g, ' ').trim()
  const normSeg = segText.toLowerCase().replace(/\s+/g, ' ').trim()
  const phrase = normCue.length >= 8 && normSeg.includes(normCue) ? 1.2 : 0
  return cueCoverage * 0.8 + segCoverage * 0.45 + phrase
}

function shotMulti(shot: CompositionShot): boolean {
  const t = String(shot.template ?? '').toLowerCase()
  const items = shot.data?.items.length ?? 0
  return (
    t.includes('timeline') ||
    t.includes('data-map') ||
    t.includes('data-list') ||
    (t.includes('data-bars') && items >= 3)
  )
}

/** How many narration segments a card can credibly hold. Timelines, maps,
 *  long lists and 3+ bar charts summarize multiple beats; a stat/title/article
 *  is one idea and gets a tighter range. */
function shotCap(shot: CompositionShot, n: number, m: number): number {
  if (m <= 1) return n
  if (shotMulti(shot)) return n
  return Math.min(4, Math.max(3, Math.ceil(n / m) + 1))
}

/** Monotonic cut DP: each shot owns one contiguous range of narration segments. */
function chooseCuts(
  cueSets: Array<{ set: Set<string>; text: string }>,
  segments: NarrationSegment[],
  caps: number[],
  multiFlags: boolean[]
): { cuts: number[]; scores: number[] } | null {
  const m = cueSets.length
  const n = segments.length
  if (m === 0 || n === 0 || m > n) return null
  const prior = (i: number, k: number, j: number): number => {
    const shotPos = m <= 1 ? 0.5 : i / (m - 1)
    const segPos = n <= 1 ? 0.5 : (k + j - 1) / 2 / (n - 1)
    return 0.24 * (1 - Math.abs(shotPos - segPos))
  }
  const rangeScore = (i: number, k: number, j: number): number => {
    // Reward the segments this shot actually matches (sum, not max): a shot
    // should not swallow a long stretch of narration it has nothing to do
    // with just to give another shot a strong single hit. Single-idea cards
    // carry an extra length penalty (a stat/article is not a 25s backdrop).
    let sum = 0
    for (let t = k; t < j; t++) {
      sum += similarity(cueSets[i].set, segments[t].tokens, cueSets[i].text, segments[t].text)
    }
    const penalty = (multiFlags[i] ? 0.08 : 0.22) * Math.max(0, j - k - 1)
    return sum - penalty + prior(i, k, j)
  }

  const dp: number[][] = Array.from({ length: m }, () => new Array<number>(n + 1).fill(Number.NEGATIVE_INFINITY))
  const choice: number[][] = Array.from({ length: m }, () => new Array<number>(n + 1).fill(-1))
  const maxJ0 = Math.min(n - (m - 1), caps[0])
  for (let j = 1; j <= maxJ0; j++) dp[0][j] = rangeScore(0, 0, j)
  for (let i = 1; i < m; i++) {
    const minJ = i + 1
    const maxJ = n - (m - i - 1)
    for (let j = minJ; j <= maxJ; j++) {
      for (let k = i; k < j; k++) {
        if (j - k > caps[i]) continue
        const v = dp[i - 1][k] + rangeScore(i, k, j)
        if (v > dp[i][j]) {
          dp[i][j] = v
          choice[i][j] = k
        }
      }
    }
  }
  if (!Number.isFinite(dp[m - 1][n])) return null
  const cuts = new Array<number>(m + 1).fill(0)
  cuts[m] = n
  for (let i = m - 1; i >= 1; i--) cuts[i] = choice[i][cuts[i + 1]]
  cuts[0] = 0
  for (let i = 1; i <= m; i++) if (cuts[i] <= cuts[i - 1]) return null
  const scores = cueSets.map((c, i) => {
    let bestScore = 0
    for (let t = cuts[i]; t < cuts[i + 1]; t++) {
      bestScore = Math.max(bestScore, similarity(c.set, segments[t].tokens, c.text, segments[t].text))
    }
    return bestScore
  })
  return { cuts, scores }
}

/** A short, readable title-card phrase drawn from a spoken sentence. */
function beatPhrase(text: string): string {
  const t = String(text ?? '')
    .replace(/[“”"]/g, '')
    .replace(/[—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  const isQuestion = t.endsWith('?')
  let phrase = t
  if (!isQuestion) {
    const clauses = t.split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean)
    phrase = clauses.find((c) => c.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length >= 3) ?? t
  }
  const words = phrase
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 10)
  const out = words.join(' ').replace(/[.,;:!?]+$/, '').trim()
  return isQuestion ? `${out}?` : out
}

/**
 * Align every scene's shots to its narration. Returns new scenes (written shot
 * durations only) plus producer notes. Scenes without word timings are left
 * untouched and disclosed.
 */
export function alignVisualsToNarration(
  scenes: CompositionScene[],
  opts: {
    sectionBodies: Record<string, string>
    wordsBySection: Record<string, RawWordTiming[]>
    voDurations: Record<string, number>
  }
): AlignmentResult {
  const notes: string[] = []
  const alignment: Record<string, AlignedShot[]> = {}
  const out = scenes.map((scene) => {
    const section = scene.vo.script_section
    const body = opts.sectionBodies[section] ?? ''
    const words = opts.wordsBySection[section] ?? []
    const sceneDur = Math.max(1, Number(opts.voDurations[section]) || 0)
    const shots = scene.shots ?? []
    if (!body || words.length === 0 || shots.length === 0) {
      if (shots.length > 0) {
        notes.push(`${scene.id}: no word timings for section '${section}' — visuals keep authored durations (SAPI fallback?)`)
      }
      return scene
    }
    const segments = narrationSegments(body, words, sceneDur)
    if (segments.length === 0) {
      notes.push(`${scene.id}: could not reconstruct narration segments — visuals keep authored durations`)
      return scene
    }
    const cues = shots.map((shot) => {
      const text = shotCueText(shot)
      return { set: contentTokens(text), text }
    })
    const caps = shots.map((shot) => shotCap(shot, segments.length, shots.length))
    const multiFlags = shots.map(shotMulti)
    const cutPlan = chooseCuts(cues, segments, caps, multiFlags)
    if (!cutPlan) {
      notes.push(`${scene.id}: could not place every visual in a narration range (${shots.length} cards / ${segments.length} beats) — timing left as authored`)
      return scene
    }
    const { cuts, scores } = cutPlan
    const starts: number[] = []
    const ends: number[] = []
    for (let i = 0; i < shots.length; i++) {
      const start = i === 0 ? 0 : segments[cuts[i]].startS
      const end = i === shots.length - 1 ? sceneDur : segments[cuts[i + 1]].startS
      starts.push(start)
      ends.push(end)
    }
    // Keep every visual readable; scale the whole set back to the scene length.
    const MIN = 1.0
    let durs = ends.map((e, i) => Math.max(MIN, e - starts[i]))
    const total = durs.reduce((a, b) => a + b, 0)
    if (total > 0) durs = durs.map((d) => (d / total) * sceneDur)
    let cursor = 0
    const aligned: AlignedShot[] = []
    const nextShots = shots.map((shot, i) => {
      const startS = round3(cursor)
      const isLast = i === shots.length - 1
      const durS = round3(isLast ? Math.max(0.5, sceneDur - cursor) : Math.max(0.5, durs[i]))
      cursor = round3(cursor + durS)
      const from = cuts[i]
      const to = cuts[i + 1] - 1
      aligned.push({ shot: i, startS, durS, segmentFrom: from, segmentTo: to, bestScore: round3(scores[i]) })
      return { ...shot, dur_s: durS }
    })
    // Drop a redundant single-idea card when a neighbouring multi-beat card
    // (timeline/list/bars/map) already carries its content and it matched no
    // narration beat. Leaving it in puts an unrelated stat on screen for a
    // passage it has nothing to do with.
    const currentCues = [...cues]
    let dropped = false
    for (let i = 1; i < nextShots.length; i++) {
      if (multiFlags[i] || scores[i] >= 0.1) continue
      if (!multiFlags[i - 1]) continue
      const prev = currentCues[i - 1].set
      let overlap = 0
      for (const t of currentCues[i].set) if (prev.has(t)) overlap++
      const ratio = currentCues[i].set.size ? overlap / currentCues[i].set.size : 0
      if (ratio < 0.5) continue
      nextShots[i - 1] = { ...nextShots[i - 1], dur_s: round3(nextShots[i - 1].dur_s + nextShots[i].dur_s) }
      aligned[i - 1].durS = nextShots[i - 1].dur_s
      aligned[i - 1].segmentTo = aligned[i].segmentTo
      const label = String(shots[i].text || shots[i].data?.title || shots[i].data?.headline || `shot ${i + 1}`)
      notes.push(`${scene.id}: dropped redundant visual “${label.slice(0, 60)}” — the previous multi-beat card already covers that narration`)
      nextShots.splice(i, 1)
      aligned.splice(i, 1)
      currentCues.splice(i, 1)
      dropped = true
      break
    }
    // If a single-idea card matched no narration beat and one long beat
    // dominates its range, replace the card with a title card carrying that
    // spoken beat. A mismatched stat/bars panel is worse than a clean line.
    let replaced = false
    for (let i = 0; i < nextShots.length && !replaced && !dropped; i++) {
      if (multiFlags[i] || scores[i] >= 0.1) continue
      const from = aligned[i].segmentFrom
      const to = aligned[i].segmentTo
      let worstT = from
      let worstSim = Number.POSITIVE_INFINITY
      let rangeDur = 0
      for (let t = from; t <= to; t++) {
        const c = currentCues[i]
        const sim = similarity(c.set, segments[t].tokens, c.text, segments[t].text)
        if (sim < worstSim) {
          worstSim = sim
          worstT = t
        }
        rangeDur += segments[t].endS - segments[t].startS
      }
      const worstSeg = segments[worstT]
      const worstDur = worstSeg ? worstSeg.endS - worstSeg.startS : 0
      if (worstDur < 3.0 || worstDur < rangeDur * 0.5) continue
      const phrase = beatPhrase(worstSeg.text)
      if (!phrase) continue
      const label = String(shots[i].text || shots[i].data?.title || shots[i].data?.headline || `shot ${i + 1}`)
      nextShots[i] = { kind: 'composition', template: 'title-card', text: phrase, cue: worstSeg.text, dur_s: nextShots[i].dur_s }
      aligned[i].segmentFrom = worstT
      aligned[i].segmentTo = worstT
      aligned[i].bestScore = 1
      currentCues[i] = { set: contentTokens(phrase), text: worstSeg.text }
      notes.push(`${scene.id}: replaced mismatched visual “${label.slice(0, 60)}” with a narration card (“${phrase}”)`)
      replaced = true
    }
    // The final spoken beat (often the scene's rhetorical question or payoff)
    // deserves its own visual when the last card is about something else.
    const finalSeg = segments[segments.length - 1]
    const lastIdx = nextShots.length - 1
    const lastCue = currentCues[lastIdx]
    const lastSim = similarity(lastCue.set, finalSeg.tokens, lastCue.text, finalSeg.text)
    const lastStart = aligned[lastIdx]?.startS ?? 0
    const cutAt = Math.max(lastStart, finalSeg.startS)
    if (lastSim < 0.25 && cutAt - lastStart >= 1.0 && sceneDur - cutAt >= 1.2) {
      const phrase = beatPhrase(finalSeg.text)
      if (phrase) {
        const lastDur = round3(cutAt - lastStart)
        nextShots[lastIdx] = { ...nextShots[lastIdx], dur_s: lastDur }
        aligned[lastIdx].durS = lastDur
        aligned[lastIdx].segmentTo = Math.max(aligned[lastIdx].segmentFrom, segments.length - 2)
        const cardDur = round3(sceneDur - cutAt)
        nextShots.push({ kind: 'composition', template: 'title-card', text: phrase, cue: finalSeg.text, dur_s: cardDur })
        currentCues.push({ set: contentTokens(phrase), text: finalSeg.text })
        aligned.push({ shot: nextShots.length - 1, startS: round3(cutAt), durS: cardDur, segmentFrom: segments.length - 1, segmentTo: segments.length - 1, bestScore: 1 })
        notes.push(`${scene.id}: final narration beat gets its own title card (“${phrase}”)`)
      }
    }
    alignment[scene.id] = aligned
    const raw = (text: string): string => (text.length > 42 ? `${text.slice(0, 39)}…` : text)
    notes.push(
      `${scene.id}: ${aligned.length} visuals aligned to ${segments.length} narration beats — ${aligned
        .map((a) => `${a.startS.toFixed(1)}s “${raw(segments[a.segmentFrom]?.text ?? '')}”`)
        .join(' · ')}`
    )
    for (let i = 0; i < aligned.length; i++) {
      const a = aligned[i]
      const owned = a.segmentTo - a.segmentFrom + 1
      if (a.bestScore < 0.12) {
        let worstT = a.segmentFrom
        let worstSim = Number.POSITIVE_INFINITY
        for (let t = a.segmentFrom; t <= a.segmentTo; t++) {
          const c = currentCues[i]
          const sim = similarity(c.set, segments[t].tokens, c.text, segments[t].text)
          if (sim < worstSim) {
            worstSim = sim
            worstT = t
          }
        }
        const seg = segments[worstT]
        const secs = seg ? seg.endS - seg.startS : 0
        if (secs >= 2.5) {
          notes.push(
            `${scene.id} shot ${i + 1}: ${secs.toFixed(1)}s of narration (“${raw(seg.text)}”) has no matching visual — add a narration_cue or a shot`
          )
        } else {
          notes.push(`${scene.id} shot ${i + 1}: matched by narration position only — add narration_cue to anchor it`)
        }
      } else if (owned >= 3) {
        notes.push(`${scene.id} shot ${i + 1}: holds across ${owned} narration beats — consider splitting the visual`)
      }
    }
    return { ...scene, shots: nextShots }
  })
  return { scenes: out, notes, alignment }
}