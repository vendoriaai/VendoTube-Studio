/**
 * Design systems ("skins") — the structural half of the visual identity.
 *
 * Before this module, every preset was the same composition skeleton with a
 * swapped palette: one centered card, one rounded accent rule, one glass data
 * panel, one pill caption. Seven presets produced one look.
 *
 * A skin now changes the *design language*, not the paint: typography system
 * (display face, case, tracking, weight), panel geometry (square paper vs.
 * rounded glass), rule language (hairline vs. heavy bar vs. offset block),
 * media treatment (halftone vs. colour), furniture (index numerals, case
 * stamps, mastheads, letterbox), texture (kraft paper, newsprint, grid) and
 * caption treatment.
 *
 * Two references drive the two extremes:
 *  - `editorial` — Swiss/brutalist showreel: near-black canvas, cream paper
 *    panels, acid-yellow blocks, monospace micro-labels, hairline grid,
 *    hard offset shadows, square corners, oversized index numerals.
 *  - `case-file` — forensic opener: aged kraft paper, letterpress serif,
 *    taped and slightly rotated exhibits, redaction bars, heavy fibre grain.
 *
 * Everything emitted here is deterministic and offline (no webfont fetches).
 */
import { fitOneLine, measureText } from './fit'

export interface FontFaceSpec {
  family: string
  file: string
  /** CSS font-weight descriptor; variable fonts cover a range. */
  weight: string
  fontStyle: 'normal' | 'italic'
}

export type DesignKey =
  | 'editorial'
  | 'case-file'
  | 'newsprint'
  | 'noir'
  | 'vivid'
  | 'bright'
  | 'glass'

export const DESIGN_KEYS: DesignKey[] = ['editorial', 'case-file', 'newsprint', 'noir', 'vivid', 'bright', 'glass']

export const isDesignKey = (v: string): v is DesignKey => (DESIGN_KEYS as string[]).includes(v)

// ------------------------------------------------------------------ textures

const svg = (body: string): string => `data:image/svg+xml,${body}`

/** Fine photographic grain (unchanged from M4). */
export const GRAIN_SVG = svg(
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E"
)

/** Kraft / aged-paper fibre: fine directional strands (reads as paper stock). */
export const KRAFT_SVG = svg(
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='k'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.62' numOctaves='3' seed='23' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23k)' opacity='0.28'/%3E%3C/svg%3E"
)

/** Low-frequency mottling — the uneven tone of old stock, not clouds. */
export const MOTTLE_SVG = svg(
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='520' height='520'%3E%3Cfilter id='m'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.011' numOctaves='4' seed='41' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23m)' opacity='0.2'/%3E%3C/svg%3E"
)

/** Newspaper halftone dots for print-family media. */
export const HALFTONE_SVG = svg(
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='6'%3E%3Ccircle cx='3' cy='3' r='1.1' fill='%23000' opacity='0.5'/%3E%3C/svg%3E"
)

// ------------------------------------------------------------------- presets

/** Vendor a variable font family across the renderer — never a web fetch. */
const MONO: FontFaceSpec[] = [
  { family: 'JetBrains Mono', file: 'JetBrainsMono-var.woff2', weight: '100 800', fontStyle: 'normal' }
]
const ARCHIVO: FontFaceSpec[] = [
  { family: 'Archivo', file: 'Archivo-var.woff2', weight: '100 900', fontStyle: 'normal' }
]
const FRAUNCES: FontFaceSpec[] = [
  { family: 'Fraunces', file: 'Fraunces-900.woff2', weight: '100 900', fontStyle: 'normal' },
  { family: 'Fraunces', file: 'Fraunces-300i.woff2', weight: '100 900', fontStyle: 'italic' }
]
const GROTESK: FontFaceSpec[] = [
  { family: 'Space Grotesk', file: 'SpaceGrotesk-var.woff2', weight: '300 700', fontStyle: 'normal' }
]
const JAKARTA: FontFaceSpec[] = [
  { family: 'Plus Jakarta Sans', file: 'PlusJakartaSans-var.woff2', weight: '200 800', fontStyle: 'normal' }
]
const INTER: FontFaceSpec[] = [{ family: 'Inter', file: 'Inter-var.woff2', weight: '100 900', fontStyle: 'normal' }]

const uniq = (list: FontFaceSpec[]): FontFaceSpec[] =>
  list.filter((f, i) => list.findIndex((g) => g.family === f.family && g.fontStyle === f.fontStyle && g.file === f.file) === i)

export const FONT_SETS = {
  editorial: uniq([...ARCHIVO, ...MONO]),
  paper: uniq([...FRAUNCES, ...ARCHIVO, ...MONO]),
  print: uniq([...FRAUNCES, ...ARCHIVO, ...MONO]),
  noir: uniq([...JAKARTA, ...INTER, ...MONO]),
  vivid: uniq([...JAKARTA, ...INTER, ...MONO]),
  bright: uniq([...GROTESK, ...INTER, ...MONO]),
  glass: uniq([...JAKARTA, ...INTER, ...MONO])
}

/** Shared mono stack for micro-labels — the single strongest "system" tell. */
export const MONO_STACK = "'JetBrains Mono', 'Inter', monospace"

// --------------------------------------------------------------------- style

export interface StyleTokens {
  key: string
  /** The design language (layout skeleton, not just palette). */
  design: DesignKey
  bg: string
  bgDeep: string
  text: string
  textDim: string
  ink: string
  paper: string
  accent: string
  secondary: string
  alert: string
  fontHead: string
  fontBody: string
  /** Monospace stack for micro-labels, metadata and furniture. */
  mono: string
  headWeight: number
  /** Vendored @font-face specs — the renderer must never fetch fonts online. */
  fonts: FontFaceSpec[]
  /** Entrance easing signature. */
  ease: string
  glowHeadline: boolean
  grain: number
  /** Data-card panel fill + border (the "glass" the numbers sit on). */
  panel: string
  panelBorder: string
  /** Exhibit frame border (evidence screenshots) + its caption color. */
  exhibitBorder: string
  /** Caption treatment (style.json caption_style): kinetic word pops, boxed cues, or none. */
  captions: 'kinetic' | 'boxed' | 'off'
  /** Cinematic vignette overlay. */
  vignette: boolean
  /** Ambient accent layer: aurora bloom, paper accents, or none. */
  accents: 'aurora' | 'paper' | 'none'
}

// ------------------------------------------------------- metrics (type + box)
// The layout-fit pass (2026-11-16): the emitter must know the size the
// stylesheet will ACTUALLY apply before it can decide to shrink a string. These
// tables are that source of truth — designCss interpolates the same numbers, so
// the fitter and the CSS can never drift apart.

/** Nominal display sizes for one design system, in px of the 1920×1080 design space. */
export interface DesignType {
  headlineLg: number
  headlineMd: number
  headlineSm: number
  /** Unitless line-height used by the card headline. */
  headlineLine: number
  headlineTrackingEm: number
  /** CSS uppercases card headlines. */
  headlineCaps: boolean
  dataTitle: number
  dataTitleLine: number
  /** The giant figure in a stat card. */
  statValue: number
  /** Pull-quote fallback for a prose note inside a stat card. */
  statQuote: number
  statQuoteLine: number
  statLabel: number
  quoteText: number
  quoteLine: number
  cardNote: number
  /** Masthead brand line (editorial + newsprint furniture). */
  masthead: number
  mastheadTrackingEm: number
  mastheadCaps: boolean
}

export const DESIGN_TYPE: Record<DesignKey, DesignType> = {
  editorial: {
    headlineLg: 104,
    headlineMd: 78,
    headlineSm: 58,
    headlineLine: 0.9,
    headlineTrackingEm: -0.028,
    headlineCaps: true,
    dataTitle: 44,
    dataTitleLine: 0.95,
    statValue: 218,
    statQuote: 62,
    statQuoteLine: 1,
    statLabel: 22,
    quoteText: 62,
    quoteLine: 1,
    cardNote: 19,
    masthead: 15,
    mastheadTrackingEm: 0.34,
    mastheadCaps: true
  },
  'case-file': {
    headlineLg: 88,
    headlineMd: 68,
    headlineSm: 50,
    headlineLine: 1.02,
    headlineTrackingEm: -0.012,
    headlineCaps: false,
    dataTitle: 44,
    dataTitleLine: 1.05,
    statValue: 196,
    statQuote: 60,
    statQuoteLine: 1.25,
    statLabel: 22,
    quoteText: 60,
    quoteLine: 1.25,
    cardNote: 18,
    masthead: 16,
    mastheadTrackingEm: 0.26,
    mastheadCaps: true
  },
  newsprint: {
    headlineLg: 100,
    headlineMd: 74,
    headlineSm: 54,
    headlineLine: 0.98,
    headlineTrackingEm: -0.02,
    headlineCaps: false,
    dataTitle: 46,
    dataTitleLine: 1.02,
    statValue: 210,
    statQuote: 58,
    statQuoteLine: 1.22,
    statLabel: 22,
    quoteText: 62,
    quoteLine: 1.25,
    cardNote: 26,
    masthead: 20,
    mastheadTrackingEm: 0.02,
    mastheadCaps: true
  },
  noir: {
    headlineLg: 78,
    headlineMd: 60,
    headlineSm: 46,
    headlineLine: 1.14,
    headlineTrackingEm: 0.005,
    headlineCaps: false,
    dataTitle: 38,
    dataTitleLine: 1.1,
    statValue: 200,
    statQuote: 54,
    statQuoteLine: 1.25,
    statLabel: 20,
    quoteText: 62,
    quoteLine: 1.25,
    cardNote: 17,
    masthead: 12,
    mastheadTrackingEm: 0.3,
    mastheadCaps: true
  },
  vivid: {
    headlineLg: 98,
    headlineMd: 72,
    headlineSm: 54,
    headlineLine: 1.04,
    headlineTrackingEm: -0.028,
    headlineCaps: false,
    dataTitle: 46,
    dataTitleLine: 1.05,
    statValue: 214,
    statQuote: 58,
    statQuoteLine: 1.22,
    statLabel: 20,
    quoteText: 64,
    quoteLine: 1.25,
    cardNote: 28,
    masthead: 14,
    mastheadTrackingEm: 0.24,
    mastheadCaps: true
  },
  bright: {
    headlineLg: 90,
    headlineMd: 68,
    headlineSm: 52,
    headlineLine: 1.02,
    headlineTrackingEm: -0.034,
    headlineCaps: false,
    dataTitle: 42,
    dataTitleLine: 1.05,
    statValue: 200,
    statQuote: 56,
    statQuoteLine: 1.22,
    statLabel: 20,
    quoteText: 60,
    quoteLine: 1.22,
    cardNote: 18,
    masthead: 12,
    mastheadTrackingEm: 0.22,
    mastheadCaps: true
  },
  glass: {
    headlineLg: 92,
    headlineMd: 70,
    headlineSm: 54,
    headlineLine: 1.08,
    headlineTrackingEm: -0.02,
    headlineCaps: false,
    dataTitle: 46,
    dataTitleLine: 1.05,
    statValue: 190,
    statQuote: 58,
    statQuoteLine: 1.22,
    statLabel: 20,
    quoteText: 64,
    quoteLine: 1.25,
    cardNote: 28,
    masthead: 13,
    mastheadTrackingEm: 0.24,
    mastheadCaps: true
  }
}

export interface BoxMetrics {
  /** Panel width cap in the 1920 design space. */
  width: number
  /** Horizontal padding inside the panel. */
  padX: number
}

/** Card panel geometry per design (mirrors the CSS below). */
export const DESIGN_CARD_BOX: Record<DesignKey, BoxMetrics> = {
  editorial: { width: 1120, padX: 64 },
  'case-file': { width: 1120, padX: 70 },
  newsprint: { width: 1280, padX: 0 },
  noir: { width: 980, padX: 0 },
  vivid: { width: 1320, padX: 0 },
  bright: { width: 1240, padX: 0 },
  glass: { width: 1400, padX: 0 }
}

/** Data panel geometry per design. */
export const DESIGN_DATA_BOX: Record<DesignKey, BoxMetrics> = {
  editorial: { width: 1240, padX: 54 },
  'case-file': { width: 1120, padX: 58 },
  newsprint: { width: 1280, padX: 52 },
  noir: { width: 1300, padX: 52 },
  vivid: { width: 1300, padX: 62 },
  bright: { width: 1240, padX: 52 },
  glass: { width: 1300, padX: 62 }
}

/** Quote block width (the text itself, inside the card column). */
export const DESIGN_QUOTE_BOX: Record<DesignKey, BoxMetrics> = {
  editorial: { width: 1120, padX: 64 },
  'case-file': { width: 1120, padX: 70 },
  newsprint: { width: 1280, padX: 0 },
  noir: { width: 980, padX: 0 },
  vivid: { width: 1320, padX: 0 },
  bright: { width: 1240, padX: 0 },
  glass: { width: 1250, padX: 0 }
}

/** Duo (image + text pair) geometry per design: panel + text inset. */
export const DESIGN_DUO_BOX: Record<DesignKey, { width: number; gap: number; padX: number; textPad: number }> = {
  editorial: { width: 1560, gap: 26, padX: 0, textPad: 44 },
  'case-file': { width: 1420, gap: 34, padX: 0, textPad: 46 },
  newsprint: { width: 1500, gap: 30, padX: 0, textPad: 44 },
  noir: { width: 1380, gap: 26, padX: 0, textPad: 42 },
  vivid: { width: 1560, gap: 28, padX: 0, textPad: 48 },
  bright: { width: 1520, gap: 28, padX: 0, textPad: 46 },
  glass: { width: 1520, gap: 28, padX: 0, textPad: 46 }
}

/** Nominal headline size for a design + scene layout + tier. `centered` and
 *  `minimal` override every tier in the per-scene CSS, so the fitter must too. */
export function layoutHeadlinePx(design: DesignKey, layout: string, tier: 'lg' | 'md' | 'sm'): number {
  if (layout === 'centered') return 100
  if (layout === 'minimal') return 58
  const t = DESIGN_TYPE[design]
  return tier === 'lg' ? t.headlineLg : tier === 'md' ? t.headlineMd : t.headlineSm
}

// ------------------------------------------------------- fit boxes (2026-11-16)
// The emitter needs the ACTUAL text width of each box before it can fit copy.
// These helpers mirror the geometry in designCss (content box, so card padding
// stays outside the measured line) and the per-scene layout overrides.

/** Card headline / title content width, in design-space px. */
export function cardContentWidth(design: DesignKey, layout: string, designWidth = 1920): number {
  const base = Math.min(DESIGN_CARD_BOX[design].width, Math.max(320, designWidth - 240))
  if (layout === 'split') return Math.min(base, 1100)
  if (layout === 'minimal') return Math.min(base, Math.round(designWidth * 0.64))
  return base
}

/** Data-panel content width (data-card is border-box, so padding is subtracted). */
export function dataContentWidth(design: DesignKey, designWidth = 1920): number {
  const box = DESIGN_DATA_BOX[design]
  return Math.max(240, Math.min(box.width, Math.max(320, designWidth - 240)) - 2 * box.padX)
}

/** Pull-quote content width (`.quote-text` is capped independently of the card). */
export function quoteContentWidth(design: DesignKey, designWidth = 1920): number {
  return Math.max(240, Math.min(DESIGN_QUOTE_BOX[design].width, 1250, designWidth - 240))
}

/** Duo panel grid + text-inset geometry (used by both CSS and the fitter). */
export function duoGeometry(
  design: DesignKey,
  designWidth = 1920
): { width: number; gap: number; textPad: number; panelWidth: number; textWidth: number } {
  const m = DESIGN_DUO_BOX[design]
  const width = Math.max(640, Math.min(m.width, designWidth - 200))
  const panelWidth = (width - m.gap) / 2
  const textWidth = Math.max(220, panelWidth - 2 * m.textPad)
  return { width, gap: m.gap, textPad: m.textPad, panelWidth, textWidth }
}

/** Card kicker nominal size/tracking per design (matches the CSS). */
export const DESIGN_KICKER: Record<DesignKey, { px: number; trackingEm: number; mono: boolean }> = {
  editorial: { px: 17, trackingEm: 0.22, mono: true },
  'case-file': { px: 16, trackingEm: 0.34, mono: true },
  newsprint: { px: 16, trackingEm: 0.3, mono: true },
  noir: { px: 15, trackingEm: 0.38, mono: true },
  vivid: { px: 17, trackingEm: 0.26, mono: true },
  bright: { px: 15, trackingEm: 0.26, mono: true },
  glass: { px: 24, trackingEm: 0.22, mono: false }
}

/** Lower-third nominal size per design (matches the CSS). */
export const DESIGN_LOWER_THIRD: Record<DesignKey, number> = {
  editorial: 24,
  'case-file': 24,
  newsprint: 24,
  noir: 22,
  vivid: 40,
  bright: 30,
  glass: 40
}

/** Data-card micro-type nominal sizes (match the per-design CSS). */
export const DESIGN_BAR_LABEL: Record<DesignKey, number> = {
  editorial: 22,
  'case-file': 21,
  newsprint: 21,
  noir: 19,
  vivid: 26,
  bright: 20,
  glass: 30
}

export const DESIGN_BAR_VALUE: Record<DesignKey, number> = {
  editorial: 34,
  'case-file': 34,
  newsprint: 34,
  noir: 26,
  vivid: 36,
  bright: 32,
  glass: 36
}

export const DESIGN_LIST_LABEL: Record<DesignKey, number> = {
  editorial: 30,
  'case-file': 30,
  newsprint: 32,
  noir: 30,
  vivid: 32,
  bright: 30,
  glass: 32
}

export const DESIGN_STAT_NOTE: Record<DesignKey, number> = {
  editorial: 18,
  'case-file': 18,
  newsprint: 26,
  noir: 26,
  vivid: 26,
  bright: 18,
  glass: 26
}

/** Exhibit caption nominal size per design (matches the CSS). */
export const DESIGN_EXHIBIT_CAP: Record<DesignKey, number> = {
  editorial: 19,
  'case-file': 18,
  newsprint: 22,
  noir: 17,
  vivid: 26,
  bright: 17,
  glass: 26
}

/** studio/style.json overrides (DATA-SCHEMA §6) — user-facing tokens. */
export interface StyleOverrides {
  /** Switch the whole preset family before token overrides apply. */
  preset?: string
  accent?: string
  caption_style?: 'kinetic' | 'boxed' | 'off' | string
  vignette?: boolean
  grain?: boolean
  /** The film's default transition pair for scenes that author none. */
  transition_set?: string
}

export function applyStyleOverrides(base: StyleTokens, o: StyleOverrides | null | undefined): StyleTokens {
  if (!o) return base
  const resolved = o.preset ? resolveStyle(o.preset) : base
  const captions =
    o.caption_style === 'kinetic' || o.caption_style === 'boxed' || o.caption_style === 'off' ? o.caption_style : resolved.captions
  return {
    ...resolved,
    accent: o.accent || resolved.accent,
    captions,
    vignette: o.vignette ?? resolved.vignette,
    grain: o.grain === false ? 0 : resolved.grain
  }
}

export function resolveStyle(preset: string): StyleTokens {
  const key = (preset || '').toLowerCase()

  // --- editorial grid (reference: Swiss/brutalist documentary showreel) -----
  if (key.includes('true crime') || key.includes('case-file') || key.includes('casefile')) {
    // Forensic case file (reference 2): aged kraft, letterpress, taped exhibits.
    return {
      key: 'case-file',
      design: 'case-file',
      bg: '#c2ad8c',
      bgDeep: '#a8906e',
      text: '#241a12',
      textDim: 'rgba(36,26,18,.62)',
      ink: '#241a12',
      paper: '#e2d4b6',
      accent: '#9c2f1c',
      secondary: '#4c5a45',
      alert: '#8a1b0e',
      fontHead: "'Fraunces', Georgia, serif",
      fontBody: "'Archivo', Arial, sans-serif",
      mono: MONO_STACK,
      headWeight: 900,
      fonts: FONT_SETS.paper,
      ease: 'power1.out',
      glowHeadline: false,
      grain: 0.14,
      panel: '#e2d4b6',
      panelBorder: 'rgba(36,26,18,.62)',
      exhibitBorder: 'rgba(36,26,18,.55)',
      captions: 'boxed',
      vignette: true,
      accents: 'paper'
    }
  }
  if (key.includes('true-crime')) {
    // Legacy id kept for existing projects — maps onto the case-file system.
    return { ...resolveStyle('true crime'), key: 'true-crime' }
  }
  if (key.includes('archival') || key.includes('history') || key.includes('newsprint')) {
    // Archival broadsheet: cream stock, halftone photos, masthead rules.
    return {
      key: 'archival-history',
      design: 'newsprint',
      bg: '#d7cbb0',
      bgDeep: '#c8b995',
      text: '#241d12',
      textDim: 'rgba(36,29,18,.6)',
      ink: '#241d12',
      paper: '#e9e0ca',
      accent: '#7a2e1e',
      secondary: '#3f4a3a',
      alert: '#8a1b0e',
      fontHead: "'Fraunces', Georgia, serif",
      fontBody: "'Archivo', Arial, sans-serif",
      mono: MONO_STACK,
      headWeight: 900,
      fonts: FONT_SETS.print,
      ease: 'power1.out',
      glowHeadline: false,
      grain: 0.1,
      panel: 'rgba(233,224,202,.96)',
      panelBorder: 'rgba(36,29,18,.55)',
      exhibitBorder: 'rgba(36,29,18,.5)',
      captions: 'boxed',
      vignette: true,
      accents: 'paper'
    }
  }
  if (key.includes('science') || key.includes('vivid')) {
    // Vivid explainer: deep navy, saturated gradient, glowing numerals.
    return {
      key: 'science-explainer',
      design: 'vivid',
      bg: '#080d2b',
      bgDeep: '#050819',
      text: '#f0f1ff',
      textDim: 'rgba(240,241,255,.64)',
      ink: '#161b45',
      paper: '#f0f1ff',
      accent: '#7c5cff',
      secondary: '#22d3ee',
      alert: '#fb7185',
      fontHead: "'Plus Jakarta Sans', 'Inter', sans-serif",
      fontBody: "'Inter', sans-serif",
      mono: MONO_STACK,
      headWeight: 800,
      fonts: FONT_SETS.vivid,
      ease: 'power3.out',
      glowHeadline: true,
      grain: 0.025,
      panel: 'rgba(18,24,64,.9)',
      panelBorder: 'rgba(124,92,255,.4)',
      exhibitBorder: 'rgba(124,92,255,.5)',
      captions: 'kinetic',
      vignette: false,
      accents: 'aurora'
    }
  }
  if (key.includes('investigative') || key.includes('osint') || key.includes('cinema') || key.includes('noir')) {
    // Cinematic noir: letterboxed, sparse, mono timecode, hairline amber.
    return {
      key: 'investigative-cinema',
      design: 'noir',
      bg: '#07080a',
      bgDeep: '#040507',
      text: '#e8e5de',
      textDim: 'rgba(232,229,222,.52)',
      ink: '#20242a',
      paper: '#e8e5de',
      accent: '#d9a441',
      secondary: '#8c8272',
      alert: '#c25b4a',
      fontHead: "'Plus Jakarta Sans', 'Inter', sans-serif",
      fontBody: "'Inter', sans-serif",
      mono: MONO_STACK,
      headWeight: 700,
      fonts: FONT_SETS.noir,
      ease: 'power2.out',
      glowHeadline: false,
      grain: 0.12,
      panel: 'rgba(10,12,15,.88)',
      panelBorder: 'rgba(217,164,65,.32)',
      exhibitBorder: 'rgba(217,164,65,.36)',
      captions: 'boxed',
      vignette: true,
      accents: 'none'
    }
  }
  if (key.includes('business') || key.includes('finance') || key.includes('bright')) {
    // Clean data: white field, hairline grid, tabular numerals, small caps.
    return {
      key: 'business-clean',
      design: 'bright',
      bg: '#fbfbfc',
      bgDeep: '#f1f3f6',
      text: '#0e1620',
      textDim: 'rgba(14,22,32,.55)',
      ink: '#0e1620',
      paper: '#ffffff',
      accent: '#0b6b52',
      secondary: '#1d4ed8',
      alert: '#c02626',
      fontHead: "'Space Grotesk', 'Inter', sans-serif",
      fontBody: "'Inter', sans-serif",
      mono: MONO_STACK,
      headWeight: 700,
      fonts: FONT_SETS.bright,
      ease: 'power2.out',
      glowHeadline: false,
      grain: 0,
      panel: '#ffffff',
      panelBorder: 'rgba(14,22,32,.14)',
      exhibitBorder: 'rgba(14,22,32,.16)',
      captions: 'kinetic',
      vignette: false,
      accents: 'none'
    }
  }
  if (key.includes('kallaway') || key.includes('aurora') || key.includes('glass')) {
    // Premium dark glass (herk style-library 02-kallaway).
    return {
      key: 'kallaway',
      design: 'glass',
      bg: '#0A0E14',
      bgDeep: '#07121C',
      text: '#F0EEE9',
      textDim: 'rgba(240,238,233,.62)',
      ink: '#2A251F',
      paper: '#F0EEE9',
      accent: '#37BDF8',
      secondary: '#F5D82A',
      alert: '#FF3B30',
      fontHead: "'Plus Jakarta Sans', 'Inter', sans-serif",
      fontBody: "'Inter', sans-serif",
      mono: MONO_STACK,
      headWeight: 800,
      fonts: FONT_SETS.glass,
      ease: 'power3.out',
      glowHeadline: true,
      grain: 0.05,
      panel: 'rgba(16,22,32,.94)',
      panelBorder: 'rgba(55,189,248,.28)',
      exhibitBorder: 'rgba(55,189,248,.4)',
      captions: 'kinetic',
      vignette: true,
      accents: 'aurora'
    }
  }
  if (key.includes('vox') || key.includes('explainer') || key.includes('editorial')) {
    // Editorial grid (reference 1): black field, cream paper, acid accent,
    // monospace micro-labels, square geometry, hard offset shadows.
    return {
      key: 'vox-explainer',
      design: 'editorial',
      bg: '#0b0b0c',
      bgDeep: '#151514',
      text: '#111111',
      textDim: 'rgba(17,17,17,.6)',
      ink: '#111111',
      paper: '#e7e3d4',
      accent: '#e8ff00',
      secondary: '#111111',
      alert: '#d92b1f',
      fontHead: "'Archivo', 'Archivo Black', Arial, sans-serif",
      fontBody: "'Archivo', Arial, sans-serif",
      mono: MONO_STACK,
      headWeight: 900,
      fonts: FONT_SETS.editorial,
      ease: 'power2.out',
      glowHeadline: false,
      grain: 0.05,
      panel: '#e7e3d4',
      panelBorder: '#111111',
      exhibitBorder: '#111111',
      captions: 'boxed',
      vignette: false,
      accents: 'none'
    }
  }
  // Unknown preset → editorial family (the studio's house look), honest neutral.
  return { ...resolveStyle('vox-explainer'), key: String(preset || 'default') }
}

// ----------------------------------------------------------------------- css

/** Furniture is the non-content layer that makes a skin read as a *system*:
 *  index numerals, case stamps, mastheads, letterbox, page rules. */
export function designFurniture(
  style: StyleTokens,
  opts: { index: number; total: number; label: string; title: string; width?: number }
): string {
  const pad = String(opts.index).padStart(2, '0')
  const total = String(opts.total).padStart(2, '0')
  const brand = (opts.title || 'VENDOTUBE').toUpperCase()
  const label = (opts.label || '').toUpperCase()
  const width = opts.width ?? 1920
  const type = DESIGN_TYPE[style.design]
  /** Masthead brand that always leaves room for the meta line — the 2026-11-16
   *  newsprint film ran the brand into the section label because flex had no
   *  shrink and no fit. */
  const fittedBrand = (lineWidth: number, metaWidth: number, trailing: number): string => {
    const avail = Math.max(lineWidth * 0.4, lineWidth - metaWidth - trailing)
    const fit = fitOneLine(brand, {
      family: style.fontHead,
      weight: 900,
      maxWidth: avail,
      nominal: type.masthead,
      min: 10,
      trackingEm: type.mastheadTrackingEm,
      caps: type.mastheadCaps,
      maxLines: 1
    })
    return fit.sizePx < type.masthead ? ` style="font-size:${fit.sizePx}px"` : ''
  }
  const monoMetaWidth = (text: string, size: number, tracking: number): number =>
    measureText(text, size, { family: style.mono, weight: 600, trackingEm: tracking, caps: true })

  switch (style.design) {
    case 'editorial': {
      const meta = `DOCUMENTARY — SCENE ${pad} / ${total}`
      const brandStyle = fittedBrand(width - 68, monoMetaWidth(meta, 13, 0.24), 24)
      return `    <div class="furn furn-ed">
      <div class="furn-idx">${pad}</div>
      <div class="furn-top"><span class="furn-brand"${brandStyle}>${escHtml(brand)}</span><span class="furn-meta">${meta}</span></div>
      <div class="furn-bottom"><span>${escHtml(label)}</span><span>${pad}—${total}</span></div>
    </div>`
    }
    case 'case-file':
      return `    <div class="furn furn-cf">
      <div class="furn-stamp">CASE FILE<span class="furn-stamp-n">${pad}</span></div>
      <div class="furn-bottom"><span>${escHtml(label)}</span><span>SEQ ${pad}</span></div>
    </div>`
    case 'newsprint': {
      const brandStyle = fittedBrand(width - 260, monoMetaWidth(label, 13, 0.24), 24)
      return `    <div class="furn furn-np">
      <div class="furn-mast"><span class="furn-brand"${brandStyle}>${escHtml(brand)}</span><span class="furn-meta">${escHtml(label)}</span></div>
      <div class="furn-bottom"><span>SECTION ${pad}</span><span>PAGE ${pad} / ${total}</span></div>
    </div>`
    }
    case 'noir':
      return `    <div class="furn furn-noir">
      <div class="furn-letterbox furn-letterbox-t"></div>
      <div class="furn-letterbox furn-letterbox-b"></div>
      <div class="furn-tc">TC ${pad}</div>
    </div>`
    case 'bright':
      return `    <div class="furn furn-br">
      <div class="furn-bottom"><span>${escHtml(label)}</span><span>${pad} / ${total}</span></div>
    </div>`
    default:
      return ''
  }
}

function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Design overrides appended AFTER the base rule block and BEFORE per-scene
 * layout CSS, so scene-level `visual.layout` still wins. Same selector
 * specificity as the base block → source order decides.
 */
export function designCss(compId: string, style: StyleTokens): string {
  const s = `[data-composition-id="${compId}"]`
  const A = style.accent
  const P = style.paper
  const I = style.ink
  const M = style.mono
  const T = DESIGN_TYPE[style.design]
  const align = 'text-align: left; align-items: flex-start;'

  switch (style.design) {
    // ---------------------------------------------------------- editorial
    case 'editorial':
      return `
      ${s} { background: ${style.bg}; }
      ${s}::before {
        content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
        background-image: repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px 168px);
      }
      ${s} .scrim { background: none; }
      ${s} .vignette, ${s} .aurora { display: none; }
      ${s} .card-shot:not(.overlay-shot) { padding: 0 120px; justify-content: center; }
      ${s} .card {
        width: 1120px; max-width: calc(100% - 240px); ${align} gap: 20px;
        background: ${P}; border: 1.5px solid ${I}; border-radius: 0;
        padding: 56px 64px 60px; box-shadow: none;
      }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 600; font-size: 17px; letter-spacing: .22em;
        color: ${I}; display: flex; align-items: center; gap: 12px;
      }
      ${s} .card-kicker::before { content: ''; width: 15px; height: 15px; background: ${A}; }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 900; text-transform: uppercase;
        font-stretch: 88%;
        font-size: ${T.headlineLg}px; line-height: ${T.headlineLine}; letter-spacing: ${T.headlineTrackingEm}em; color: ${I};
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 100%; height: 2px; border-radius: 0; background: ${I}; box-shadow: none; margin-top: 6px; }
      ${s} .card-note { font-family: ${M}; font-size: 19px; letter-spacing: .06em; color: ${style.textDim}; text-transform: uppercase; }
      ${s} .data-card {
        width: 100%; max-width: 1240px; background: ${P}; border: 1.5px solid ${I};
        border-radius: 0; padding: 48px 54px; box-shadow: 16px 16px 0 ${A}; gap: 22px;
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 900; text-transform: uppercase; font-size: ${T.dataTitle}px; letter-spacing: -.02em; color: ${I}; }
      ${s} .bar-row { grid-template-columns: 320px 1fr 180px; gap: 24px; }
      ${s} .bar-label { font-family: ${M}; font-weight: 600; font-size: 22px; letter-spacing: .06em; text-transform: uppercase; color: ${I}; }
      ${s} .bar-track { height: 30px; background: transparent; border: 1.5px solid ${I}; border-radius: 0; }
      ${s} .bar-fill { background: ${A}; }
      ${s} .bar-value { font-family: ${style.fontHead}; font-weight: 900; font-size: 34px; color: ${I}; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.statValue}px; color: ${I}; letter-spacing: -.04em; }
      ${s} .stat-label { font-family: ${M}; font-weight: 600; font-size: ${T.statLabel}px; letter-spacing: .16em; text-transform: uppercase; }
      ${s} .stat-note { font-family: ${M}; font-size: 18px; color: ${style.textDim}; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-weight: 900; text-transform: uppercase;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; letter-spacing: -.02em; color: ${I};
      }
      ${s} .list-row + .list-row { border-top: 1.5px solid ${I}; }
      ${s} .list-num { font-family: ${M}; font-weight: 700; font-size: 22px; color: ${I}; background: ${A}; padding: 4px 10px; min-width: 0; }
      ${s} .list-label { font-family: ${style.fontBody}; font-weight: 600; font-size: 30px; color: ${I}; }
      ${s} .list-value { font-family: ${style.fontHead}; font-weight: 900; color: ${I}; }
      ${s} .exhibit-shot { padding-bottom: 130px; }
      ${s} .exhibit {
        width: 1180px; height: 660px; border: 2px solid ${I}; border-radius: 0; background: ${P};
        box-shadow: 18px 18px 0 ${A};
      }
      ${s} .exhibit .kb img.kb-bg { filter: none; opacity: 0; }
      ${s} .exhibit .kb img.kb-fg, ${s} .bleed-shot .kb img, ${s} .bleed-shot .kb video { filter: grayscale(1) contrast(1.08); }
      ${s} .exhibit-cap { font-family: ${M}; font-size: 19px; letter-spacing: .14em; text-transform: uppercase; color: ${I}; }
      ${s} .lower-third { background: ${A}; border: 1.5px solid ${I}; border-radius: 0; box-shadow: none; margin: 0 0 110px 120px; }
      ${s} .lower-bar { width: 0; }
      ${s} .lower-text { font-family: ${M}; font-weight: 600; font-size: 24px; letter-spacing: .14em; text-transform: uppercase; color: ${I}; padding: 22px 34px; }
      ${s} .quote-card .quote-mark { font-family: ${style.fontHead}; font-size: 190px; color: ${A}; }
      ${s} .quote-card .quote-text { font-family: ${style.fontHead}; font-style: normal; font-weight: 900; text-transform: uppercase; font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; letter-spacing: -.02em; color: ${I}; }
      ${s} .cap {
        font-family: ${M}; font-weight: 600; font-size: 32px; letter-spacing: .02em;
        background: ${P}; color: ${I}; border: 1.5px solid ${I}; border-radius: 0; box-shadow: none;
        text-align: left; padding: 12px 22px;
      }
      ${s} .capwrap { justify-content: flex-start; left: 120px; right: 120px; }
      ${s} .chapter-dot { border-radius: 0; width: 14px; height: 14px; box-shadow: none; }
      ${s} .chapter-label { font-family: ${M}; font-weight: 600; font-size: 18px; letter-spacing: .2em; color: ${P}; }
      ${s} .grain { mix-blend-mode: multiply; opacity: ${style.grain}; }
      ${s} .chapter { left: 180px; }
      ${s} .media-plate { border: 2px solid ${I}; border-radius: 0; box-shadow: 16px 16px 0 ${A}; }
      /* duo: image + text pair — square panels, hard offset shadow */
      ${s} .duo { grid-template-columns: 1fr 1fr; }
      ${s} .duo-media { border: 2px solid ${I}; border-radius: 0; box-shadow: 14px 14px 0 ${A}; }
      ${s} .duo-text { border: 1.5px solid ${I}; border-radius: 0; background: ${P}; padding: 40px 44px; }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .2em; color: ${I}; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 900; text-transform: uppercase; letter-spacing: -.025em; color: ${I}; }
      ${s} .duo-row + .duo-row { border-top: 1.5px solid ${I}; }
      ${s} .duo-row-label { font-family: ${style.fontBody}; font-weight: 600; color: ${I}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 16px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 900; color: ${I}; letter-spacing: -.04em; }
      ${s} .duo-cap { font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: ${P}; }
      /* furniture */
      ${s} .furn-ed { position: absolute; inset: 0; z-index: 34; pointer-events: none; }
      ${s} .furn-idx {
        position: absolute; left: 40px; top: 66px;
        font-family: ${M}; font-weight: 700; font-size: 96px; line-height: 1;
        color: transparent; -webkit-text-stroke: 2px ${P}; opacity: .5; letter-spacing: -.06em;
      }
      ${s} .furn-top {
        position: absolute; left: 0; right: 0; top: 0; height: 54px; padding: 0 34px;
        display: flex; align-items: center; justify-content: space-between; gap: 24px;
        border-bottom: 1px solid rgba(231,227,212,.22);
      }
      ${s} .furn-brand {
        font-family: ${M}; font-weight: 700; font-size: ${T.masthead}px; letter-spacing: ${T.mastheadTrackingEm}em; color: ${P};
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      ${s} .furn-meta {
        font-family: ${M}; font-weight: 500; font-size: 13px; letter-spacing: .24em; color: rgba(231,227,212,.62);
        flex: 0 0 auto; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      ${s} .furn-bottom {
        position: absolute; left: 0; right: 0; bottom: 0; height: 46px; padding: 0 34px;
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid rgba(231,227,212,.22);
        font-family: ${M}; font-weight: 500; font-size: 13px; letter-spacing: .24em; color: rgba(231,227,212,.62);
      }`

    // ---------------------------------------------------------- case file
    case 'case-file':
      return `
      ${s} { background: ${style.bg}; }
      ${s}::before {
        content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
        background-image: url("${MOTTLE_SVG}"), url("${KRAFT_SVG}");
        background-size: 520px 520px, 300px 300px;
        opacity: .8; mix-blend-mode: multiply;
      }
      ${s} .scrim { background: linear-gradient(180deg, rgba(40,28,16,.18) 0%, rgba(40,28,16,.02) 44%, rgba(40,28,16,.62) 100%); }
      ${s} .vignette {
        background: radial-gradient(ellipse at center, transparent 40%, rgba(52,36,20,.34) 100%);
      }
      ${s} .aurora { display: none; }
      ${s} .card-shot:not(.overlay-shot) { padding-bottom: 120px; }
      ${s} .card {
        width: auto; max-width: 1120px; gap: 26px; position: relative;
        background: ${P}; border: 1px solid rgba(36,26,18,.5); border-radius: 0;
        padding: 62px 70px 58px; transform: rotate(-.5deg);
        box-shadow: 0 22px 48px rgba(48,34,18,.34), 0 2px 0 rgba(255,255,255,.5) inset;
        background-image: url("${KRAFT_SVG}"); background-size: 300px 300px; background-blend-mode: multiply;
      }
      ${s} .card::before {
        content: ''; position: absolute; top: -18px; left: 50%; transform: translateX(-50%) rotate(-1.6deg);
        width: 200px; height: 36px; background: rgba(226,212,180,.9);
        box-shadow: 0 2px 7px rgba(48,34,18,.28); border-left: 1px dashed rgba(120,100,70,.45);
        border-right: 1px dashed rgba(120,100,70,.2);
      }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 600; font-size: 16px; letter-spacing: .34em;
        text-transform: uppercase; color: ${style.accent};
        display: flex; align-items: center; gap: 14px;
      }
      ${s} .card-kicker::before, ${s} .card-kicker::after { content: ''; width: 42px; height: 1px; background: rgba(36,26,18,.42); }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.headlineLg}px; line-height: ${T.headlineLine};
        letter-spacing: ${T.headlineTrackingEm}em; color: ${I};
        text-shadow: 0 1px 0 rgba(255,255,255,.42), 0 -1px 0 rgba(36,26,18,.16);
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 140px; height: 5px; border-radius: 0; background: ${I}; box-shadow: none; }
      ${s} .card-note { font-family: ${M}; font-size: ${T.cardNote}px; letter-spacing: .1em; color: ${style.textDim}; text-transform: uppercase; }
      ${s} .data-card {
        width: 1120px; max-width: 100%;
        background: ${P}; border: 1.5px solid ${I}; border-radius: 0; padding: 52px 58px;
        transform: rotate(.45deg);
        box-shadow: 0 18px 40px rgba(48,34,18,.3);
        background-image: url("${KRAFT_SVG}"); background-size: 300px 300px; background-blend-mode: multiply;
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.dataTitle}px; color: ${I}; }
      ${s} .bar-label { font-family: ${M}; font-weight: 600; font-size: 21px; letter-spacing: .08em; text-transform: uppercase; color: ${I}; }
      ${s} .bar-track { height: 30px; background: rgba(36,26,18,.06); border: 1.5px solid ${I}; border-radius: 0; }
      ${s} .bar-fill { background: ${A}; }
      ${s} .bar-value { font-family: ${style.fontHead}; font-weight: 900; font-size: 34px; color: ${I}; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.statValue}px; color: ${A}; letter-spacing: -.03em; }
      ${s} .stat-label { font-family: ${M}; font-weight: 600; font-size: ${T.statLabel}px; letter-spacing: .18em; text-transform: uppercase; }
      ${s} .stat-note { font-family: ${M}; font-size: 18px; color: ${style.textDim}; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-style: italic; font-weight: 300;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; color: ${I};
      }
      ${s} .list-row + .list-row { border-top: 1px solid rgba(36,26,18,.34); }
      ${s} .list-num { font-family: ${style.fontHead}; font-weight: 900; color: ${A}; }
      ${s} .list-label { font-family: ${style.fontBody}; font-weight: 600; font-size: 30px; color: ${I}; }
      ${s} .exhibit-shot { padding-bottom: 132px; }
      ${s} .exhibit {
        width: 1050px; height: 620px; border: 16px solid #efe7d5; border-radius: 0; background: #efe7d5;
        transform: rotate(-1.1deg);
        box-shadow: 0 26px 54px rgba(48,34,18,.4), 0 0 0 1px rgba(36,26,18,.4);
      }
      ${s} .exhibit::before {
        content: ''; position: absolute; top: -30px; left: 26px; width: 150px; height: 30px; z-index: 3;
        background: rgba(214,198,166,.78); transform: rotate(-4deg);
        box-shadow: 0 2px 6px rgba(48,34,18,.22);
      }
      ${s} .exhibit .kb img.kb-bg { filter: none; opacity: 0; }
      ${s} .exhibit .kb img.kb-fg { filter: sepia(.16) contrast(1.04); }
      ${s} .exhibit-cap { font-family: ${M}; font-size: 18px; letter-spacing: .14em; text-transform: uppercase; color: ${I}; }
      ${s} .lower-third { background: ${P}; border: 1.5px solid ${I}; border-radius: 0; box-shadow: 0 14px 30px rgba(48,34,18,.3); margin: 0 0 120px 120px; }
      ${s} .lower-bar { width: 16px; background: ${I}; }
      ${s} .lower-text { font-family: ${M}; font-weight: 600; font-size: 24px; letter-spacing: .12em; text-transform: uppercase; }
      ${s} .quote-card .quote-mark { font-family: ${style.fontHead}; font-size: 170px; color: ${A}; }
      ${s} .quote-card .quote-text { font-family: ${style.fontHead}; font-style: italic; font-weight: 300; font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; color: ${I}; }
      ${s} .cap {
        font-family: ${M}; font-weight: 600; font-size: 30px; letter-spacing: .04em;
        background: ${P}; color: ${I}; border: 1.5px solid ${I}; border-radius: 0; box-shadow: 0 6px 18px rgba(48,34,18,.24);
      }
      ${s} .chapter-dot { border-radius: 0; border-radius: 50%; background: ${A}; box-shadow: none; }
      ${s} .chapter-label { font-family: ${M}; font-weight: 600; letter-spacing: .2em; font-size: 18px; color: ${P}; }
      ${s} .grain { mix-blend-mode: multiply; opacity: ${style.grain}; }
      ${s} .chapter { left: 130px; }
      ${s} .media-plate { border: 12px solid #efe7d5; border-radius: 0; background: #efe7d5; box-shadow: 0 22px 46px rgba(48,34,18,.36); }
      /* duo: taped photo beside a paper note */
      ${s} .duo-media { border: 12px solid #efe7d5; border-radius: 0; background: #efe7d5; transform: rotate(-.6deg); box-shadow: 0 22px 46px rgba(48,34,18,.36); }
      ${s} .duo-text { border: 1.5px solid ${I}; border-radius: 0; background: ${P}; background-image: url("${KRAFT_SVG}"); background-size: 300px 300px; background-blend-mode: multiply; padding: 28px 46px; }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .24em; color: ${A}; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 900; letter-spacing: -.012em; color: ${I}; }
      ${s} .duo-row + .duo-row { border-top: 1px solid rgba(36,26,18,.34); }
      ${s} .duo-row-label { font-family: ${style.fontBody}; font-weight: 600; color: ${I}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 16px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 900; color: ${A}; }
      ${s} .duo-cap { font-family: ${M}; font-size: 14px; letter-spacing: .12em; text-transform: uppercase; color: #efe7d5; }
      /* furniture */
      ${s} .furn-cf { position: absolute; inset: 0; z-index: 34; pointer-events: none; }
      ${s} .furn-stamp {
        position: absolute; left: 44px; top: 40px; transform: rotate(-2.4deg);
        display: flex; align-items: center; gap: 12px;
        font-family: ${M}; font-weight: 700; font-size: 16px; letter-spacing: .26em;
        color: ${A}; border: 2px solid ${A}; padding: 8px 14px; opacity: .82;
        box-shadow: 0 0 0 1px rgba(156,47,28,.18) inset;
      }
      ${s} .furn-stamp-n { font-size: 20px; letter-spacing: .06em; }
      ${s} .furn-bottom {
        position: absolute; left: 0; right: 0; bottom: 0; height: 44px; padding: 0 40px;
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid rgba(36,26,18,.32);
        font-family: ${M}; font-weight: 600; font-size: 13px; letter-spacing: .28em; color: rgba(36,26,18,.72);
        background: rgba(228,217,193,.55);
      }`

    // ---------------------------------------------------------- newsprint
    case 'newsprint':
      return `
      ${s} { background: ${style.bg}; }
      ${s}::before {
        content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
        background-image: url("${KRAFT_SVG}"); background-size: 420px 420px;
        opacity: .4; mix-blend-mode: multiply;
      }
      ${s} .scrim { background: none; }
      ${s} .vignette { background: radial-gradient(ellipse at center, transparent 48%, rgba(60,44,24,.3) 100%); }
      ${s} .aurora { display: none; }
      ${s} .card-shot:not(.overlay-shot) { padding: 0 130px; justify-content: center; }
      ${s} .card { width: 100%; max-width: 1280px; ${align} gap: 22px; }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 600; font-size: 16px; letter-spacing: .3em; text-transform: uppercase;
        color: ${I}; border-bottom: 3px double ${I}; padding-bottom: 12px; width: 100%;
      }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.headlineLg}px; line-height: ${T.headlineLine};
        letter-spacing: ${T.headlineTrackingEm}em; color: ${I};
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 100%; height: 1px; border-radius: 0; background: ${I}; box-shadow: none; }
      ${s} .card-note { font-family: ${style.fontHead}; font-style: italic; font-size: ${T.cardNote}px; color: ${style.textDim}; }
      ${s} .data-card {
        background: rgba(233,224,202,.92); border: 1px solid ${I}; border-radius: 0;
        padding: 46px 52px; box-shadow: none; width: 100%; max-width: 1280px;
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.dataTitle}px; color: ${I}; }
      ${s} .bar-label { font-family: ${M}; font-weight: 600; font-size: 21px; letter-spacing: .06em; text-transform: uppercase; color: ${I}; }
      ${s} .bar-track { height: 26px; background: transparent; border: 1px solid ${I}; border-radius: 0; }
      ${s} .bar-fill { background: ${A}; }
      ${s} .bar-value { font-family: ${style.fontHead}; font-weight: 900; font-size: 34px; color: ${I}; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.statValue}px; color: ${I}; }
      ${s} .stat-label { font-family: ${M}; font-weight: 600; font-size: ${T.statLabel}px; letter-spacing: .16em; text-transform: uppercase; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-style: italic; font-weight: 300;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; color: ${I};
      }
      ${s} .list-row + .list-row { border-top: 1px solid rgba(36,29,18,.4); }
      ${s} .list-num { font-family: ${style.fontHead}; font-weight: 900; color: ${A}; }
      ${s} .list-label { font-family: ${style.fontHead}; font-weight: 400; font-size: 32px; color: ${I}; }
      ${s} .exhibit-shot { padding-bottom: 130px; }
      ${s} .exhibit {
        width: 1180px; height: 650px; border: 1px solid ${I}; border-radius: 0; background: ${style.bgDeep};
        box-shadow: 0 0 0 1px rgba(255,255,255,.4) inset;
      }
      ${s} .exhibit .kb img.kb-bg { filter: blur(18px) grayscale(1); opacity: .5; }
      ${s} .exhibit .kb img.kb-fg, ${s} .bleed-shot .kb img { filter: grayscale(1) contrast(1.14); }
      ${s} .exhibit::after {
        content: ''; position: absolute; inset: 0; z-index: 3; pointer-events: none;
        background-image: url("${HALFTONE_SVG}"); background-size: 6px 6px;
        mix-blend-mode: multiply; opacity: .18;
      }
      ${s} .exhibit-cap { font-family: ${style.fontHead}; font-style: italic; font-size: 22px; letter-spacing: .02em; color: ${I}; }
      ${s} .lower-third { background: ${I}; border: none; border-radius: 0; box-shadow: none; margin: 0 0 120px 130px; }
      ${s} .lower-bar { width: 0; }
      ${s} .lower-text { font-family: ${M}; font-weight: 600; font-size: 24px; letter-spacing: .18em; text-transform: uppercase; color: ${P}; }
      ${s} .quote-card .quote-mark { font-family: ${style.fontHead}; font-size: 180px; color: ${A}; }
      ${s} .quote-card .quote-text { font-family: ${style.fontHead}; font-style: italic; font-weight: 300; font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; color: ${I}; }
      ${s} .cap {
        font-family: ${style.fontHead}; font-weight: 400; font-size: 34px;
        background: rgba(233,224,202,.94); color: ${I}; border: 1px solid ${I}; border-radius: 0; box-shadow: none;
      }
      ${s} .chapter-label { font-family: ${M}; font-weight: 600; letter-spacing: .22em; color: ${P}; }
      ${s} .chapter-dot { border-radius: 0; box-shadow: none; }
      ${s} .grain { mix-blend-mode: multiply; opacity: ${style.grain}; }
      ${s} .chapter { left: 130px; }
      ${s} .media-plate { border: 1px solid ${I}; border-radius: 0; background: ${style.bgDeep}; box-shadow: 0 0 0 1px rgba(255,255,255,.4) inset; }
      /* duo: broadsheet photo plate beside a column of text */
      ${s} .duo-media { border: 1px solid ${I}; border-radius: 0; background: ${style.bgDeep}; }
      ${s} .duo-text { border: 1px solid ${I}; border-radius: 0; background: #e9e0ca; padding: 26px 44px; }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .24em; color: ${I}; border-bottom: 3px double ${I}; padding-bottom: 10px; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 900; letter-spacing: -.02em; color: ${I}; }
      ${s} .duo-row + .duo-row { border-top: 1px solid rgba(36,29,18,.4); }
      ${s} .duo-row-label { font-family: ${style.fontHead}; font-weight: 400; color: ${I}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 15px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 900; color: ${I}; }
      ${s} .duo-cap { font-family: ${style.fontHead}; font-style: italic; font-size: 16px; letter-spacing: .02em; color: ${I}; }
      /* furniture */
      ${s} .furn-np { position: absolute; inset: 0; z-index: 34; pointer-events: none; }
      ${s} .furn-mast {
        position: absolute; left: 130px; right: 130px; top: 34px; height: 44px;
        display: flex; align-items: center; justify-content: space-between; gap: 24px;
        border-bottom: 4px double ${I}; padding-bottom: 10px;
      }
      ${s} .furn-brand {
        font-family: ${style.fontHead}; font-weight: 900; font-size: ${T.masthead}px; letter-spacing: ${T.mastheadTrackingEm}em; color: ${I};
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      ${s} .furn-meta {
        font-family: ${M}; font-weight: 600; font-size: 13px; letter-spacing: .24em; color: rgba(36,29,18,.7);
        flex: 0 0 auto; max-width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      ${s} .furn-bottom {
        position: absolute; left: 130px; right: 130px; bottom: 30px; height: 34px;
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid rgba(36,29,18,.4);
        font-family: ${M}; font-weight: 500; font-size: 12px; letter-spacing: .24em; color: rgba(36,29,18,.68);
      }`

    // ---------------------------------------------------------- noir
    case 'noir':
      return `
      ${s} .card-shot:not(.overlay-shot) { padding-bottom: 90px; }
      ${s} .card { width: 76%; max-width: 980px; gap: 26px; }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 500; font-size: 15px; letter-spacing: .38em; text-transform: uppercase;
        color: ${style.textDim};
      }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 700; font-size: ${T.headlineLg}px; line-height: ${T.headlineLine};
        letter-spacing: ${T.headlineTrackingEm}em; color: ${style.text}; max-width: 1040px;
        text-shadow: 0 2px 40px rgba(0,0,0,.7);
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 64px; height: 1px; border-radius: 0; background: ${A}; box-shadow: none; margin-top: 12px; }
      ${s} .card-note { font-family: ${M}; font-size: ${T.cardNote}px; letter-spacing: .14em; color: ${style.textDim}; text-transform: uppercase; }
      ${s} .data-card {
        background: ${style.panel}; border: 1px solid ${style.panelBorder}; border-radius: 0;
        padding: 44px 52px; box-shadow: 0 30px 80px rgba(0,0,0,.6); backdrop-filter: blur(2px);
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 700; font-size: ${T.dataTitle}px; letter-spacing: .01em; color: ${style.text}; }
      ${s} .bar-label { font-family: ${M}; font-weight: 500; font-size: 19px; letter-spacing: .12em; text-transform: uppercase; color: ${style.text}; }
      ${s} .bar-track { height: 18px; background: rgba(255,255,255,.05); border: none; border-radius: 0; }
      ${s} .bar-fill { background: ${A}; }
      ${s} .bar-value { font-family: ${M}; font-weight: 500; font-size: 26px; color: ${style.text}; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 700; font-size: ${T.statValue}px; color: ${A}; letter-spacing: -.02em; }
      ${s} .stat-label { font-family: ${M}; font-weight: 500; font-size: ${T.statLabel}px; letter-spacing: .22em; text-transform: uppercase; color: ${style.text}; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-style: italic; font-weight: 300;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; color: ${style.text};
      }
      ${s} .list-row + .list-row { border-top: 1px solid rgba(255,255,255,.1); }
      ${s} .list-num { font-family: ${M}; font-weight: 500; color: ${A}; }
      ${s} .list-label { font-weight: 400; font-size: 30px; letter-spacing: .01em; }
      ${s} .exhibit-shot { padding-bottom: 110px; }
      ${s} .exhibit {
        width: 1180px; height: 650px; border: 1px solid ${style.exhibitBorder}; border-radius: 0;
        background: #05070a; box-shadow: 0 40px 100px rgba(0,0,0,.75);
      }
      ${s} .exhibit .kb img.kb-bg { filter: blur(30px) brightness(.6); }
      ${s} .exhibit .kb img.kb-fg, ${s} .bleed-shot .kb img { filter: contrast(1.08) saturate(.92); }
      ${s} .exhibit-cap { font-family: ${M}; font-size: 17px; letter-spacing: .18em; text-transform: uppercase; color: ${style.textDim}; }
      ${s} .lower-third { background: rgba(6,8,10,.9); border: 1px solid ${style.panelBorder}; border-radius: 0; margin: 0 0 100px 110px; box-shadow: none; }
      ${s} .lower-bar { width: 1px; background: ${A}; }
      ${s} .lower-text { font-family: ${M}; font-weight: 500; font-size: 22px; letter-spacing: .2em; text-transform: uppercase; color: ${style.text}; }
      ${s} .quote-card .quote-mark { font-family: ${style.fontHead}; font-size: 150px; color: ${A}; }
      ${s} .quote-card .quote-text { font-family: ${style.fontHead}; font-style: italic; font-weight: 300; font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; color: ${style.text}; }
      ${s} .cap {
        font-family: ${M}; font-weight: 500; font-size: 30px; letter-spacing: .04em;
        background: rgba(6,8,10,.86); border: 1px solid rgba(255,255,255,.14); border-radius: 0; box-shadow: none;
      }
      ${s} .chapter-label { font-family: ${M}; font-weight: 500; letter-spacing: .26em; color: ${style.textDim}; }
      ${s} .chapter-dot { width: 6px; height: 6px; box-shadow: none; }
      ${s} .grain { opacity: ${style.grain}; }
      ${s} .media-plate { border: 1px solid ${style.exhibitBorder}; border-radius: 0; background: #05070a; box-shadow: 0 40px 100px rgba(0,0,0,.75); }
      /* duo: stills beside a hard-bitten caption column */
      ${s} .duo-media { border: 1px solid ${style.exhibitBorder}; border-radius: 0; background: #05070a; }
      ${s} .duo-text { border: 1px solid ${style.panelBorder}; border-radius: 0; background: #06080a; padding: 26px 42px; }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 500; font-size: 14px; letter-spacing: .38em; color: ${style.textDim}; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 700; letter-spacing: .005em; color: ${style.text}; }
      ${s} .duo-row + .duo-row { border-top: 1px solid rgba(255,255,255,.12); }
      ${s} .duo-row-label { font-family: ${style.fontBody}; font-weight: 500; color: ${style.text}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 15px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 700; color: ${A}; }
      ${s} .duo-cap { font-family: ${M}; font-size: 13px; letter-spacing: .2em; text-transform: uppercase; color: rgba(232,229,222,.5); }
      /* furniture */
      ${s} .furn-noir { position: absolute; inset: 0; z-index: 34; pointer-events: none; }
      ${s} .furn-letterbox { position: absolute; left: 0; right: 0; height: 7.2%; background: #000; }
      ${s} .furn-letterbox-t { top: 0; }
      ${s} .furn-letterbox-b { bottom: 0; }
      ${s} .furn-tc {
        position: absolute; right: 38px; top: 8.6%;
        font-family: ${M}; font-weight: 500; font-size: 12px; letter-spacing: .3em; color: rgba(232,229,222,.34);
      }`

    // ---------------------------------------------------------- vivid
    case 'vivid':
      return `
      ${s} { background: radial-gradient(ellipse 90% 70% at 50% 108%, #1a2170 0%, ${style.bg} 62%); }
      ${s} .card-shot:not(.overlay-shot) { padding-bottom: 110px; }
      ${s} .card { width: 80%; max-width: 1320px; gap: 28px; }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 600; font-size: 17px; letter-spacing: .26em; text-transform: uppercase;
        color: ${style.secondary};
      }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 800; font-size: ${T.headlineLg}px; line-height: ${T.headlineLine};
        letter-spacing: ${T.headlineTrackingEm}em; color: ${style.text};
        text-shadow: 0 0 60px rgba(124,92,255,.5), 0 2px 30px rgba(255,255,255,.12);
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 150px; height: 6px; border-radius: 999px; background: linear-gradient(90deg, ${A}, ${style.secondary}); box-shadow: 0 0 34px ${A}80; }
      ${s} .data-card {
        background: linear-gradient(160deg, rgba(30,38,96,.94), rgba(12,16,48,.96));
        border: 1px solid ${style.panelBorder}; border-radius: 28px; padding: 54px 62px;
        box-shadow: 0 34px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04) inset;
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 800; font-size: ${T.dataTitle}px; letter-spacing: -.02em; color: ${style.text}; }
      ${s} .bar-track { height: 34px; background: rgba(255,255,255,.07); border: none; border-radius: 999px; }
      ${s} .bar-fill { background: linear-gradient(90deg, ${A}, ${style.secondary}); border-radius: 999px; }
      ${s} .bar-label { font-weight: 600; font-size: 26px; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 800; font-size: ${T.statValue}px; color: ${style.secondary}; text-shadow: 0 0 70px ${style.secondary}80; }
      ${s} .stat-label { font-family: ${M}; font-weight: 600; font-size: ${T.statLabel}px; letter-spacing: .2em; text-transform: uppercase; color: ${style.textDim}; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-style: italic; font-weight: 300;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; color: ${style.text};
      }
      ${s} .list-row + .list-row { border-top: 1px solid rgba(255,255,255,.12); }
      ${s} .list-num { color: ${style.secondary}; }
      ${s} .exhibit { border-radius: 26px; border: 1px solid ${style.exhibitBorder}; box-shadow: 0 40px 100px rgba(0,0,0,.6), 0 0 60px ${A}33; }
      ${s} .exhibit .kb img.kb-bg { filter: blur(30px) saturate(1.3) brightness(.8); }
      ${s} .quote-card .quote-text { font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; }
      ${s} .cap { border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(10,14,40,.86); }
      ${s} .chapter-label { color: ${style.secondary}; }
      ${s} .media-plate { border: 1px solid ${style.panelBorder}; border-radius: 26px; background: ${style.bgDeep}; box-shadow: 0 40px 100px rgba(0,0,0,.6), 0 0 60px ${A}33; }
      /* duo: glossy panel beside a gradient column */
      ${s} .duo-media { border-radius: 26px; border: 1px solid ${style.exhibitBorder}; box-shadow: 0 40px 100px rgba(0,0,0,.6), 0 0 60px ${A}33; }
      ${s} .duo-text {
        border-radius: 26px; border: 1px solid ${style.panelBorder};
        background: linear-gradient(160deg, rgba(30,38,96,.94), rgba(12,16,48,.96));
        box-shadow: 0 34px 90px rgba(0,0,0,.55); padding: 30px 48px;
      }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .26em; color: ${style.secondary}; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 800; letter-spacing: -.028em; color: ${style.text}; }
      ${s} .duo-row + .duo-row { border-top: 1px solid rgba(255,255,255,.12); }
      ${s} .duo-row-label { font-family: ${style.fontBody}; font-weight: 600; color: ${style.text}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 16px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 800; color: ${style.secondary}; }
      ${s} .duo-cap { font-family: ${M}; font-size: 14px; letter-spacing: .14em; text-transform: uppercase; color: ${style.textDim}; }`

    // ---------------------------------------------------------- bright
    case 'bright':
      return `
      ${s} { background: ${style.bg}; }
      ${s}::before {
        content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
        background-image: repeating-linear-gradient(90deg, rgba(14,22,32,.05) 0 1px, transparent 1px 120px);
      }
      ${s} .scrim { background: none; }
      ${s} .vignette, ${s} .aurora { display: none; }
      ${s} .card-shot:not(.overlay-shot) { padding: 0 130px; justify-content: center; }
      ${s} .card { width: 100%; max-width: 1240px; ${align} gap: 20px; }
      ${s} .card-kicker {
        font-family: ${M}; font-weight: 600; font-size: 15px; letter-spacing: .26em; text-transform: uppercase;
        color: ${A}; display: flex; align-items: center; gap: 14px;
      }
      ${s} .card-kicker::before { content: ''; width: 34px; height: 1px; background: ${A}; }
      ${s} .card-headline {
        font-family: ${style.fontHead}; font-weight: 700; font-size: 90px; line-height: 1.02;
        letter-spacing: -.034em; color: ${style.text};
      }
      ${s} .card-headline.headline-md { font-size: ${T.headlineMd}px; }
      ${s} .card-headline.headline-sm { font-size: ${T.headlineSm}px; }
      ${s} .headline-rule { width: 100%; height: 1px; border-radius: 0; background: rgba(14,22,32,.18); box-shadow: none; }
      ${s} .card-note { font-family: ${M}; font-size: ${T.cardNote}px; letter-spacing: .04em; color: ${style.textDim}; }
      ${s} .data-card {
        width: 100%; max-width: 1240px; background: #fff; border: 1px solid ${style.panelBorder};
        border-radius: 8px; padding: 46px 52px; box-shadow: 0 1px 2px rgba(14,22,32,.04);
      }
      ${s} .data-title { font-family: ${style.fontHead}; font-weight: 700; font-size: ${T.dataTitle}px; letter-spacing: -.02em; color: ${style.text}; }
      ${s} .bar-label { font-family: ${M}; font-weight: 600; font-size: 20px; letter-spacing: .04em; color: ${style.text}; }
      ${s} .bar-track { height: 22px; background: #eef1f4; border: none; border-radius: 4px; }
      ${s} .bar-fill { background: ${A}; border-radius: 4px; }
      ${s} .bar-value { font-family: ${style.fontHead}; font-weight: 700; font-size: 32px; color: ${style.text}; font-variant-numeric: tabular-nums; }
      ${s} .stat-value { font-family: ${style.fontHead}; font-weight: 700; font-size: ${T.statValue}px; color: ${style.text}; font-variant-numeric: tabular-nums; letter-spacing: -.04em; }
      ${s} .stat-label { font-family: ${M}; font-weight: 600; font-size: ${T.statLabel}px; letter-spacing: .2em; text-transform: uppercase; color: ${style.textDim}; }
      ${s} .stat-note { font-family: ${M}; font-size: 18px; color: ${style.textDim}; }
      ${s} .stat-quote {
        font-family: ${style.fontHead}; font-style: normal; font-weight: 500;
        font-size: ${T.statQuote}px; line-height: ${T.statQuoteLine}; letter-spacing: -.02em; color: ${style.text};
      }
      ${s} .list-row + .list-row { border-top: 1px solid ${style.panelBorder}; }
      ${s} .list-num { font-family: ${M}; font-weight: 600; color: ${A}; }
      ${s} .list-label { font-weight: 500; font-size: 30px; }
      ${s} .list-value { font-family: ${style.fontHead}; font-weight: 700; font-variant-numeric: tabular-nums; }
      ${s} .exhibit-shot { padding-bottom: 120px; }
      ${s} .exhibit {
        width: 1160px; height: 640px; border: 1px solid ${style.exhibitBorder}; border-radius: 8px;
        background: ${style.bgDeep}; box-shadow: 0 18px 50px rgba(14,22,32,.12);
      }
      ${s} .exhibit .kb img.kb-bg { filter: blur(22px) saturate(.9) brightness(1.02); }
      ${s} .exhibit-cap { font-family: ${M}; font-size: 17px; letter-spacing: .1em; text-transform: uppercase; color: ${style.textDim}; }
      ${s} .lower-third { background: #fff; border: 1px solid ${style.panelBorder}; border-radius: 6px; box-shadow: 0 10px 30px rgba(14,22,32,.1); margin: 0 0 120px 130px; }
      ${s} .lower-bar { width: 6px; background: ${A}; }
      ${s} .lower-text { font-family: ${style.fontHead}; font-weight: 700; font-size: 30px; letter-spacing: -.01em; color: ${style.text}; }
      ${s} .quote-card .quote-mark { font-family: ${style.fontHead}; font-size: 160px; color: ${A}; }
      ${s} .quote-card .quote-text { font-family: ${style.fontHead}; font-style: normal; font-weight: 500; font-size: ${T.quoteText}px; line-height: ${T.quoteLine}; letter-spacing: -.02em; color: ${style.text}; }
      ${s} .cap {
        font-family: ${style.fontBody}; font-weight: 600; font-size: 32px;
        background: #fff; color: ${style.text}; border: 1px solid ${style.panelBorder}; border-radius: 6px;
        box-shadow: 0 6px 20px rgba(14,22,32,.1);
      }
      ${s} .chapter-dot { display: none; }
      ${s} .chapter-label { font-family: ${M}; font-weight: 600; color: ${style.textDim}; }
      ${s} .grain { display: none; }
      ${s} .media-plate { border: 1px solid ${style.panelBorder}; border-radius: 8px; background: ${style.bgDeep}; box-shadow: 0 18px 50px rgba(14,22,32,.12); }
      /* duo: clean product panel beside a card */
      ${s} .duo-media { border: 1px solid ${style.exhibitBorder}; border-radius: 8px; background: ${style.bgDeep}; box-shadow: 0 18px 50px rgba(14,22,32,.12); }
      ${s} .duo-text { border: 1px solid ${style.panelBorder}; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(14,22,32,.04); padding: 28px 46px; }
      ${s} .duo-kicker { font-family: ${M}; font-weight: 600; font-size: 14px; letter-spacing: .26em; color: ${A}; }
      ${s} .duo-title { font-family: ${style.fontHead}; font-weight: 700; letter-spacing: -.034em; color: ${style.text}; }
      ${s} .duo-row + .duo-row { border-top: 1px solid ${style.panelBorder}; }
      ${s} .duo-row-label { font-family: ${style.fontBody}; font-weight: 600; color: ${style.text}; }
      ${s} .duo-row-note { font-family: ${M}; font-size: 15px; color: ${style.textDim}; }
      ${s} .duo-stat { font-family: ${style.fontHead}; font-weight: 700; color: ${style.text}; font-variant-numeric: tabular-nums; }
      ${s} .duo-cap { font-family: ${M}; font-weight: 600; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: ${style.textDim}; }
      /* furniture */
      ${s} .furn-br { position: absolute; inset: 0; z-index: 34; pointer-events: none; }
      ${s} .furn-bottom {
        position: absolute; left: 130px; right: 130px; bottom: 28px; height: 28px;
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid rgba(14,22,32,.12);
        font-family: ${M}; font-weight: 600; font-size: 12px; letter-spacing: .22em; color: rgba(14,22,32,.5);
      }`

    // ---------------------------------------------------------- glass (house)
    default:
      return ''
  }
}
