import { duoPanelsOf, isVisualLayout, scaleShotsToDuration, templateKind, type CompositionScene, type CompositionShot, type DataCard, type SceneTiming } from './compositions'

export type { DataCard } from './compositions'

/**
 * Visual enrichment (produce-time, deterministic): turns evidence-ledger
 * claims + rights-approved research media into a visual shot plan so films
 * picture their research instead of rendering text walls. Pure functions —
 * no I/O, no model calls; the pipeline feeds it bridge rows and passes the
 * enriched scenes to buildCompositions.
 *
 * Three passes, in order:
 *  1. chunkTextShots  — split overlong title cards into sequential chunks
 *     (the director sometimes crams a whole ranking into one string).
 *  2. dataCardsForClaims — conservative regex extraction of comparable
 *     numbers (scores, ranks, money, percents, enumerations) into data
 *     cards (bars/stat/list) rendered by the composition templates.
 *  3. injectAssets — interleave rights-approved downloaded media into
 *     scenes that reference none, provenance-linked when possible
 *     (claim → source URL → asset page host), round-robin otherwise.
 */

// ------------------------------------------------------------------- inputs

/** research/evidence_ledger.csv row (bridge `ledger.list` kind=evidence). */
export interface ClaimRow {
  claim_id?: string
  claim_text?: string
  source_id?: string
  exact_support_or_quote?: string
}

/** research/sources.csv row (bridge `ledger.list` kind=sources). */
export interface SourceRow {
  source_id?: string
  url?: string
  title?: string
}

/** Asset Library merged view row (bridge `assets.list` → candidates). */
export interface AssetRow {
  asset_id?: string
  media_type?: string
  rights_status?: string
  downloaded?: boolean
  saved_path?: string
  asset_page_url?: string
  title?: string
  attribution?: string
  license?: string
  source_id?: string
}

export interface VisualPlan {
  scenes: CompositionScene[]
  /** Asset ids that ended up in the plan (for production/shot_list.csv). */
  injected: Array<{ asset_id: string; sceneId: string; saved_path: string; media_type: string; claim_id: string; source_id: string; title: string }>
  /** Downloaded media still awaiting the human rights decision (gate G-M). */
  mediaPending: AssetRow[]
}

// ------------------------------------------------------------------- text chunking

const CHUNK_MAX = 72

/** Split an overlong card text into readable chunks: on ` | ` / `;` first, then greedy word wrap. */
export function chunkText(text: string, maxLen = CHUNK_MAX): string[] {
  const segments = String(text ?? '')
    .split(/\s*\|\s*|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const seg of segments) {
    if (seg.length <= maxLen) {
      out.push(seg)
      continue
    }
    // Greedy word wrap; while a parenthesis is open, keep the enumeration on
    // one card (bounded overflow) instead of splitting mid-list.
    let line = ''
    let depth = 0
    for (const word of seg.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      const delta = (word.match(/\(/g) ?? []).length - (word.match(/\)/g) ?? []).length
      if (line && depth === 0 && next.length > maxLen) {
        out.push(line)
        line = word
      } else {
        line = next
      }
      depth = Math.max(0, depth + delta)
      if (line.length > maxLen + 40) {
        out.push(line)
        line = ''
        depth = 0
      }
    }
    if (line) out.push(line)
  }
  return out.length > 0 ? out : [String(text ?? '')]
}

/** Pass 1: expand overlong title cards into sequential chunk cards. */
export function chunkTextShots(scenes: CompositionScene[]): CompositionScene[] {
  return scenes.map((scene) => {
    const shots: CompositionShot[] = []
    let changed = false
    for (const shot of scene.shots ?? []) {
      // Directors sometimes omit `kind` or invent template ids — anything that
      // renders as a title-kind card and carries long text gets chunked.
      const longTitle =
        shot.kind !== 'asset' &&
        !shot.asset &&
        templateKind(shot.template) === 'title' &&
        typeof shot.text === 'string' &&
        (shot.text.length > 110 || /\s\|\s/.test(shot.text))
      if (!longTitle) {
        shots.push(shot)
        continue
      }
      const chunks = chunkText(shot.text ?? '')
      if (chunks.length <= 1) {
        shots.push(shot)
        continue
      }
      changed = true
      const each = Math.max(1, Math.round(((Number(shot.dur_s) || 3) / chunks.length) * 10) / 10)
      for (const chunk of chunks) shots.push({ ...shot, text: chunk, dur_s: each })
    }
    return changed ? { ...scene, shots } : scene
  })
}

// ------------------------------------------------------------------- data cards

interface Extracted {
  label: string
  value: number
  note?: string
  family: 'score' | 'rank' | 'money' | 'percent'
}

const LABEL_RE = String.raw`([A-Z][A-Za-z'’.\- ]{1,38}?)(?=\s+(?:was\s+|is\s+)?(?:ranked|ranks|scored|scores|requires|costs|needs|leads|tops)|\s*\()`

function num(s: string): number {
  const v = Number(String(s).replace(/,/g, ''))
  return Number.isFinite(v) ? v : NaN
}

/** Strip table-row filler words so labels name the subject, not the grammar around it. */
function stripFiller(s: string): string {
  let out = clean(s)
  for (;;) {
    const next = out.replace(/^(?:month|with|of|a|an|and|per|rate|tax|at|for|to|in|on|top)\b\s*/i, '')
    if (next === out) break
    out = next
  }
  return out
}

function host(url: string | undefined): string {
  const m = String(url ?? '').match(/^https?:\/\/([^/?#]+)/i)
  return m ? m[1].toLowerCase().replace(/^www\./, '') : ''
}

/** Conservative per-claim extraction — only clean, visualizable numbers. */
export function extractFromClaim(claim: ClaimRow): Extracted[] {
  const text = `${claim.claim_text ?? ''} ${claim.exact_support_or_quote ?? ''}`
  const out: Extracted[] = []
  const push = (e: Extracted | null): void => {
    const label = e ? stripFiller(e.label) : ''
    if (e && Number.isFinite(e.value) && label.length >= 2 && label.length <= 40 && !/^[\d\s.]+$/.test(label)) {
      out.push({ ...e, label })
    }
  }

  // "X ranked #1 ... score of 217.3" / "X (4.14)" pairs / "X scored 5.0"
  for (const m of text.matchAll(new RegExp(`${LABEL_RE}[^.()]{0,120}?score(?:d)?\\s+(?:of\\s+)?([\\d][\\d,.]*)`, 'gi'))) {
    push({ label: clean(m[1]), value: num(m[2]), family: 'score' })
  }
  for (const m of text.matchAll(/([A-Z][A-Za-z'’.\- ]{1,38}?)\s*\(([\d][\d,.]*)\)/g)) {
    push({ label: clean(m[1]), value: num(m[2]), family: 'score' })
  }
  // ranks: "X ranked #7" / "#7 X"
  for (const m of text.matchAll(new RegExp(`${LABEL_RE}[^.()]{0,60}?#(\\d{1,3})\\b`, 'g'))) {
    push({ label: clean(m[1]), value: num(m[2]), family: 'rank' })
  }
  // money: "€2,646/month", "$3,500 a month", "requires €3,500"
  const currency = text.match(/[€$]/)?.[0] ?? ''
  for (const m of text.matchAll(new RegExp(`${LABEL_RE}[^.()]{0,80}?[€$]\\s?([\\d][\\d,.]*)`, 'gi'))) {
    push({ label: clean(m[1]), value: num(m[2]), note: currency ? `${currency}${m[2]}` : undefined, family: 'money' })
  }
  // percents: "19-24% tax" (range → first bound + note), "0% tax"
  for (const m of text.matchAll(/([A-Za-z][A-Za-z'’.\- ]{0,38}?)\s+(\d{1,3})\s*(?:[-–]\s*(\d{1,3}))?\s*%/g)) {
    const label = clean(m[1]) || 'share'
    push({
      label,
      value: num(m[2]),
      note: m[3] ? `${m[2]}–${m[3]}%` : `${m[2]}%`,
      family: 'percent'
    })
  }
  return out
}

function clean(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]$/, '')
    .trim()
}

function indexTitle(text: string): string | undefined {
  const m = text.match(/([A-Z][A-Za-z'’\- ]{2,50}?\s(?:Index|Ranking|Rank))/)
  return m ? clean(m[1]) : undefined
}

/**
 * Pass 2 (conservative): per scene, extract comparable numbers from the
 * scene's claims and attach data cards to a composition shot. Only emits
 * when extraction is clean: ≥2 comparable values of one family (→ bars),
 * a top-N/enumeration list (→ list), or one standout figure (→ stat).
 */
export function dataCardsForClaims(scenes: CompositionScene[], claims: ClaimRow[]): CompositionScene[] {
  const byId = new Map(claims.map((c) => [String(c.claim_id ?? ''), c]))
  const seen = new Set<string>() // a claim feeding two scenes draws one card, not two
  const sig = (c: DataCard): string => `${c.kind}:${c.items.map((i) => `${i.label}=${i.value ?? i.note ?? ''}`).join('|')}`
  return scenes.map((scene) => {
    if (!scene.claims?.length) return scene
    if ((scene.shots ?? []).some((s) => s.data)) return scene // director-authored data wins
    const rows = scene.claims.map((id) => byId.get(id)).filter((c): c is ClaimRow => Boolean(c))
    if (rows.length === 0) return scene

    const extracted = rows.flatMap(extractFromClaim)
    let card = buildNumberCard(rows, extracted)
    let listCard = buildListCard(rows)
    if (card && seen.has(sig(card))) card = null
    if (listCard && seen.has(sig(listCard))) listCard = null
    if (!card && !listCard) return scene
    if (card) seen.add(sig(card))
    if (listCard) seen.add(sig(listCard))

    const shots: CompositionShot[] = [...(scene.shots ?? [])]
    const insertAt = Math.min(1, shots.length) // after the first card (or first when empty)
    if (listCard) shots.splice(insertAt, 0, dataShot(listCard))
    if (card) shots.splice(Math.min(insertAt, shots.length), 0, dataShot(card))
    return { ...scene, shots }
  })
}

function dataShot(card: DataCard): CompositionShot {
  return { kind: 'composition', template: `data-${card.kind}`, text: card.title ?? '', data: card, dur_s: 4 }
}

/** Group score/money extractions; bars only for clean, comparable sets (ranks are ordinal — never bars). */
function buildNumberCard(rows: ClaimRow[], extracted: Extracted[]): DataCard | null {
  if (extracted.length === 0) return null
  const title = indexTitle(rows.map((r) => `${r.claim_text ?? ''}`).join(' ')) ?? undefined
  // Same family, mutually comparable magnitudes (ratio ≤ 4), de-duplicated labels.
  const byFamily = new Map<string, Extracted[]>()
  for (const e of extracted) {
    if (e.family === 'rank') continue // ranks are ordinal — bars of ranks mislead; stat only
    const arr = byFamily.get(e.family) ?? []
    arr.push(e)
    byFamily.set(e.family, arr)
  }
  let best: Extracted[] | null = null
  for (const arr of byFamily.values()) {
    if (arr.length < 2) continue
    const values = arr.map((e) => e.value)
    const max = Math.max(...values)
    const min = Math.min(...values.filter((v) => v > 0))
    if (min > 0 && max / min > 4) continue // mixed scales (e.g. 217-index vs 5-star) — not comparable
    // de-dup identical labels, keep first occurrences
    const seen = new Set<string>()
    const dedup = arr.filter((e) => {
      const k = e.label.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    if (dedup.length >= 2 && (!best || dedup.length > best.length)) best = dedup
  }
  if (best && best.length >= 2) {
    best = best.slice(0, 6)
    return { kind: 'bars', title, items: best.map((e) => ({ label: e.label, value: e.value, note: e.note })) }
  }
  // single standout figure → stat (concrete magnitudes first; ranks only when
  // nothing else extracted — rank labels from table rows are often country-level).
  const standout = [...extracted].sort((a, b) => {
    const rankPenalty = (e: Extracted): number => (e.family === 'rank' ? 1 : 0)
    return rankPenalty(a) - rankPenalty(b) || b.value - a.value
  })[0]
  if (!standout) return null
  return {
    kind: 'stat',
    title,
    unit: standout.family === 'rank' ? '#' : standout.family === 'percent' ? '%' : '',
    items: [{ label: standout.label, value: standout.value, note: standout.note }]
  }
}

/** Top-N lists and parenthetical enumerations from the claims. */
function buildListCard(rows: ClaimRow[]): DataCard | null {
  for (const row of rows) {
    const text = `${row.claim_text ?? ''}`
    const top = text.match(/\b(?:Top|top)\s*(\d{1,2})\s*[:\-]\s*([^.]+)/)
    if (top) {
      const items = top[2]
        .split(/\s*(?:,|\||;)\s*|\s+\d+\.\s+/)
        .map((s) => clean(s))
        .filter((s) => s.length >= 2 && s.length <= 60)
        .slice(0, 6)
      if (items.length >= 3) {
        return { kind: 'list', title: indexTitle(text) ?? undefined, items: items.map((label) => ({ label })) }
      }
    }
    const paren = text.match(/\(([^()]{25,})\)/)
    if (paren) {
      const items = paren[1]
        .split(/\s*(?:,|;|\band\b)\s*/i)
        .map((s) => clean(s))
        .filter((s) => s.length >= 3 && s.length <= 48)
      if (items.length >= 4) {
        return { kind: 'list', title: indexTitle(text) ?? undefined, items: items.slice(0, 6).map((label) => ({ label })) }
      }
    }
  }
  return null
}

// ------------------------------------------------------------------- asset injection

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i
const VIDEO_EXT = /\.(mp4|webm|mov)$/i

const isVideoAsset = (a: AssetRow): boolean => VIDEO_EXT.test(a.saved_path ?? '')

/** Downloaded media awaiting the human rights decision (gate G-M input). */
export function mediaPending(assets: AssetRow[]): AssetRow[] {
  return assets.filter(
    (a) => a.downloaded === true && String(a.rights_status ?? '') === 'review' && (IMAGE_EXT.test(a.saved_path ?? '') || VIDEO_EXT.test(a.saved_path ?? ''))
  )
}

function usableMedia(assets: AssetRow[]): AssetRow[] {
  return assets
    .filter((a) => a.downloaded === true && String(a.rights_status ?? '') === 'approved' && Boolean(a.saved_path))
    .filter((a) => IMAGE_EXT.test(a.saved_path ?? '') || VIDEO_EXT.test(a.saved_path ?? ''))
    .sort((a, b) => String(a.asset_id ?? '').localeCompare(String(b.asset_id ?? '')))
}

/**
 * Pass 3: interleave approved downloaded media into scenes that reference
 * none. Provenance first (claim source host == asset page host), then a
 * deterministic round-robin over the remaining pool. Max 3 images and
 * 1 video per scene; end-card-only scenes stay clean.
 *
 * Evidence-link rule: video footage must be provenance-linked to the scene's
 * claims (host match) to enter the cut — unlinked videos never join the
 * round-robin pool (an AI documentary must not picture an unrelated clip).
 */
export function injectAssets(
  scenes: CompositionScene[],
  claims: ClaimRow[],
  sources: SourceRow[],
  assets: AssetRow[]
): { scenes: CompositionScene[]; injected: VisualPlan['injected'] } {
  const usable = usableMedia(assets)
  const injected: VisualPlan['injected'] = []
  if (usable.length === 0) return { scenes, injected }

  const byId = new Map(claims.map((c) => [String(c.claim_id ?? ''), c]))
  const hostBySource = new Map(sources.map((s) => [String(s.source_id ?? ''), host(s.url)]))
  const hostByAsset = new Map(assets.map((a) => [String(a.asset_id ?? ''), host(a.asset_page_url)]))

  const sceneHosts = (scene: CompositionScene): Set<string> => {
    const hosts = new Set<string>()
    for (const id of scene.claims ?? []) {
      const c = byId.get(id)
      const h = hostBySource.get(String(c?.source_id ?? ''))
      if (h) hosts.add(h)
    }
    return hosts
  }

  const linked = usable.filter((a) => {
    const h = hostByAsset.get(String(a.asset_id ?? ''))
    if (!h) return false
    return scenes.some((s) => sceneHosts(s).has(h))
  })
  // Round-robin pool: every remaining approved asset, images AND videos.
  // Videos used to be excluded here unless their page host matched a claim's
  // source host — which silently dropped ALL YouTube footage, since a video's
  // host (youtube.com) never matches a text source's host (wikipedia.org)
  // (2026-11-18 marvel dogfood: 3 downloaded documentaries, zero on screen).
  // The user's call: any rights-approved downloaded video may enter the cut.
  // Deterministic order keeps renders reproducible.
  const pool = usable
    .filter((a) => !linked.includes(a))
    .sort((a, b) => String(a.asset_id ?? '').localeCompare(String(b.asset_id ?? '')))

  let poolCursor = 0
  const nextFromPool = (): AssetRow | null => {
    if (pool.length === 0) return null
    const a = pool[poolCursor % pool.length]
    poolCursor++
    return a
  }
  // Video-first pool pick: footage is the scarcest, most filmic asset, and a
  // sorted round-robin over a large image pool would never reach it (images
  // A-0001… always win the two picks a scene takes). Pull the next unseen
  // video when a scene has none; images still fill the remaining slots.
  const videoPool = pool.filter(isVideoAsset)
  const videoSeen = new Set<string>()
  const nextVideoFromPool = (): AssetRow | null => {
    for (const v of videoPool) {
      const id = String(v.asset_id ?? '')
      if (!videoSeen.has(id)) {
        videoSeen.add(id)
        return v
      }
    }
    return null
  }
  // Linked-video cursor: a clip linked to this scene is offered only if no
  // earlier scene already took it, so a set of linked clips rotates across
  // scenes. When every linked clip is spoken for, this returns null and the
  // caller falls back to the unseen-clip pool above.
  const linkedVideoSeen = new Set<string>()
  const nextLinkedVideo = (candidates: AssetRow[]): AssetRow | null => {
    for (const v of candidates) {
      const id = String(v.asset_id ?? '')
      if (linkedVideoSeen.has(id)) continue
      linkedVideoSeen.add(id)
      videoSeen.add(id) // do not hand the same clip out again from the pool
      return v
    }
    return null
  }

  const scenesOut = scenes.map((scene, sceneIdx) => {
    const shots = scene.shots ?? []
    // A duo shot already puts media + text on screen together — injection
    // would only add more full-frame layers around it.
    const hasDuo = shots.some((s) => templateKind(s.template) === 'duo' && (duoPanelsOf(s)?.length ?? 0) > 0)
    if (hasDuo || shots.some((s) => s.kind === 'asset' || Boolean(s.asset))) return scene
    if (shots.length > 0 && shots.every((s) => s.kind === 'composition' && templateKind(s.template) === 'end')) return scene
    // Visual direction pass: the Director's scene layout steers the injector —
    // minimal/split scenes are card-forward by intent (no injection);
    // full-bleed scenes lead with their media instead of interleaving.
    const layout = scene.visual?.layout && isVisualLayout(scene.visual.layout) ? scene.visual.layout : 'standard'
    if (layout === 'minimal' || layout === 'split') return scene

    const hosts = sceneHosts(scene)
    const sceneLinked = linked.filter((a) => hosts.has(hostByAsset.get(String(a.asset_id ?? '')) ?? ''))
    const linkedImages = sceneLinked.filter((a) => !isVideoAsset(a))

    const picks: AssetRow[] = []
    let videoPicked = false
    const tryPush = (a: AssetRow | null): void => {
      if (!a || picks.includes(a) || picks.length >= 3) return
      const vid = isVideoAsset(a)
      if (vid && videoPicked) return // max 1 video per scene
      if (vid) videoPicked = true
      picks.push(a)
    }
    // Walk the scene's linked videos so a library of several clips is spread
    // across scenes instead of scene-after-scene reusing linkedVideos[0]
    // (2026-11-19: S01/S03/S04 all played the same clip). Once this scene's
    // linked videos are exhausted, fall through to the unseen-clip pool.
    tryPush(nextLinkedVideo(sceneLinked.filter(isVideoAsset)))
    for (const img of linkedImages) {
      if (picks.length >= 2) break // leave room for a pool pick
      tryPush(img)
    }
    // Prefer a pool video when the scene has none yet (footage before stills).
    if (!videoPicked) tryPush(nextVideoFromPool())
    for (let tries = 0; picks.length < 2 && tries <= pool.length; tries++) tryPush(nextFromPool())
    if (picks.length === 0) return scene

    const claimsFirst = String((scene.claims ?? [])[0] ?? '')
    const sourceFirst = String(byId.get(claimsFirst)?.source_id ?? '')

    // Injected motion: a deterministic per-scene cycle (visual direction
    // pass) — injected b-roll no longer carries one fixed kenburns look.
    const motionCycle = ['kenburns', 'push-in', 'kenburns', 'pan-left', 'pull-out', 'pan-right']
    const injectedMotion = motionCycle[sceneIdx % motionCycle.length]

    // Media shots first (caption: the asset's human title names the evidence
    // on screen — minus the "Screenshot:" fabrication prefix, pipes turned
    // into an em-dash so "X | Nature" reads as "X — Nature").
    const mediaShots: CompositionShot[] = []
    for (const a of picks) {
      const rel = String(a.saved_path ?? '').replace(/\\/g, '/')
      const caption = String(a.title ?? '')
        .trim()
        .replace(/^screenshot:\s*/i, '')
        .replace(/\s*\|\s*/, ' — ')
        .slice(0, 140)
      mediaShots.push({
        kind: 'asset',
        asset: rel,
        motion: injectedMotion,
        zoom: 1.08,
        ...(caption ? { text: caption } : {}),
        dur_s: isVideoAsset(a) ? 4 : 3
      })
      injected.push({
        asset_id: String(a.asset_id ?? ''),
        sceneId: scene.id,
        saved_path: rel,
        media_type: isVideoAsset(a) ? 'video' : 'image',
        claim_id: claimsFirst,
        source_id: sourceFirst || String(a.source_id ?? ''),
        title: String(a.title ?? '')
      })
    }

    const cards = shots.length > 0 ? shots : [{ kind: 'composition' as const, template: 'title-card', text: '', dur_s: 3 }]
    if (layout === 'full-bleed') {
      return { ...scene, shots: [...mediaShots, ...cards] }
    }
    // Interleave: asset, card, asset, card… (assets first when scene opens).
    const out: CompositionShot[] = []
    let pi = 0
    let ci = 0
    let assetNext = true
    while (ci < cards.length || pi < mediaShots.length) {
      if (assetNext && pi < mediaShots.length) {
        out.push(mediaShots[pi++])
      } else if (ci < cards.length) {
        out.push(cards[ci++])
      } else {
        break
      }
      assetNext = !assetNext
    }
    return { ...scene, shots: out }
  })

  return { scenes: scenesOut, injected }
}

// ------------------------------------------------------------------- entry point

export function planVisuals(input: {
  scenes: CompositionScene[]
  claims: ClaimRow[]
  sources: SourceRow[]
  assets: AssetRow[]
}): VisualPlan {
  const mediaPendingRows = mediaPending(input.assets)
  const chunked = chunkTextShots(input.scenes)
  const withData = dataCardsForClaims(chunked, input.claims)
  const { scenes, injected } = injectAssets(withData, input.claims, input.sources, input.assets)
  return { scenes, injected, mediaPending: mediaPendingRows }
}

// -------------------------------------------------- shot-list card stills (DWK)

/**
 * DWK v1 requires every shot_list.csv row to point at a local image/video
 * file; designed graphics are the kit's sanctioned context shots (missing
 * source_id → warning, not error). The Studio's cards are HyperFrames HTML,
 * so produce-time registration exports a still that mirrors the card's
 * content into media/graphics/ — honest provenance, DWK-valid rows.
 */

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const xmlEsc = (s: string): string => String(s ?? '').replace(/[&<>"]/g, (c) => XML_ESC[c])

function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxChars && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1].trimEnd()}…`]
  return lines
}

/** Theme tokens for exported card stills (mirrors the film's resolved preset). */
export interface StillTheme {
  bg: string
  panel: string
  text: string
  dim: string
  accent: string
}

const STILL_THEME_FALLBACK: StillTheme = { bg: '#10131c', panel: '#1c2230', text: '#f2f4f8', dim: '#c7cfdd', accent: '#6ea8fe' }

/** Content-true SVG still of a duo shot (two boxes side by side). */
function duoStillSvg(shot: CompositionShot, theme: StillTheme): string {
  const panels = (duoPanelsOf(shot) ?? []).slice(0, 2)
  const parts: string[] = [`<rect width="1920" height="1080" fill="${theme.bg}"/>`]
  const panelW = 780
  const gap = 60
  const x0 = 120
  panels.forEach((p, i) => {
    const x = x0 + i * (panelW + gap)
    parts.push(`<rect x="${x}" y="200" width="${panelW}" height="600" fill="${theme.panel}"/>`)
    parts.push(`<rect x="${x}" y="200" width="8" height="600" fill="${theme.accent}"/>`)
    let y = 280
    if (p.kicker) {
      parts.push(`<text x="${x + 40}" y="${y}" font-family="monospace" font-size="24" letter-spacing="4" fill="${theme.accent}">${xmlEsc(p.kicker.toUpperCase())}</text>`)
      y += 58
    }
    for (const line of wrapLines(String(p.title ?? ''), 22, 3)) {
      parts.push(`<text x="${x + 40}" y="${y}" font-family="serif" font-size="64" font-weight="700" fill="${theme.text}">${xmlEsc(line)}</text>`)
      y += 76
    }
    if (p.note) {
      for (const line of wrapLines(String(p.note), 32, 2)) {
        parts.push(`<text x="${x + 40}" y="${y}" font-family="sans-serif" font-size="30" fill="${theme.dim}">${xmlEsc(line)}</text>`)
        y += 40
      }
    }
  })
  parts.push(
    `<text x="120" y="1020" font-family="sans-serif" font-size="30" fill="${theme.dim}">designed duo graphic — two-panel image + text card (motion composed in the render)</text>`
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${parts.join('')}</svg>`
}

/** Content-true SVG still of a composition card (shot-list designed-graphic row). */
export function cardStillSvg(shot: CompositionShot, theme: StillTheme = STILL_THEME_FALLBACK): string {
  if (templateKind(shot.template) === 'duo') return duoStillSvg(shot, theme)
  const titleLines = wrapLines(String(shot.text ?? shot.data?.title ?? shot.data?.headline ?? ''), 36, 3)
  const items = (shot.data?.items ?? []).slice(0, 5)
  const maxVal = items.reduce((m, i) => Math.max(m, typeof i.value === 'number' ? i.value : 0), 0)
  const parts: string[] = [`<rect width="1920" height="1080" fill="${theme.bg}"/>`]
  const titleY0 = 300
  titleLines.forEach((line, i) => {
    parts.push(
      `<text x="170" y="${titleY0 + i * 92}" font-family="sans-serif" font-size="72" font-weight="700" fill="${theme.text}">${xmlEsc(line)}</text>`
    )
  })
  if (titleLines.length > 0) {
    parts.push(`<rect x="120" y="${titleY0 - 64}" width="10" height="${titleLines.length * 92 - 30}" rx="5" fill="${theme.accent}"/>`)
  }
  const itemsY0 = titleLines.length ? titleY0 + titleLines.length * 92 + 40 : titleY0
  items.forEach((it, i) => {
    const y = itemsY0 + i * 80
    const label = `${String(it.label ?? '')}${typeof it.value === 'number' ? ` — ${it.value}${shot.data?.unit ?? ''}` : ''}${it.note ? ` (${it.note})` : ''}`
    if (maxVal > 0 && typeof it.value === 'number') {
      const w = Math.max(24, Math.round((1100 * it.value) / maxVal))
      parts.push(`<rect x="170" y="${y}" width="1100" height="44" rx="8" fill="${theme.panel}"/>`)
      parts.push(`<rect x="170" y="${y}" width="${w}" height="44" rx="8" fill="${theme.accent}"/>`)
      parts.push(`<text x="${Math.min(170 + w + 24, 1460)}" y="${y + 34}" font-family="sans-serif" font-size="38" fill="${theme.dim}">${xmlEsc(label)}</text>`)
    } else {
      parts.push(`<text x="170" y="${y + 34}" font-family="sans-serif" font-size="42" fill="${theme.dim}">• ${xmlEsc(label)}</text>`)
    }
  })
  if ((shot.data?.items ?? []).length > items.length) {
    parts.push(
      `<text x="170" y="${itemsY0 + items.length * 80 + 34}" font-family="sans-serif" font-size="38" fill="${theme.dim}">+ ${(shot.data?.items ?? []).length - items.length} more</text>`
    )
  }
  parts.push(
    `<text x="120" y="1020" font-family="sans-serif" font-size="30" fill="${theme.dim}">designed graphic — ${xmlEsc(String(shot.template ?? 'title-card'))} card still (motion composed in the render)</text>`
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${parts.join('')}</svg>`
}

/** Human label for a card row's visual_label column. */
export function cardLabel(shot: CompositionShot): string {
  const kind = templateKind(shot.template)
  if (kind === 'duo') {
    const panels = duoPanelsOf(shot) ?? []
    const names = panels
      .map((p) => String(p.title ?? p.kicker ?? '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' / ')
    return `duo card${names ? `: ${names}` : ''}`.slice(0, 90)
  }
  const title = String(shot.text ?? shot.data?.title ?? shot.data?.headline ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ')
  return `${kind} card${title ? `: ${title}` : ''}`.slice(0, 90)
}

// ------------------------------------------------ shot-list registration (DWK)

export interface ShotListRow {
  start_frame: number
  end_frame: number
  asset_path: string
  asset_type: string
  source_in: string
  source_id: string
  claim_id: string
  visual_label: string
  notes: string
}

/**
 * DWK interchange rows for production/shot_list.csv: the FULL picture
 * timeline 0..totalFrames, frame-contiguous (bridge + dwk.validate_project
 * enforce `row N start == row N-1 end`). Media shots keep their provenance;
 * card stretches export content-true SVG stills into media/graphics/ so every
 * row points at an existing image/video file (DWK AGENT_GUIDE §3). Crossfade
 * overlaps (L-cut scene starts) are absorbed by clamping starts forward;
 * fully-absorbed shots are skipped — contiguity holds by construction.
 */
export function buildShotListRows(input: {
  scenes: CompositionScene[]
  timings: SceneTiming[]
  fps: number
  injected: VisualPlan['injected']
  ledger: AssetRow[]
  /** Film theme for exported card stills (defaults to the dark fallback). */
  theme?: StillTheme
  /** Visual direction pass: per-scene theme override (scene id → theme). */
  themeByScene?: Record<string, StillTheme>
}): { rows: ShotListRow[]; cardStills: Array<{ rel: string; svg: string }>; mediaCount: number } {
  const ledgerByPath = new Map(input.ledger.map((a) => [String(a.saved_path ?? '').replace(/\\/g, '/'), a] as const))
  const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene'
  const rows: ShotListRow[] = []
  const cardStills: Array<{ rel: string; svg: string }> = []
  let mediaCount = 0
  let lastEnd: number | null = null
  for (const scene of input.scenes) {
    const t = input.timings.find((x) => x.id === scene.id)
    if (!t) continue
    const scaled = scaleShotsToDuration(scene.shots ?? [], t.durS, input.fps)
    let frame = t.startFrame
    for (let si = 0; si < scaled.length; si++) {
      const item = scaled[si]
      const start = frame
      frame += item.frames
      const clampedStart = lastEnd !== null ? Math.max(start, lastEnd) : start
      if (frame <= clampedStart) continue // fully inside a crossfade overlap
      lastEnd = frame
      const assetPath = item.shot.kind === 'asset' ? String(item.shot.asset ?? '').replace(/\\/g, '/') : ''
      if (assetPath) {
        mediaCount++
        const inj = input.injected.find((x) => x.sceneId === scene.id && x.saved_path === assetPath)
        const ledger = ledgerByPath.get(assetPath)
        rows.push({
          start_frame: clampedStart,
          end_frame: frame,
          asset_path: assetPath,
          asset_type: inj?.media_type ?? (/\.(mp4|webm|mov)$/i.test(assetPath) ? 'video' : 'image'),
          // In-point chosen by the video-moment pass (0 when unset) — the
          // DWK schema documents this as seconds into a video source.
          source_in: String(Number(item.shot.source_in ?? 0) || 0),
          source_id: inj?.source_id ?? String(ledger?.source_id ?? ''),
          claim_id: inj?.claim_id ?? '',
          visual_label: inj?.title || String(ledger?.title ?? '') || assetPath.split('/').pop() || assetPath,
          notes: inj ? 'auto-injected research media (approved via gate G-M)' : 'workflow shot (rights-approved)'
        })
      } else {
        const rel = `media/graphics/card_${slug(scene.id)}_${String(si).padStart(2, '0')}.svg`
        cardStills.push({ rel, svg: cardStillSvg(item.shot, input.themeByScene?.[scene.id] ?? input.theme) })
        rows.push({
          start_frame: clampedStart,
          end_frame: frame,
          asset_path: rel,
          asset_type: 'image',
          source_in: '',
          source_id: '',
          claim_id: '',
          visual_label: cardLabel(item.shot),
          notes: 'designed graphic (HyperFrames card still)'
        })
      }
    }
  }
  return { rows, cardStills, mediaCount }
}
