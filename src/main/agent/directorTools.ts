import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BridgeClient } from '../bridge'
import {
  readScriptSections,
  writeBible,
  writeBeats,
  writeScript,
  writeStyle,
  writeWorkflow,
  type BeatInput,
  type BibleInput,
  type ProjectStyleInput,
  type ScriptInput,
  type ScriptSectionInput,
  type WorkflowDuoPanelInput,
  type WorkflowInput,
  type WorkflowSceneInput,
  type WorkflowShotInput
} from '../artifacts'
import {
  isVisualLayout,
  isVisualMood,
  isVisualMotion,
  isVisualTransition,
  templateKind,
  TRANSITION_SETS,
  VISUAL_LAYOUTS,
  VISUAL_MOODS,
  VISUAL_MOTIONS,
  VISUAL_TRANSITIONS,
  type DataCard,
  type SceneVisual
} from '../producer/compositions'
import type { AgentTool } from './chat'

/** Validate a director-authored data card (bars/stat/list) before it reaches disk. */
const DATA_KINDS = ['bars', 'stat', 'list', 'line', 'timeline', 'map', 'article'] as const

function parseDataCard(shot: Record<string, unknown>): DataCard | undefined {
  const d = shot.data as Record<string, unknown> | undefined
  if (!d) return undefined
  let kind = String(d.kind ?? '')
  // Models intermittently omit data.kind while still sending a well-formed
  // payload (2026-11-18 marvel dogfood: 6 retries on `kind got ''`). Infer the
  // obvious intent from the payload shape instead of rejecting — the shot
  // template already names the card, so a missing kind is a formatting slip,
  // not ambiguity. Only reject when nothing identifies the card.
  if (!(DATA_KINDS as readonly string[]).includes(kind)) {
    const template = String(shot.template ?? '')
    const fromTemplate = template.replace(/^data-/, '')
    if ((DATA_KINDS as readonly string[]).includes(fromTemplate)) kind = fromTemplate
    else if (Array.isArray(d.events)) kind = 'timeline'
    else if (Array.isArray(d.markers)) kind = 'map'
    else if (Array.isArray(d.series) && Array.isArray(d.labels)) kind = 'line'
    else if (d.headline || d.quote) kind = 'article'
    else if (Array.isArray(d.items)) {
      // items[] with a single entry and no `value` reads as a prose stat/pull-quote;
      // several entries or any numeric value read as bars.
      const items = d.items as Array<Record<string, unknown>>
      const hasValue = items.some((it) => typeof it?.value === 'number')
      kind = items.length <= 1 && !hasValue ? 'stat' : 'bars'
    } else {
      throw new Error(
        `shot data.kind must be ${DATA_KINDS.join('|')}, got '${kind}' — or supply the payload that identifies it (items[] / labels+series / events / markers / headline+quote)`
      )
    }
  }
  const card: DataCard = { kind: kind as DataCard['kind'], items: [] }
  if (d.title) card.title = String(d.title)
  if (d.unit) card.unit = String(d.unit)
  if (d.note) card.note = String(d.note)

  if (kind === 'line') {
    const labels = Array.isArray(d.labels) ? d.labels.map((l) => String(l)) : []
    if (labels.length < 2 || labels.length > 12) {
      throw new Error('data-line needs labels[2..12] — one x-axis label per point (years or categories)')
    }
    const seriesIn = Array.isArray(d.series) ? (d.series as Array<Record<string, unknown>>) : []
    if (seriesIn.length === 0 || seriesIn.length > 3) throw new Error('data-line needs series[1..3], each {label?, values:[numbers]}')
    card.labels = labels
    card.series = seriesIn.map((s, si) => {
      const values = Array.isArray(s.values) ? s.values.map((v) => Number(v)) : []
      if (values.length !== labels.length) {
        throw new Error(`data-line series ${si + 1} has ${values.length} values but labels has ${labels.length}`)
      }
      if (!values.every((v) => Number.isFinite(v))) throw new Error(`data-line series ${si + 1} has a non-numeric value`)
      const out: { label?: string; values: number[] } = { values }
      if (s.label) out.label = String(s.label)
      return out
    })
    return card
  }

  if (kind === 'timeline') {
    const eventsIn = Array.isArray(d.events) ? (d.events as Array<Record<string, unknown>>) : []
    if (eventsIn.length < 2 || eventsIn.length > 10) {
      throw new Error('data-timeline needs events[2..10] — dated milestones with label + year')
    }
    card.events = eventsIn.map((e, i) => {
      const label = String(e.label ?? '').trim()
      if (!label) throw new Error(`data-timeline event ${i + 1}: label is required`)
      const out: NonNullable<DataCard['events']>[number] = { label }
      if (e.year !== undefined && e.year !== null && String(e.year) !== '') {
        const year = Number(e.year)
        if (!Number.isFinite(year)) throw new Error(`data-timeline event ${i + 1}: year must be a number`)
        out.year = year
      }
      if (e.note) out.note = String(e.note)
      if (e.highlight === true) out.highlight = true
      return out
    })
    return card
  }

  if (kind === 'map') {
    const markersIn = Array.isArray(d.markers) ? (d.markers as Array<Record<string, unknown>>) : []
    if (markersIn.length === 0 || markersIn.length > 8) {
      throw new Error('data-map needs markers[1..8] — {label, lat?, lon?, note?, highlight?}')
    }
    card.markers = markersIn.map((m, i) => {
      const label = String(m.label ?? '').trim()
      if (!label) throw new Error(`data-map marker ${i + 1}: label is required`)
      const out: NonNullable<DataCard['markers']>[number] = { label }
      const hasLat = m.lat !== undefined && m.lat !== null && String(m.lat) !== ''
      const hasLon = m.lon !== undefined && m.lon !== null && String(m.lon) !== ''
      if (hasLat !== hasLon) throw new Error(`data-map marker ${i + 1}: supply both lat and lon, or neither (the gazetteer can resolve common cities)`)
      if (hasLat && hasLon) {
        const lat = Number(m.lat)
        const lon = Number(m.lon)
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`data-map marker ${i + 1}: lat must be -90..90`)
        if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`data-map marker ${i + 1}: lon must be -180..180`)
        out.lat = lat
        out.lon = lon
      }
      if (m.note) out.note = String(m.note)
      if (m.highlight === true) out.highlight = true
      return out
    })
    card.route = d.route === true
    return card
  }

  if (kind === 'article') {
    const headline = String(d.headline ?? '').trim()
    const quote = String(d.quote ?? '').trim()
    if (!headline && !quote) throw new Error('data-article needs a headline and/or quote — the clipping carries real source text')
    if (headline) card.headline = headline
    if (quote) card.quote = quote
    for (const key of ['publication', 'date', 'body', 'attribution'] as const) {
      if (d[key]) card[key] = String(d[key])
    }
    return card
  }

  const itemsIn = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : []
  if (itemsIn.length === 0) throw new Error(`shot data.kind=${kind} needs at least one {label, value?} item`)
  card.items = itemsIn.map((it, i) => {
    const label = String(it.label ?? '').trim()
    if (!label) throw new Error(`shot data item ${i + 1}: label is required`)
    const item: DataCard['items'][number] = { label }
    const value = Number(it.value)
    if (it.value !== undefined && Number.isFinite(value)) item.value = value
    if (it.note) item.note = String(it.note)
    return item
  })
  return card
}

/** Validate a duo (two-box) shot's panels: exactly two, each with visible content. */
function parseDuoPanels(sceneId: string, shotIndex: number, raw: unknown): WorkflowDuoPanelInput[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`scene ${sceneId} shot ${shotIndex + 1}: panels must be an array of two panels`)
  if (raw.length !== 2) {
    throw new Error(`scene ${sceneId} shot ${shotIndex + 1}: a duo needs exactly TWO panels (got ${raw.length}) — two boxes side by side`)
  }
  return raw.map((entry, pi) => {
    const p = (entry ?? {}) as Record<string, unknown>
    const panel: WorkflowDuoPanelInput = {}
    if (p.asset_path !== undefined && p.asset_path !== null && String(p.asset_path) !== '') {
      panel.assetPath = String(p.asset_path).replace(/\\/g, '/')
    }
    if (p.kicker) panel.kicker = String(p.kicker).trim()
    if (p.title) panel.title = String(p.title).trim()
    if (p.note) panel.note = String(p.note).trim()
    if (p.motion !== undefined && p.motion !== null && String(p.motion) !== '') {
      const motion = String(p.motion).toLowerCase()
      if (!isVisualMotion(motion)) {
        throw new Error(`scene ${sceneId} shot ${shotIndex + 1} panel ${pi + 1}: motion '${motion}' is invalid — valid motions: ${VISUAL_MOTIONS.join(', ')}`)
      }
      panel.motion = motion
    }
    if (p.zoom !== undefined && p.zoom !== null && Number.isFinite(Number(p.zoom))) panel.zoom = Number(p.zoom)
    if (!panel.title && !panel.note) {
      throw new Error(`scene ${sceneId} shot ${shotIndex + 1} panel ${pi + 1}: needs a title or note — an empty box is a blank frame`)
    }
    return panel
  })
}

/** Validate a director-authored per-scene look (visual direction pass). */
function parseSceneVisual(sceneId: string, raw: Record<string, unknown>): SceneVisual | undefined {
  const v = raw.visual as Record<string, unknown> | undefined
  if (!v) return undefined
  const visual: SceneVisual = {}
  if (v.mood !== undefined && v.mood !== null && String(v.mood) !== '') {
    const mood = String(v.mood).toLowerCase()
    if (!isVisualMood(mood)) {
      throw new Error(`scene ${sceneId}: visual.mood '${mood}' is invalid — valid moods: ${VISUAL_MOODS.join(', ')}`)
    }
    visual.mood = mood
  }
  if (v.layout !== undefined && v.layout !== null && String(v.layout) !== '') {
    const layout = String(v.layout).toLowerCase()
    if (!isVisualLayout(layout)) {
      throw new Error(`scene ${sceneId}: visual.layout '${layout}' is invalid — valid layouts: ${VISUAL_LAYOUTS.join(', ')}`)
    }
    visual.layout = layout
  }
  if (v.accent !== undefined && v.accent !== null && String(v.accent) !== '') {
    const accent = String(v.accent).toLowerCase()
    if (!/^#[0-9a-f]{6}$/.test(accent)) {
      throw new Error(`scene ${sceneId}: visual.accent '${accent}' must be #rrggbb (e.g. #b3542f)`)
    }
    visual.accent = accent
  }
  return Object.keys(visual).length ? visual : undefined
}

/** Scenes of the current studio/workflow.json, or undefined when absent/unparseable. */
function readWorkflowScenes(projectPath: string): Array<{ vo?: { script_section?: string } }> | undefined {
  try {
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8')) as {
      scenes?: Array<{ vo?: { script_section?: string } }>
    }
    return Array.isArray(wf.scenes) ? wf.scenes : []
  } catch {
    return undefined
  }
}

/**
 * Director tool catalog (AGENT-SPEC §3, Director column). The model authors
 * STRUCTURED JSON via these tool calls; deterministic serializers in
 * artifacts.ts shape every on-disk artifact. Validators reject anything that
 * would break DWK cross-references (claim ids, asset existence, contiguity).
 */

export interface DirectorActivity {
  type: 'tool_call' | 'tool_result' | 'message' | 'error' | 'done'
  tool?: string
  summary?: string
  at: string
}

export interface DirectorDeps {
  bridge: BridgeClient
  projectPath: string
  voice: string
  revisionNotes: string | null
  /** User-set runtime in seconds (from project.yml); null/absent = the Director decides from the evidence. */
  targetRuntimeSeconds?: number | null
  emit: (activity: DirectorActivity) => void
}

export const directorToolSchemas: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'state_digest',
      description: 'Read everything already gathered: sources, claims, downloadable assets (with saved paths and rights). Call once at the start.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bible_write',
      description:
        'Write the Documentary Bible: thesis, arc, and scene-by-scene structure with beats. Each scene states what must be shown and what the viewer must feel. Scene ids are S01, S02…; beat ids B01, B02… sequential. Scene durations (duration_target_s) must sum to the film runtime — the user target when one was set, otherwise the runtime you decided (state it in runtime_decision).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          thesis: { type: 'string' },
          runtime_decision: {
            type: 'string',
            description:
              'Only when no user runtime was given: the runtime you chose and the evidence-based reason, one line (e.g. "7 min — two strong claim arcs justify a full essay; more would pad").'
          },
          emotional_promise: { type: 'string', description: 'the emotional journey in one line, e.g. "wonder turning to unease, ending in resolve"' },
          style_preset: {
            type: 'string',
            default: 'vox-explainer',
            description:
              'Design system, matched to the niche. Each preset is a different LAYOUT LANGUAGE, not a recolour: vox-explainer = Swiss editorial grid (black canvas, cream paper panels, acid accent, monospace labels, square geometry); true-crime = forensic case file (aged kraft paper, letterpress serif, taped exhibits, redaction bars); archival-history = newsprint broadsheet (cream stock, halftone photos, masthead rules); science-explainer = vivid navy (saturated gradients, glowing numerals, rounded glass); investigative-cinema = cinematic noir (letterbox, mono timecodes, hairline rules, sparse type); business-clean = clean data (white field, hairline grid, tabular numerals); kallaway = premium dark glass. State in one bible line why it fits this film.'
          },
          arc: { type: 'string', description: 'the narrative arc paragraph: hook → context → evidence & counterpoint → turn → payoff' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string', description: 'beat label: Hook, Context, Evidence, Turn, Payoff…' },
                title: { type: 'string' },
                shows: { type: 'string', description: 'what must be shown (reference asset ids A-0001 etc. and claim ids)' },
                feels: { type: 'string', description: 'what the viewer must feel + why they keep watching' },
                motion: { type: 'string' },
                look: {
                  type: 'string',
                  description:
                    'one-line VISUAL PLAN for the scene (how it looks on screen: mood, color move, layout, motion intent) — e.g. "noir grade, hard cut in, slow push on the archive photo"'
                },
                on_screen_text: { type: 'string' },
                duration_target_s: { type: 'integer' },
                claims: { type: 'array', items: { type: 'string' } },
                asset_ids: { type: 'array', items: { type: 'string' } },
                beat: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    curiosity: { type: 'number', minimum: 0, maximum: 1 },
                    tension: { type: 'number', minimum: 0, maximum: 1 },
                    rehook: { type: 'boolean' },
                    pattern_interrupt: { type: 'string' },
                    opens_loop: { type: 'string', description: 'the question this beat plants (open-loop bookkeeping)' },
                    closes_loop: { type: 'string', description: 'the earlier question this beat pays off' },
                    music: { type: 'string' },
                    sfx: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['id', 'curiosity', 'tension']
                }
              },
              required: ['id', 'label', 'title', 'shows', 'feels', 'motion', 'on_screen_text', 'duration_target_s', 'claims', 'beat']
            }
          }
        },
        required: ['title', 'thesis', 'emotional_promise', 'arc', 'scenes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'script_write',
      description:
        'Write the spoken narration script, evidence-mapped: every factual claim carries its ledger id inline as (CLM-0001), using the claim_id values from state_digest. Sections match bible scenes (ids: hook, context1, …). Spoken language, concise. A full film script may not fit one tool call: write as many sections as fit, then call again with mode "append" for the rest — each append call merges its sections into the script so far by id.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description:
              'replace (default) writes the whole script from this call\'s sections. append MERGES these sections into the script so far by id (same id replaces, new id is added, other sections are kept) — use it to grow or deepen the script across calls.'
          },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                pace: { type: 'number', default: 1.0 },
                energy: { type: 'string', enum: ['low', 'neutral', 'high'] },
                body: { type: 'string' }
              },
              required: ['id', 'title', 'body']
            }
          }
        },
        required: ['sections']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shots_write',
      description:
        'Write the frame-contiguous shot list. Every row references a DOWNLOADED, rights-APPROVED asset from the digest (saved_path with rights_status "approved") — unapproved or undownloaded assets are rejected. If no asset is approved yet, call this with rows: [] and build the film from compositions. Frames must be contiguous from 0 with no gaps.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start_frame: { type: 'integer' },
                end_frame: { type: 'integer' },
                asset_path: { type: 'string', description: 'relative saved_path of a downloaded asset' },
                asset_type: { type: 'string', enum: ['image', 'video'] },
                source_in: { type: 'number' },
                source_id: { type: 'string' },
                claim_id: { type: 'string' },
                visual_label: { type: 'string' },
                notes: { type: 'string' }
              },
              required: ['start_frame', 'end_frame', 'asset_path', 'asset_type']
            }
          }
        },
        required: ['rows']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workflow_write',
      description:
        'Write the executable workflow: per-scene shots (assets from the shot list or composition templates), VO section mapping, transitions, sfx, claims. Scene ids and beat ids must match the bible; claims are ledger claim ids in CLM-0001 form from state_digest. VISUAL CRAFT: every data-stat shot MUST carry data {label, value, note?} with a real figure from the evidence; data-bars/data-list MUST carry data.items [{label, value?}] — empty shells are rejected. TEXT MUST FIT: one idea per card; headline ≤ 60 characters; a data-stat figure ≤ 10 characters (a prose sentence is NOT a figure — use quote-card or put it in data.items[0].note); never repeat the figure in the card title; labels ≤ 40 characters. TWO BOXES: when the beat compares two things (A/B, before/after, claim vs counterclaim, two people/eras), use template "duo" with exactly two panels [{asset_path, kicker, title, note}, …] so image and text sit together on one screen. CHARTS & MAPS: use data-line for a trend (3–8 points, 1–2 series), data-timeline for a chronology (4–8 milestones spread across the years), data-map for geography (2–6 real places with lat/lon or city names; route:true for a journey), and article for a key source quote (publication/date/headline/body/quote — it recreates the clipping and sweeps a highlighter across the quote, labeled as a reconstruction). A map answers "where", a timeline "when", a line "how much"; use them where they carry meaning, not as a slideshow of charts. TIMING: every shot must carry narration_cue — the exact phrase from the script it illustrates (3–15 words). The Producer generates the voice-over first and cuts each visual to those spoken words; cues keep the picture locked to the narration. Vary the visual language (mix exhibits, data cards, duo panels, and title moments) — three identical card types back-to-back reads as a slideshow. VISUAL DIRECTION: give each scene a visual {mood, layout, accent?} that serves its beat and keep motion intentional per shot.',
      parameters: {
        type: 'object',
        properties: {
          quality: { type: 'string', enum: ['draft', 'standard', 'high'], default: 'standard' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'scene id, S01-style (S01, S02…), matching bible_write' },
                beats: { type: 'array', items: { type: 'string' }, description: 'beat ids from bible_write (B01-style)' },
                vo_script_section: {
                  type: 'string',
                  description:
                    'REQUIRED — the id of the script section this scene narrates, exactly as written by script_write (S01, S02…). Never leave empty: each scene maps 1:1 to one script section.'
                },
                visual: {
                  type: 'object',
                  description:
                    'the scene look (visual direction). mood: neutral|warm|cool|sepia|noir|vivid — grade the footage to the beat; layout: standard|full-bleed|split|centered|minimal — how cards/media compose (split only when the scene has media to fill the other side; use centered for graphics-only scenes); accent: #rrggbb optional palette shift (act breaks live here).',
                  properties: {
                    mood: { type: 'string', enum: ['neutral', 'warm', 'cool', 'sepia', 'noir', 'vivid'] },
                    layout: { type: 'string', enum: ['standard', 'full-bleed', 'split', 'centered', 'minimal'] },
                    accent: { type: 'string', description: '#rrggbb — optional scene accent shift' }
                  }
                },
                shots: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['asset', 'composition'] },
                      asset_path: { type: 'string' },
                      motion: {
                        type: 'string',
                        enum: ['kenburns', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'still'],
                        description: 'asset motion grammar — push-in on reveals, still on solemn evidence, pan to travel across scale'
                      },
                      narration_cue: {
                        type: 'string',
                        description:
                          'the exact (or near-exact) phrase from your script that this shot illustrates, 3–15 words. The Producer generates the voice-over first, then aligns each shot to these words; without a cue it falls back to matching the card text. Every shot should have one.'
                      },
                      zoom: { type: 'number' },
                      template: {
                        type: 'string',
                        description:
                          'composition template id. Data cards: data-bars (comparable scores/money/percent), data-stat (one standout figure), data-list (top-N list or enumeration), data-line (animated trend: labels + series), data-timeline (animated chronology: events with years), data-map (animated location map: markers with lat/lon or city names, optional route), article (reconstructed source clipping with a highlighter sweep: publication/date/headline/body/quote), quote-card (prose quote), duo (TWO image+text panels side by side — requires panels[2]).'
                      },
                      text: { type: 'string', description: 'card text — max ~70 chars; one idea per card; never cram a ranking into one string' },
                      panels: {
                        type: 'array',
                        minItems: 2,
                        maxItems: 2,
                        description:
                          'duo template only: exactly two panels laid out left → right. Each panel is an evidence image (asset_path) and/or a short text block (kicker + title + note). Both assets must be rights-approved and distinct.',
                        items: {
                          type: 'object',
                          properties: {
                            asset_path: { type: 'string', description: 'rights-approved image/video saved_path (omit for a text-only panel)' },
                            kicker: { type: 'string', description: 'small source/category label (max ~40 chars)' },
                            title: { type: 'string', description: 'panel headline (max ~50 chars)' },
                            note: { type: 'string', description: 'one-line annotation (max ~70 chars)' },
                            motion: {
                              type: 'string',
                              enum: ['kenburns', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'still']
                            },
                            zoom: { type: 'number' }
                          }
                        }
                      },
                      data: {
                        type: 'object',
                        description:
                          'Structured motion-graphics payload (use instead of prose). kinds: bars/stat/list need items[]; line needs labels[] + series[]; timeline needs events[]; map needs markers[]; article needs headline/quote (a reconstructed source clipping with an animated highlighter).',
                        properties: {
                          kind: { type: 'string', enum: ['bars', 'stat', 'list', 'line', 'timeline', 'map', 'article'] },
                          title: { type: 'string' },
                          unit: { type: 'string', description: 'chart unit, e.g. "films" or "%"' },
                          note: { type: 'string', description: 'small source/method note under the graphic' },
                          items: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string' },
                                value: { type: 'number' },
                                note: { type: 'string' }
                              },
                              required: ['label']
                            }
                          },
                          labels: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'data-line x-axis labels (2–12), one per value; years or categories'
                          },
                          series: {
                            type: 'array',
                            description: 'data-line: 1–3 series; each values[] has exactly one number per label',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string' },
                                values: { type: 'array', items: { type: 'number' } }
                              },
                              required: ['values']
                            }
                          },
                          events: {
                            type: 'array',
                            description: 'data-timeline: 2–10 milestones, chronologically spread out; year is optional but recommended',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string' },
                                year: { type: 'number' },
                                note: { type: 'string' },
                                highlight: { type: 'boolean' }
                              },
                              required: ['label']
                            }
                          },
                          markers: {
                            type: 'array',
                            description:
                              'data-map: 1–8 real locations. Supply lat/lon when known (both together); common cities resolve from an offline gazetteer. highlight marks the key location.',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string' },
                                lat: { type: 'number' },
                                lon: { type: 'number' },
                                note: { type: 'string' },
                                highlight: { type: 'boolean' }
                              },
                              required: ['label']
                            }
                          },
                          route: { type: 'boolean', description: 'data-map: draw an animated route through the markers in order' },
                          publication: { type: 'string', description: 'data-article: publication name' },
                          date: { type: 'string', description: 'data-article: publication date' },
                          headline: { type: 'string', description: 'data-article: the article headline' },
                          body: { type: 'string', description: 'data-article: a short verbatim excerpt (2–4 lines)' },
                          quote: { type: 'string', description: 'data-article: the sentence to highlight (the key claim)' },
                          attribution: { type: 'string', description: 'data-article: author or byline' }
                        },
                        required: ['kind']
                      },
                      items: { type: 'array', items: { type: 'string' }, description: 'chunked card lines (one short line each) when the text is a list' },
                      dur_s: { type: 'number' }
                    },
                    required: ['kind', 'dur_s']
                  }
                },
                transition_in: {
                  type: 'string',
                  enum: ['cut', 'fade', 'crossfade', 'dip-to-black'],
                  description: 'scene entrance; omit to inherit the film transition_set (style.json)'
                },
                transition_out: {
                  type: 'string',
                  enum: ['cut', 'fade', 'crossfade', 'dip-to-black'],
                  description: 'scene exit; omit to inherit the film transition_set (style.json)'
                },
                sfx: { type: 'array', items: { type: 'string' } },
                claims: { type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'beats', 'vo_script_section', 'shots']
            }
          }
        },
        required: ['scenes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'style_write',
      description:
        'Write the film VISUAL IDENTITY to studio/style.json (visual direction): the accent color, caption treatment, grain/vignette and the transition signature that make THIS film look like itself — derived from the thesis/period/subject, never the preset stock values. Call once after workflow_write. The user can override any key later in the Style panel.',
      parameters: {
        type: 'object',
        properties: {
          accent: { type: 'string', description: '#rrggbb — the film accent, derived from subject/period (not the preset default)' },
          caption_style: { type: 'string', enum: ['kinetic', 'boxed', 'off'] },
          vignette: { type: 'boolean' },
          grain: { type: 'boolean', description: 'false removes grain; true keeps the preset grain' },
          transition_set: {
            type: 'string',
            enum: ['smooth', 'hard-cuts', 'cinematic', 'broadcast'],
            description:
              'the film transition signature — the default scene pair: smooth (fade/crossfade), hard-cuts (cut/cut), cinematic (dip-to-black in, crossfade out), broadcast (cut in, crossfade out)'
          },
          look: { type: 'string', description: 'one line naming the visual identity, e.g. "1930s newsprint: oxblood accent, heavy grain, hard cuts on reveals"' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retention_review',
      description:
        'Self-check the designed film against the retention rubric BEFORE finishing: re-hook coverage, scene duration vs spoken narration (dead zones), cut cadence, hook length + hook opening on evidence, open-loop bookkeeping. Call it after workflow_write; if it reports blocking findings, revise the failing artifacts and review again.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the direction task with an honest summary of the film design.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    }
  }
]

// --------------------------------------------------------------- handlers

export function createDirectorHandlers(deps: DirectorDeps): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const { bridge, projectPath, voice, targetRuntimeSeconds } = deps

  // script_write retry bookkeeping (one Director run = one handler set).
  // A weak model often cannot fit a whole 15-minute script (~2,325 words)
  // into one tool call and then anchors on its previous attempt — the
  // 2026-11-19 dogfood burned 15+ turns rewriting the same 1,730-word script
  // and ended with NO script on disk. `scriptAccumulated` carries the latest
  // known sections across calls so append mode never loses the model's work;
  // `scriptBudgetRejections` drives the loop-breaker acceptance below.
  let scriptBudgetRejections = 0
  let scriptAccumulated: ScriptSectionInput[] | null = null

  const claimIds = async (): Promise<Set<string>> => {
    const res = (await bridge.request('ledger.list', { project_path: projectPath, kind: 'evidence' })) as {
      rows?: Array<Record<string, unknown>>
    }
    return new Set((Array.isArray(res.rows) ? res.rows : []).map((r) => String(r.claim_id ?? '')))
  }

  // assets.list returns the Asset Library merged view (bridge server.py):
  // { candidates: [snake_case ledger rows with a `downloaded` flag], downloaded_count }.
  const listAssets = async (): Promise<{ rows: Array<Record<string, unknown>>; approvedCount: number }> => {
    const res = (await bridge.request('assets.list', { project_path: projectPath })) as {
      candidates?: Array<Record<string, unknown>>
      downloaded_count?: number
    }
    const rows = Array.isArray(res.candidates) ? res.candidates : []
    return {
      rows,
      approvedCount: rows.filter((a) => String(a.rights_status ?? '') === 'approved').length
    }
  }

  // Claim ids are CLM-NNNN in the ledger, but models often drop the hyphen or
  // change case (CLM0001). Canonicalize whatever resolves; anything else comes
  // back as an error listing the valid ids so the model self-corrects in one
  // turn instead of guessing again.
  const claimResolver = (valid: Set<string>) => {
    const byDigits = new Map<string, string>()
    for (const id of valid) {
      const m = id.trim().match(/^CLM-?0*(\d+)$/i)
      if (m) byDigits.set(m[1], id)
    }
    const canonical = (raw: string): string | null => {
      const t = raw.trim()
      if (valid.has(t)) return t
      const m = t.match(/^CLM[-_ ]?0*(\d+)$/i)
      return m ? (byDigits.get(m[1]) ?? null) : null
    }
    return {
      canonical,
      // rewrite parenthesized claim refs in prose to their canonical ledger ids
      rewriteRefs: (text: string): string =>
        text.replace(/\(([^()]*)\)/g, (paren, inner: string) =>
          /CLM[-_ ]?\d/i.test(inner) ? `(${inner.replace(/CLM[-_ ]?\d+/gi, (s) => canonical(s) ?? s)})` : paren
        ),
      unknownError: (context: string, unknown: Array<string>): Error =>
        new Error(
          `${context}: unknown claim ids ${[...new Set(unknown)].join(', ')} — valid claim ids: ${
            [...valid].sort().join(', ') || '(the evidence ledger has no claims — write the scenes without claim references)'
          }`
        )
    }
  }

  return {
    state_digest: async () => {
      const digest = (await bridge.request('ledger.digest', { project_path: projectPath })) as Record<string, unknown>
      const assets = await listAssets()
      return {
        ...(digest && typeof digest === 'object' ? digest : {}),
        downloaded_count: assets.rows.filter((a) => a.downloaded === true).length,
        rights_approved_count: assets.approvedCount,
        // Only DOWNLOADED assets can appear in shots (validate_project enforces
        // the files exist); shots_write additionally requires the human rights
        // gate (rights_status 'approved').
        usable_assets: assets.rows
          .filter((a) => a.downloaded === true && typeof a.saved_path === 'string' && a.saved_path)
          .map((a) => ({
            asset_id: a.asset_id,
            saved_path: a.saved_path,
            media_type: a.media_type,
            title: a.title,
            license: a.license,
            date: a.date,
            rights_status: a.rights_status
          })),
        ...(assets.approvedCount === 0
          ? {
              rights_note:
                'no asset is rights-approved yet (discovery is not clearance — approval is the user\'s click in the Asset Library). Design scene visuals from compositions (kind=composition cards/graphics); do NOT reference unapproved assets — shots_write rejects them. Name the approval step in your finish summary.'
            }
          : {})
      }
    },

    bible_write: async (args) => {
      const scenesIn = Array.isArray(args.scenes) ? (args.scenes as Array<Record<string, unknown>>) : []
      if (scenesIn.length < 2) throw new Error('a documentary needs at least 2 scenes')
      const { canonical, unknownError } = claimResolver(await claimIds())
      let clock = 0
      const scenes: BibleInput['scenes'] = []
      const beats: BeatInput[] = []
      for (const raw of scenesIn) {
        const id = String(raw.id ?? '')
        if (!/^S\d+$/.test(id)) throw new Error(`scene id must be S01-style, got ${id}`)
        const dur = Math.max(3, Number(raw.duration_target_s ?? 20))
        const b = (raw.beat ?? {}) as Record<string, unknown>
        const beatId = String(b.id ?? `B${String(beats.length + 1).padStart(2, '0')}`)
        const beat: BeatInput = {
          id: beatId,
          scene: id,
          label: String(raw.label ?? id),
          startS: clock,
          durS: dur,
          curiosity: Math.min(1, Math.max(0, Number(b.curiosity ?? 0.5))),
          tension: Math.min(1, Math.max(0, Number(b.tension ?? 0.3))),
          rehook: b.rehook === true,
          patternInterrupt: b.pattern_interrupt ? String(b.pattern_interrupt) : null,
          opensLoop: b.opens_loop ? String(b.opens_loop) : null,
          closesLoop: b.closes_loop ? String(b.closes_loop) : null,
          music: String(b.music ?? ''),
          sfx: Array.isArray(b.sfx) ? b.sfx.map(String) : []
        }
        beats.push(beat)
        const claimsIn = Array.isArray(raw.claims) ? raw.claims.map(String) : []
        const unknownClaims = claimsIn.filter((c) => !canonical(c))
        if (unknownClaims.length) throw unknownError(`scene ${id}`, unknownClaims)
        const claims = claimsIn.map((c) => canonical(c) as string)
        const assetIds = Array.isArray(raw.asset_ids) ? raw.asset_ids.map(String) : []
        scenes.push({
          id,
          label: String(raw.label ?? ''),
          title: String(raw.title ?? ''),
          shows: String(raw.shows ?? ''),
          feels: String(raw.feels ?? ''),
          motion: String(raw.motion ?? ''),
          look: raw.look ? String(raw.look).slice(0, 160) : null,
          onScreenText: String(raw.on_screen_text ?? ''),
          durationTargetS: dur,
          claims,
          assetIds
        })
        clock += dur
      }
      const bible: BibleInput = {
        title: String(args.title ?? 'Untitled Documentary'),
        thesis: String(args.thesis ?? ''),
        targetRuntimeSeconds: clock,
        runtimeDecision: args.runtime_decision ? String(args.runtime_decision).slice(0, 300) : null,
        stylePreset: String(args.style_preset ?? 'vox-explainer'),
        emotionalPromise: String(args.emotional_promise ?? ''),
        arc: String(args.arc ?? ''),
        scenes
      }
      const biblePath = writeBible(projectPath, bible)
      const beatsPath = writeBeats(projectPath, beats)
      return {
        written: [biblePath, beatsPath],
        scenes: scenes.length,
        total_runtime_s: clock,
        beat_ids: beats.map((b) => b.id)
      }
    },

    script_write: async (args) => {
      const sectionsIn = Array.isArray(args.sections) ? (args.sections as Array<Record<string, unknown>>) : []
      if (!sectionsIn.length) {
        throw new Error(
          args._raw != null
            ? "script_write could not parse the tool-call arguments (the call was likely truncated — a whole film script may not fit one completion). Send FEWER sections per call: write part of the script now, then call script_write again with mode:'append' and the rest."
            : 'at least one section is required'
        )
      }
      // mode:'append' merges this call's sections into the script so far (same
      // id overwrites, new id is added, everything else is kept) so a weak
      // model can author a 15-minute script across several calls instead of
      // losing its whole draft to the budget gate every turn (2026-11-19).
      const appendMode = args.mode === 'append'
      const { canonical, rewriteRefs, unknownError } = claimResolver(await claimIds())
      const sections: ScriptInput['sections'] = []
      for (const raw of sectionsIn) {
        const bodyRaw = String(raw.body ?? '').trim()
        if (!bodyRaw) throw new Error('script section body is empty')
        // Dangling refs like "CLM-" (no number) are NOT valid claim refs — they
        // used to slip through validation vacuously and ship an evidence-free
        // film (2026-11-15 stock-market project). Reject them explicitly.
        const malformed = (bodyRaw.match(/CLM(?![-_ ]?\d)/gi) ?? []).length
        if (malformed > 0) {
          throw new Error(
            `script_write rejected: section '${raw.id}' contains ${malformed} malformed claim ref(s) — bare 'CLM' with no number. Cite ledger ids exactly as (CLM-0001) from state_digest.`
          )
        }
        // claim refs are parenthesized; accept (CLM-0001) and (CLM0001) spellings
        const refs = Array.from(bodyRaw.matchAll(/\(([^()]*)\)/g)).flatMap((m) =>
          Array.from(m[1].matchAll(/CLM[-_ ]?\d{1,6}/gi)).map((x) => x[0])
        )
        const unknown = refs.filter((r) => !canonical(r))
        if (unknown.length > 0) throw unknownError(`section '${raw.id}'`, unknown)
        const body = rewriteRefs(bodyRaw)
        sections.push({
          id: String(raw.id ?? `section${sections.length + 1}`),
          title: String(raw.title ?? ''),
          voice: raw.voice ? String(raw.voice) : undefined,
          pace: raw.pace ? Number(raw.pace) : undefined,
          energy: raw.energy ? String(raw.energy) : undefined,
          body
        })
      }
      const base = appendMode ? (scriptAccumulated ?? readScriptSections(projectPath)) : []
      const byId = new Map(base.map((s) => [s.id, s]))
      for (const s of sections) byId.set(s.id, s)
      const baseIds = base.map((s) => s.id)
      const addedIds = sections.map((s) => s.id).filter((id) => !baseIds.includes(id))
      const merged: ScriptInput['sections'] = [...baseIds, ...addedIds].map((id) => byId.get(id)!)
      // Remember the script so far even when this call is rejected below — a
      // budget rejection must not throw the model's draft away; the next
      // append call continues from exactly these sections.
      scriptAccumulated = merged
      // word count + claim refs over the MERGED script (kept sections were
      // canonicalized when they were first accepted)
      let totalWords = 0
      let totalRefs = 0
      for (const s of merged) {
        totalWords += s.body.split(/\s+/).length
        totalRefs += Array.from(s.body.matchAll(/\(([^()]*)\)/g)).flatMap((m) =>
          Array.from(m[1].matchAll(/CLM[-_ ]?\d{1,6}/gi))
        ).length
      }
      // R8 (evidence-led): a script with ZERO claim refs is not a documentary —
      // it is the exact failure the 2026-11-15 empty-ledger run shipped.
      if (totalRefs === 0) {
        throw new Error(
          'script_write rejected: the script carries NO evidence-ledger claim refs — every documentary must cite its ledger (PRD R8). Cite claims as (CLM-0001) from state_digest; if the digest showed no claims, STOP and tell the user to re-run /research before designing.'
        )
      }
      // ≈155 wpm spoken pace
      const estSeconds = Math.round((totalWords / 155) * 60)
      // The user's Minutes is a hard budget (project.yml target_runtime_seconds).
      // The film is as long as its narration, so a short script silently shipped
      // a 2–4 minute film from a 15-minute request (2026-11-19): the prompt asked
      // for the budget but nothing checked it. Reject a script that cannot fill
      // the target and tell the Director exactly how many words are missing —
      // with the per-section math and the append path, since a model that keeps
      // rewriting the same draft never gets there on its own.
      const targetS = targetRuntimeSeconds ?? null
      let acceptedUnderBudget = false
      if (targetS != null) {
        const wordsFor = (seconds: number): number => Math.ceil((seconds / 60) * 155)
        const minS = Math.round(targetS * 0.9)
        const minutes = Math.round(targetS / 60)
        if (estSeconds < minS) {
          // Loop-breaker: after three under-budget rejections, accept a script
          // that fills ≥75% of the budget with a loud warning — a coherent
          // shorter film beats no film at all (2026-11-19 dogfood: the model
          // rewrote the same ~1,730-word script until the turn limit and the
          // run shipped nothing).
          if (scriptBudgetRejections >= 3 && estSeconds >= Math.round(targetS * 0.75)) {
            acceptedUnderBudget = true
          } else {
            scriptBudgetRejections++
            const scale = Math.max(1, merged.length)
            const avg = Math.max(1, Math.round(totalWords / scale))
            const needAvg = Math.max(1, Math.ceil(wordsFor(minS) / scale))
            const pct = Math.max(1, Math.round((estSeconds / Math.max(1, targetS)) * 100))
            const how = appendMode
              ? `This append call merged ${sections.length} section(s) — the script so far now has ${merged.length} sections averaging ~${avg} words each. Keep appending: call script_write again with mode:'append' and ONLY the sections to deepen or add (full new text per section; same id overwrites, the rest are kept).`
              : `Your ${merged.length} sections average ~${avg} words — you need ~${needAvg}+ words per section. Call script_write again with mode:'append' and ONLY the sections to deepen or add (full new text per section; same id overwrites, the rest are kept) — the script written so far is kept across calls. Or resend the whole script longer.`
            throw new Error(
              `script_write rejected: the script so far is ${totalWords} words ≈ ${estSeconds}s, but the user set a ${minutes}-minute film (${targetS}s) — that is ${pct}% of the budget. Aim for ~${wordsFor(targetS)} words (at least ${wordsFor(minS)} ≈ ${minS}s). ${how} Deepen each section with evidence from the ledger (more claims, more of the story) — never pad with filler.`
            )
          }
        } else if (estSeconds > targetS * 1.1) {
          throw new Error(
            `script_write rejected: the script is ${totalWords} words ≈ ${estSeconds}s, over the ${minutes}-minute budget (${targetS}s). Cut it to ~${wordsFor(targetS)} words (at most ${wordsFor(Math.round(targetS * 1.1))}) — resend the whole script shorter (mode:'replace'; append cannot remove sections).`
          )
        }
      }
      // Budget satisfied, no target set, or the loop-breaker accepted a 75%+
      // script: persist it (the accumulator was already updated above).
      const rejectionsBeforeAccept = scriptBudgetRejections
      scriptBudgetRejections = 0
      const script: ScriptInput = { voice, sections: merged }
      const path = writeScript(projectPath, script)
      // Coherence warning: a workflow authored against the PREVIOUS script may
      // now reference section ids this rewrite dropped or renamed — producing
      // before workflow_write would stop at the producer's section check.
      const writtenIds = new Set(merged.map((s) => s.id))
      const brokenSections = [
        ...new Set(
          (readWorkflowScenes(projectPath) ?? [])
            .map((s) => String(s.vo?.script_section ?? ''))
            .filter((id) => id && !writtenIds.has(id))
        )
      ]
      const warnings: string[] = []
      if (acceptedUnderBudget && targetS != null) {
        warnings.push(
          `accepted at ${estSeconds}s of the ${targetS}s budget after ${rejectionsBeforeAccept} under-budget attempts — the film will run shorter than the user asked; keep deepening sections (script_write mode:'append') or lower the Minutes setting.`
        )
        deps.emit({
          type: 'message',
          summary: `script accepted under budget: ~${estSeconds}s of the ${targetS}s requested after ${rejectionsBeforeAccept} attempts — the film will run shorter than asked`,
          at: new Date().toISOString()
        })
      }
      if (brokenSections.length > 0) {
        warnings.push(
          `workflow.json still references script section(s) ${brokenSections.join(', ')} that this script no longer defines — call workflow_write for the new script before finishing, or produce will fail its section check.`
        )
      }
      return {
        written: [path],
        sections: merged.length,
        words: totalWords,
        estimated_speak_seconds: estSeconds,
        ...(acceptedUnderBudget ? { accepted_under_budget: true } : {}),
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {})
      }
    },

    shots_write: async (args) => {
      const rowsIn = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : []
      // pre-validate asset existence + rights approval before the bridge does its pass
      const assets = await listAssets()
      if (!rowsIn.length) {
        // Human rights gate: with zero approved assets nothing legal can go on
        // the timeline — write the header-only shot list and let the film
        // proceed on compositions; approved assets fill it in at a later revision.
        if (assets.approvedCount > 0) {
          throw new Error('at least one shot row is required — the digest lists rights-approved assets to use')
        }
        const res = (await bridge.request('dwk.write_shot_list', { project_path: projectPath, rows: [] })) as { count: number }
        return {
          written: ['production/shot_list.csv'],
          shots: res.count,
          frames_end: 0,
          note: 'shot list left empty: no asset is rights-approved yet (human review). Build every scene visual from compositions; the user can approve assets in the Asset Library, then a revision fills the shot list.'
        }
      }
      const byPath = new Map<string, Record<string, unknown>>()
      for (const a of assets.rows) {
        if (typeof a.saved_path === 'string' && a.saved_path) byPath.set(String(a.saved_path).replace(/\\/g, '/'), a)
      }
      for (const [i, row] of rowsIn.entries()) {
        const p = String(row.asset_path ?? '').replace(/\\/g, '/')
        if (!p) throw new Error(`shot row ${i + 1}: asset_path is required`)
        if (!existsSync(resolve(projectPath, p))) throw new Error(`shot row ${i + 1}: asset file does not exist: ${p}`)
        const asset = byPath.get(p)
        if (!asset) throw new Error(`shot row ${i + 1}: ${p} is not a downloaded asset from the ledger`)
        if (String(asset.rights_status ?? '') !== 'approved') {
          throw new Error(
            `shot row ${i + 1}: asset ${p} is not rights-approved (status: ${String(asset.rights_status ?? '') || 'review'}) — the user approves assets in the Asset Library`
          )
        }
      }
      const res = (await bridge.request('dwk.write_shot_list', { project_path: projectPath, rows: rowsIn })) as { count: number }
      return { written: ['production/shot_list.csv'], shots: res.count, frames_end: rowsIn.length ? Number(rowsIn[rowsIn.length - 1].end_frame) : 0 }
    },

    workflow_write: async (args) => {
      const beatsFile = join(projectPath, 'production', 'beats.json')
      if (!existsSync(beatsFile)) throw new Error('write the bible first (beats.json missing)')
      const beatsData = JSON.parse(readFileSync(beatsFile, 'utf-8')) as { beats?: Array<{ id?: string }> }
      const beatIds = new Set((beatsData.beats ?? []).map((b) => String(b.id ?? '')))
      const { canonical, unknownError } = claimResolver(await claimIds())
      const scriptFile = join(projectPath, 'production', 'script.md')
      const scriptRaw = existsSync(scriptFile) ? readFileSync(scriptFile, 'utf-8') : ''
      const sectionIds = new Set(Array.from(scriptRaw.matchAll(/^## \[([A-Za-z0-9_-]+)\]/gm)).map((m) => m[1]))
      const scenesIn = Array.isArray(args.scenes) ? (args.scenes as Array<Record<string, unknown>>) : []
      if (!scenesIn.length) throw new Error('at least one scene is required')
      // Duo panels are new media references; validate them like shots_write does
      // (present on disk + downloaded + rights-approved).
      const approvedAssets = await listAssets()
      const approvedByPath = new Map<string, Record<string, unknown>>()
      for (const a of approvedAssets.rows) {
        if (typeof a.saved_path === 'string' && a.saved_path) {
          approvedByPath.set(String(a.saved_path).replace(/\\/g, '/'), a)
        }
      }
      let totalClaims = 0
      const out: WorkflowSceneInput[] = []
      for (const raw of scenesIn) {
        const id = String(raw.id ?? '')
        const sceneBeats = Array.isArray(raw.beats) ? raw.beats.map(String) : []
        const badBeats = sceneBeats.filter((b) => !beatIds.has(b))
        if (badBeats.length) {
          throw new Error(
            `scene ${id}: unknown beat ids ${badBeats.join(', ')} — valid beat ids: ${[...beatIds].filter(Boolean).sort().join(', ')}`
          )
        }
        // Scenes map 1:1 to script sections. A model that omits the field but
        // uses S01-style scene ids (the common case) clearly means the matching
        // section — infer it rather than burning turns on a formatting slip
        // (2026-11-18 marvel dogfood: repeated `vo_script_section ''`).
        let voSection = String(raw.vo_script_section ?? '')
        if (!sectionIds.has(voSection) && sectionIds.has(id)) voSection = id
        if (!sectionIds.has(voSection)) {
          throw new Error(
            `scene ${id}: vo_script_section '${voSection}' is not a script section — valid section ids: ${
              [...sectionIds].sort().join(', ') || '(no script written yet)'
            }`
          )
        }
        const claimsIn = Array.isArray(raw.claims) ? raw.claims.map(String) : []
        const unknownClaims = claimsIn.filter((c) => !canonical(c))
        if (unknownClaims.length) throw unknownError(`scene ${id}`, unknownClaims)
        const claims = claimsIn.map((c) => canonical(c) as string)
        totalClaims += claims.length
        const shotsIn = Array.isArray(raw.shots) ? (raw.shots as Array<Record<string, unknown>>) : []
        const shots: WorkflowShotInput[] = shotsIn.map((s, si) => {
          const template = s.template ? String(s.template) : undefined
          const data = parseDataCard(s)
          const items = Array.isArray(s.items) && s.items.length > 0 ? s.items.map(String) : undefined
          const text = s.text ? String(s.text) : undefined
          const panels = parseDuoPanels(id, si, s.panels)
          const duo = templateKind(template) === 'duo'
          if (duo) {
            if (!panels) {
              throw new Error(
                `scene ${id} shot ${si + 1}: template 'duo' needs panels[2] — two boxes (image + text) side by side. Author two panels with asset_path and/or title/note, or use a normal card template.`
              )
            }
            const seenPaths = new Set<string>()
            for (const [pi, panel] of panels.entries()) {
              if (!panel.assetPath) continue
              if (seenPaths.has(panel.assetPath)) {
                throw new Error(`scene ${id} shot ${si + 1}: panel ${pi + 1} reuses the same asset as the other panel — a duo compares two distinct evidence items`)
              }
              seenPaths.add(panel.assetPath)
              if (!existsSync(resolve(projectPath, panel.assetPath))) {
                throw new Error(`scene ${id} shot ${si + 1} panel ${pi + 1}: asset file does not exist: ${panel.assetPath}`)
              }
              const asset = approvedByPath.get(panel.assetPath)
              if (!asset) {
                throw new Error(`scene ${id} shot ${si + 1} panel ${pi + 1}: ${panel.assetPath} is not a downloaded asset from the ledger`)
              }
              if (String(asset.rights_status ?? '') !== 'approved') {
                throw new Error(
                  `scene ${id} shot ${si + 1} panel ${pi + 1}: ${panel.assetPath} is not rights-approved (status: ${String(asset.rights_status ?? '') || 'review'}) — use a card or ask the user to approve the asset`
                )
              }
            }
          } else if (panels) {
            throw new Error(
              `scene ${id} shot ${si + 1}: panels are only valid on template 'duo' (got '${template ?? 'title-card'}') — set template: "duo" or remove panels`
            )
          }
          // Visual direction: motion is a real grammar — an unknown value would
          // silently fall back to kenburns in the engine, so reject it here and
          // let the Director loop self-correct with the valid vocabulary.
          const motion = s.motion ? String(s.motion).toLowerCase() : undefined
          if (motion && !isVisualMotion(motion)) {
            throw new Error(
              `scene ${id}: shot motion '${motion}' is invalid — valid motions: ${VISUAL_MOTIONS.join(', ')} (push-in on reveals, still on solemn evidence, pan to travel across scale)`
            )
          }
          // Data-card shells with no content rendered as EMPTY frames in the
          // 2026-11-15 stock-market film (kicker-only holds for 10s each) —
          // a data-* shot MUST carry its payload or a caption.
          const isDataTemplate = /^data-(stat|bars|list|line|timeline|map)$/i.test(template ?? '') || /^(article|clipping)/i.test(template ?? '')
          if (isDataTemplate) {
            const hasPayload =
              Boolean(data && data.items.length > 0) ||
              Boolean(data && data.labels?.length && data.series?.length) ||
              Boolean(data && data.events?.length) ||
              Boolean(data && data.markers?.length) ||
              Boolean(data && (String(data.headline ?? '').trim() || String(data.quote ?? '').trim())) ||
              Boolean(items?.length) ||
              Boolean(text && text.trim())
            if (!hasPayload) {
              throw new Error(
                `scene ${id}: shot '${template}' has NO content — data-stat needs data:{label,value,note?}; data-bars/list need data.items; data-line needs labels+series; data-timeline needs events; data-map needs markers; article needs headline/quote; or at least a caption in text. Empty cards render as blank frames.`
              )
            }
          }
          return {
            kind: String(s.kind ?? 'asset') as 'asset' | 'composition',
            assetPath: s.asset_path ? String(s.asset_path) : undefined,
            motion,
            zoom: s.zoom ? Number(s.zoom) : undefined,
            // In-point into a video source. The video-moment pass overwrites
            // this with a frame-checked choice when it runs.
            ...(Number.isFinite(Number(s.source_in)) && Number(s.source_in) > 0 ? { sourceIn: Number(s.source_in) } : {}),
            template,
            text,
            cue: s.narration_cue ? String(s.narration_cue) : s.cue ? String(s.cue) : undefined,
            data,
            items,
            ...(panels ? { panels } : {}),
            durS: Number(s.dur_s ?? 4)
          }
        })
        // Visual direction: per-scene look, validated against the engine vocabulary.
        const visual = parseSceneVisual(id, raw)
        // Transitions are authored only when the Director chose them; unauthored
        // scenes inherit the film transition_set (style.json) at produce time.
        const transitionInRaw = raw.transition_in ? String(raw.transition_in).toLowerCase() : ''
        const transitionOutRaw = raw.transition_out ? String(raw.transition_out).toLowerCase() : ''
        for (const [label, value] of [['transition_in', transitionInRaw], ['transition_out', transitionOutRaw]] as const) {
          if (value && !isVisualTransition(value)) {
            throw new Error(`scene ${id}: ${label} '${value}' is invalid — valid transitions: ${VISUAL_TRANSITIONS.join(', ')}`)
          }
        }
        out.push({
          id,
          beats: sceneBeats,
          vo: { scriptSection: voSection, voice },
          shots,
          visual,
          ...(transitionInRaw || transitionOutRaw
            ? { transitionIn: transitionInRaw || undefined, transitionOut: transitionOutRaw || undefined }
            : {}),
          sfx: Array.isArray(raw.sfx) ? raw.sfx.map(String) : [],
          claims
        })
      }
      // R8: an executable plan that cites no evidence is not a documentary —
      // the 2026-11-15 empty-ledger run produced exactly this. Reject here so
      // the Director loop self-corrects instead of finishing invalid.
      if (totalClaims === 0) {
        throw new Error(
          'workflow_write rejected: no scene carries an evidence claim — map scenes to ledger claim ids (CLM-0001 form) from state_digest. If the digest showed no claims, STOP and tell the user to re-run /research before designing.'
        )
      }
      const wf: WorkflowInput = {
        resolution: [1920, 1080],
        fps: 30,
        quality: (String(args.quality ?? 'standard') as 'draft' | 'standard' | 'high'),
        scenes: out,
        music: null
      }
      const path = writeWorkflow(projectPath, wf)
      return { written: [path], scenes: out.length }
    },

    style_write: async (args) => {
      // Merge over any existing style.json so keys the Director doesn't set
      // (e.g. a user-chosen preset) keep their current value.
      const out: ProjectStyleInput = {}
      try {
        const prev = JSON.parse(readFileSync(join(projectPath, 'studio', 'style.json'), 'utf-8')) as ProjectStyleInput
        if (prev && typeof prev === 'object') Object.assign(out, prev)
      } catch {
        // no previous style — the Director defines the identity from scratch
      }
      if (args.accent !== undefined && args.accent !== null && String(args.accent) !== '') {
        const accent = String(args.accent).toLowerCase()
        if (!/^#[0-9a-f]{6}$/.test(accent)) throw new Error('style_write: accent must be #rrggbb (e.g. #b3542f)')
        out.accent = accent
      }
      if (args.caption_style !== undefined && args.caption_style !== null && String(args.caption_style) !== '') {
        const cs = String(args.caption_style)
        if (cs !== 'kinetic' && cs !== 'boxed' && cs !== 'off') {
          throw new Error(`style_write: caption_style must be kinetic|boxed|off, got '${cs}'`)
        }
        out.caption_style = cs
      }
      if (args.vignette !== undefined && args.vignette !== null) out.vignette = args.vignette === true
      if (args.grain !== undefined && args.grain !== null) out.grain = args.grain === true
      if (args.transition_set !== undefined && args.transition_set !== null && String(args.transition_set) !== '') {
        const ts = String(args.transition_set).toLowerCase()
        if (!(TRANSITION_SETS as readonly string[]).includes(ts)) {
          throw new Error(`style_write: transition_set must be one of ${TRANSITION_SETS.join(', ')}, got '${ts}'`)
        }
        out.transition_set = ts
      }
      if (args.look !== undefined && args.look !== null && String(args.look) !== '') {
        out.look = String(args.look).slice(0, 200)
      }
      const path = writeStyle(projectPath, out)
      return { written: [path], look: out.look ?? '', accent: out.accent ?? '', transition_set: out.transition_set ?? '' }
    },

    finish: async (args) => ({ done: true, summary: String(args.summary ?? 'Direction complete.') }),

    retention_review: async () => {
      // Deterministic retention rubric (AGENT-SPEC §8, roadmap M4): the model
      // cannot argue with arithmetic — findings name the exact scene.
      const read = (rel: string): string => {
        try {
          return readFileSync(join(projectPath, rel), 'utf-8')
        } catch {
          return ''
        }
      }
      const bibleRaw = read('production/bible.md')
      const beatsData = JSON.parse(read('production/beats.json') || '{"beats":[]}') as {
        beats?: Array<{ id?: string; scene?: string; startS?: number; rehook?: boolean; label?: string; opensLoop?: string | null; closesLoop?: string | null }>
      }
      const beats = beatsData.beats ?? []
      const wfData = JSON.parse(read('studio/workflow.json') || '{"scenes":[]}') as {
        scenes?: Array<{ id?: string; shots?: Array<{ dur_s?: number; template?: string }>; vo?: { script_section?: string }; visual?: { mood?: string; layout?: string; accent?: string } }>
      }
      const scenes = wfData.scenes ?? []
      const scriptRaw = read('production/script.md')
      const speakS = (sectionId: string): number => {
        const body = scriptRaw.split(`## [${sectionId}]`)[1]?.split('## [')[0] ?? ''
        const words = body.replace(/\([^()]*CLM[^()]*\)/gi, '').trim().split(/\s+/).filter(Boolean).length
        return (words / 155) * 60 // ≈155 wpm
      }
      const findings: Array<{ severity: 'block' | 'advisory'; scene?: string; note: string }> = []

      const totalRuntime = scenes.reduce((acc, s) => {
        const sec = s.id ?? ''
        const m = bibleRaw.match(new RegExp(`### ${sec}[^]*?duration_target_s: (\\d+)`))
        return acc + (m ? Number(m[1]) : speakS(sec))
      }, 0)

      // Re-hook coverage: long films must re-hook, and never gap too long.
      const rehookBeats = beats.filter((b) => b.rehook === true).sort((a, b) => (a.startS ?? 0) - (b.startS ?? 0))
      if (totalRuntime > 120 && rehookBeats.length === 0) {
        findings.push({ severity: 'block', note: 'film is over 2 minutes but no beat is marked rehook — mark at least one beat rehook in the bible' })
      }
      let prev = 0
      for (const rb of rehookBeats) {
        const gap = (rb.startS ?? 0) - prev
        if (gap > 180) {
          findings.push({ severity: 'block', scene: rb.scene, note: `${Math.round(gap)}s without a re-hook before beat ${rb.id ?? '?'} — add a re-hook mid-way` })
        }
        prev = rb.startS ?? 0
      }
      if (totalRuntime - prev > 180) {
        findings.push({ severity: 'block', note: `last ${Math.round(totalRuntime - prev)}s have no re-hook — the tail will drift` })
      }

      // Scene duration vs spoken narration → estimated dead zones.
      for (const s of scenes) {
        const id = s.id ?? ''
        const m = bibleRaw.match(new RegExp(`### ${id}[^]*?duration_target_s: (\\d+)`))
        const sceneDur = m ? Number(m[1]) : 0
        const spoken = speakS(s.vo?.script_section ?? id)
        if (sceneDur > 0 && sceneDur - spoken > 10) {
          findings.push({
            severity: 'block',
            scene: id,
            note: `scene ${id} runs ${sceneDur}s but narration is only ~${Math.round(spoken)}s — ~${Math.round(sceneDur - spoken)}s estimated dead zone; add shots/composition beats or trim the scene`
          })
        }
      }

      // Cadence: mean shot length across the film.
      const shotCount = scenes.reduce((acc, s) => acc + (s.shots?.length ?? 0), 0)
      if (shotCount > 0 && totalRuntime / shotCount > 12) {
        findings.push({
          severity: 'advisory',
          note: `mean shot ≈ ${Math.round(totalRuntime / shotCount)}s — audiences drift past ~12s without a cut; add B-roll or split shots`
        })
      }
      if (shotCount === 0) {
        findings.push({ severity: 'advisory', note: 'no shots anywhere — the film is all cards; request asset approvals to enrich it' })
      }

      // Visual monotony (visual direction pass): a film where every scene
      // carries the same mood+layout reads as one long slide regardless of
      // the palette. Advisory — variety is the Director's craft call.
      const visualSig = (s: { visual?: { mood?: string; layout?: string } }): string =>
        `${s.visual?.mood ?? 'neutral'}|${s.visual?.layout ?? 'standard'}`
      const visualScenes = scenes.filter((s) => s.visual && (s.visual.mood || s.visual.layout))
      if (scenes.length >= 4 && visualScenes.length === scenes.length) {
        const sigs = new Set(scenes.map(visualSig))
        if (sigs.size === 1) {
          findings.push({
            severity: 'advisory',
            note: `all ${scenes.length} scenes share one look (${[...sigs][0].replace('|', ' + ')}) — shift mood or layout at the act break so the film has a visual arc`
          })
        }
      }

      // Hook: target length + must open on evidence, not a title card
      // (research §6.1 — the hook earns the title; craft config hook_seconds).
      const hookSeconds = Math.max(5, Number(read('project.yml').match(/retention:[\s\S]*?hook_seconds:\s*(\d+)/)?.[1] ?? 15))
      const firstScene = bibleRaw.match(/### S01[^]*?duration_target_s: (\d+)/)
      if (firstScene && Number(firstScene[1]) > hookSeconds) {
        findings.push({
          severity: 'advisory',
          scene: 'S01',
          note: `hook runs ${firstScene[1]}s — target ≤${hookSeconds}s: front-load the payoff promise`
        })
      }
      const hookShots = scenes.find((s) => (s.id ?? '') === 'S01')?.shots ?? []
      // A title-card hook = every hook shot is a card AND reads as a title/end
      // card (data cards are legitimate hook visuals — a stat IS a claim).
      const isTitleCard = (sh: { asset?: string; template?: string }): boolean =>
        !sh.asset && (!sh.template || /title|end/i.test(String(sh.template)))
      const hookAllCards = hookShots.length === 0 || hookShots.every(isTitleCard)
      if (hookAllCards) {
        findings.push({
          severity: 'advisory',
          scene: 'S01',
          note: 'the hook opens on a title card — open on visual evidence or a proven claim instead; the hook earns the title'
        })
      }

      // Open-loop bookkeeping (research §6.3): loops must hand off, not die.
      const hasLoopText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0
      const opensLoop = beats.some((b) => hasLoopText(b.opensLoop))
      if (totalRuntime > 120 && !opensLoop) {
        findings.push({
          severity: 'advisory',
          note: 'no beat documents an open loop — every scene should raise a question before resolving the prior one (bible beats: opens_loop)'
        })
      } else if (opensLoop) {
        for (const b of beats) {
          if (!hasLoopText(b.closesLoop) || hasLoopText(b.opensLoop)) continue
          const laterOpens = beats
            .slice(beats.indexOf(b) + 1)
            .some((x) => hasLoopText(x.opensLoop))
          if (!laterOpens) {
            findings.push({
              severity: 'advisory',
              scene: b.scene,
              note: `loop ledger goes dead after beat ${b.id ?? '?'} — open a smaller loop before closing one`
            })
            break
          }
        }
      }

      const blocking = findings.filter((f) => f.severity === 'block')
      return {
        verdict: blocking.length > 0 ? 'fix' : 'pass',
        findings,
        summary:
          blocking.length > 0
            ? `${blocking.length} blocking retention finding(s) — revise the named scenes and re-run retention_review before finish.`
            : `retention review PASS${findings.length ? ` (${findings.length} advisory)` : ''}.`
      }
    }
  }
}
