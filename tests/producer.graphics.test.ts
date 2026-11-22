import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCompositions, type CompositionShot, type DataCard, type WorkflowJson } from '../src/main/producer/compositions'

/**
 * Motion-graphics vocabulary (2026-11-16): animated line charts, chronologies,
 * location maps and reconstructed article clippings. Markup + tween targets
 * are the contract; the renderer is deterministic HTML/SVG + GSAP.
 */

function buildCard(template: string, data: DataCard, durS = 8): { html: string; notes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'vf-gfx-'))
  const shot: CompositionShot = { kind: 'composition', template, data, dur_s: durS }
  const workflow: WorkflowJson = {
    version: 1,
    render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
    scenes: [{ id: 'S01', vo: { script_section: 'hook', voice: 'v' }, claims: [], shots: [shot] }]
  }
  const res = buildCompositions({
    projectPath: dir,
    workflow,
    voDurations: { hook: durS },
    stylePreset: 'archival-history',
    projectTitle: 'Graphics'
  })
  return { html: readFileSync(join(res.dir, 'compositions', 'scene-S01.html'), 'utf-8'), notes: res.layoutNotes }
}

describe('data-line (animated chart)', () => {
  const data: DataCard = {
    kind: 'line',
    title: 'Documentary output grows',
    unit: 'films',
    labels: ['1895', '1905', '1915', '1925'],
    series: [
      { label: 'Documentary films', values: [6, 42, 78, 130] },
      { label: 'Newsreels', values: [20, 35, 60, 90] }
    ],
    items: []
  }

  it('renders axes, series paths, dots and a legend', () => {
    const { html } = buildCard('data-line', data)
    expect(html).toContain('chart-card line-card')
    expect(html).toContain('class="chart-line chart-line-0" pathLength="1"')
    expect(html).toContain('class="chart-line chart-line-1" pathLength="1"')
    expect(html).toContain('chart-area-0')
    expect(html).toContain('chart-dot-0-0')
    expect(html).toContain('class="chart-axis-label"')
    expect(html).toContain('>1895</text>')
    expect(html).toContain('chart-key-1')
    expect(html).toContain('Documentary films')
  })

  it('draws each series and pops the dots on the timeline', () => {
    const { html } = buildCard('data-line', data)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.chart-line-0', \{ strokeDashoffset: 1 \}/)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.chart-line-1'/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.chart-dots-0 circle'/)
  })
})

describe('data-timeline (animated chronology)', () => {
  const data: DataCard = {
    kind: 'timeline',
    title: 'The form finds its name',
    events: [
      { label: 'First commercial screening', year: 1895, note: 'Paris' },
      { label: 'Nanook of the North', year: 1922, note: 'New York' },
      { label: 'Kino-Eye', year: 1923, note: 'Moscow' },
      { label: '“Documentary” is coined', year: 1926, note: 'Grierson', highlight: true }
    ],
    items: []
  }

  it('places close years in separate lanes so cards never clip', () => {
    const { html } = buildCard('data-timeline', data)
    expect(html).toContain('timeline-card')
    expect(html).toContain('tl-event tl-above tl-lane-0')
    expect(html).toContain('tl-event tl-below tl-lane-1')
    expect(html).toContain('tl-event tl-above tl-lane-2')
    expect(html).toContain('tl-on')
    expect(html).toContain('class="tl-year-in">1926<')
    // no free-floating axis year labels to collide
    expect(html).not.toContain('class="tl-year"')
  })

  it('draws the axis and reveals events on the timeline', () => {
    const { html } = buildCard('data-timeline', data)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.tl-axis', \{ scaleX: 0 \}/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.tl-event'/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.tl-node'/)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.tl-on \.tl-node'/)
  })
})

describe('data-map (animated locations)', () => {
  const data: DataCard = {
    kind: 'map',
    title: 'Where the argument happened',
    route: true,
    markers: [
      { label: 'Paris' },
      { label: 'Port Harrison', note: 'Inukjuak, 1920', highlight: true },
      { label: 'New York', note: 'premiere, 1922' },
      { label: 'Moscow' }
    ],
    items: []
  }

  it('draws the Natural Earth dot map, gazetteer-resolved pins and a route', () => {
    const { html } = buildCard('data-map', data)
    expect(html).toContain('map-card')
    expect(html).toContain('class="map-dots"')
    expect(html).toContain('class="map-route" pathLength="1"')
    expect(html).toContain('map-pin-on')
    expect(html).toContain('>Paris</text>')
    expect(html).toContain('>Port Harrison</text>')
    expect(html).toContain('Inukjuak, 1920')
    expect(html).toContain('EQUIRECTANGULAR · NATURAL EARTH 110m')
  })

  it('never plots an unknown place at a guessed coordinate', () => {
    const { html } = buildCard('data-map', { ...data, route: false, markers: [{ label: 'Atlantis' }], items: [] })
    expect(html).toContain('Not mapped (no coordinates): Atlantis')
    expect(html).not.toMatch(/class="map-pin map-pin-\d+ map-pin-on"/)
  })

  it('draws the route and pulses the highlighted pin', () => {
    const { html } = buildCard('data-map', data)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.map-route', \{ strokeDashoffset: 1 \}/)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.map-pin-on \.map-pulse'/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.map-pin'/)
  })
})

describe('article (reconstructed clipping)', () => {
  const data: DataCard = {
    kind: 'article',
    publication: 'The New York Sun',
    date: '1926',
    headline: 'The Creative Treatment of Actuality',
    body: 'A review of Moana argues that the film reaches past the travelogue into something else: a story shaped from real life.',
    quote: 'The creative treatment of actuality',
    attribution: 'John Grierson',
    items: []
  }

  it('recreates the clipping, labels it a reconstruction and highlights the quote', () => {
    const { html } = buildCard('article', data)
    expect(html).toContain('article-card')
    expect(html).toContain('FROM THE ARTICLE · RECONSTRUCTION · THE NEW YORK SUN')
    expect(html).toContain('article-headline')
    expect(html).toContain('The Creative Treatment of Actuality')
    expect(html).toContain('article-body')
    expect(html).toContain('article-mark')
    expect(html).toContain('“The creative treatment of actuality”')
    expect(html).toContain('— John Grierson')
  })

  it('sweeps the highlighter and reveals the article in order', () => {
    const { html } = buildCard('article', data)
    expect(html).toMatch(/tl\.fromTo\('\.shot-0 \.article-mark', \{ scaleX: 0 \}/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.article-headline'/)
    expect(html).toMatch(/tl\.from\('\.shot-0 \.article-attr'/)
  })
})