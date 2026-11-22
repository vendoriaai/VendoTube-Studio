import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { locateAppAsset, resolveStyle, type StyleOverrides } from './compositions'

/**
 * YouTube thumbnail concepts (M5, UI-UX-SPEC §4.7 "thumbnail concept cards"):
 * three 1280×720 stills rendered from the film's title/thesis with the
 * project's style tokens, via the same browser family Scout uses (system
 * Edge/Chrome channel — headless here). Fonts are the vendored woff2 files,
 * referenced as file:// URLs so nothing is fetched online.
 */

export interface ThumbnailInput {
  projectPath: string
  title: string
  kicker?: string
  stylePreset: string
  styleOverrides?: StyleOverrides | null
  browserChannel?: string
}

export interface ThumbnailResult {
  files: string[] // project-relative PNG paths
  browser: string // channel actually used
}

function fontFaces(style: ReturnType<typeof resolveStyle>): string {
  return style.fonts
    .map((f) => {
      const abs = locateAppAsset(join('assets', 'fonts', f.file))
      const url = pathToFileURL(abs).href
      return `@font-face { font-family: '${f.family}'; src: url('${url}') format('woff2'); font-weight: ${f.weight}; font-style: ${f.fontStyle}; }`
    })
    .filter(Boolean)
    .join('\n')
}

function conceptHtml(input: ThumbnailInput, style: ReturnType<typeof resolveStyle>, variant: 1 | 2 | 3): string {
  const fonts = fontFaces(style)
  const title = escapeHtml(input.title.toUpperCase())
  const kicker = escapeHtml((input.kicker ?? 'DOCUMENTARY').toUpperCase())
  const common = `
    <style>
      ${fonts}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1280px; height: 720px; overflow: hidden; }
      .frame { position: relative; width: 1280px; height: 720px; background: ${style.bg}; overflow: hidden; }
      .kicker { font-family: ${style.fontBody}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.22em; font-size: 28px; color: ${style.textDim}; }
      .title { font-family: ${style.fontHead}; font-weight: ${style.headWeight}; letter-spacing: -0.02em; color: ${style.text}; line-height: 1.02; }
      .marker { background: ${style.accent}; color: ${style.ink}; padding: 4px 26px 14px; display: inline; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
      .brand { position: absolute; bottom: 28px; left: 48px; font-family: ${style.fontBody}; font-weight: 700; font-size: 20px; letter-spacing: 0.14em; color: ${style.textDim}; }
      .grain { position: absolute; inset: 0; opacity: ${style.grain}; mix-blend-mode: multiply;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E"); }
    </style>`
  if (variant === 1) {
    // Concept A — the vox marker: full-bleed accent block behind the title.
    return `<!doctype html><html><head><meta charset="utf-8">${common}</head>
    <body><div class="frame">
      <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:30px; padding:0 90px; text-align:center;">
        <div class="kicker">${kicker}</div>
        <div class="title" style="font-size:150px;"><span class="marker">${title}</span></div>
      </div>
      <div class="brand">VENDOTUBE STUDIO</div>
      <div class="grain"></div>
    </div></body></html>`
  }
  if (variant === 2) {
    // Concept B — split layout: oversized title left, accent panel right.
    return `<!doctype html><html><head><meta charset="utf-8">${common}</head>
    <body><div class="frame">
      <div style="position:absolute; left:0; top:0; bottom:0; width:62%; display:flex; flex-direction:column; justify-content:center; padding:0 60px;">
        <div class="kicker" style="margin-bottom:24px;">${kicker}</div>
        <div class="title" style="font-size:112px;">${title}</div>
      </div>
      <div style="position:absolute; right:0; top:0; bottom:0; width:38%; background:${style.accent};"></div>
      <div style="position:absolute; right:60px; top:50%; transform:translateY(-50%); font-family:${style.fontHead}; font-weight:${style.headWeight}; font-size:170px; color:${style.ink};">▶</div>
      <div class="brand" style="color:${style.ink}; left:auto; right:48px;">VENDOTUBE STUDIO</div>
      <div class="grain"></div>
    </div></body></html>`
  }
  // Concept C — minimal poster: thin accent rule, small caps, huge serif.
  return `<!doctype html><html><head><meta charset="utf-8">${common}</head>
    <body><div class="frame">
      <div style="position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; padding:0 100px;">
        <div style="width:220px; height:12px; background:${style.accent}; margin-bottom:36px;"></div>
        <div class="kicker" style="margin-bottom:22px;">${kicker}</div>
        <div class="title" style="font-size:128px;">${title}</div>
      </div>
      <div class="brand">VENDOTUBE STUDIO</div>
      <div class="grain"></div>
    </div></body></html>`
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function generateThumbnails(input: ThumbnailInput): Promise<ThumbnailResult> {
  const style = resolveStyle(input.stylePreset)
  const channels = input.browserChannel ? [input.browserChannel, 'msedge', 'chrome', undefined] : ['msedge', 'chrome', undefined]
  let lastError: unknown = null
  for (const channel of channels) {
    let browser = null
    try {
      browser = await chromium.launch({ channel, headless: true })
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
      const outDir = join(input.projectPath, 'delivery', 'thumbnails')
      mkdirSync(outDir, { recursive: true })
      const files: string[] = []
      for (const variant of [1, 2, 3] as const) {
        await page.setContent(conceptHtml(input, style, variant), { waitUntil: 'load' })
        const file = join(outDir, `thumb-${variant}.png`)
        const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 720 } })
        writeFileSync(file, buffer)
        files.push(`delivery/thumbnails/thumb-${variant}.png`)
      }
      await browser.close()
      return { files, browser: String(channel ?? 'bundled') }
    } catch (err) {
      lastError = err
      try {
        await browser?.close()
      } catch {
        // ignore close races on failed launches
      }
    }
  }
  throw new Error(`thumbnail render failed on every browser channel: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
