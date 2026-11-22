import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ChatClient } from '../src/main/agent/chat'
import { ScoutRunner } from '../src/main/agent/scout'
import type { ScoutDeps } from '../src/main/agent/tools'
import type { ScoutBrowser, PageRead } from '../src/main/browser/scoutBrowser'

/**
 * Scout loop verified against a local mock OpenAI-compatible server — proves
 * the tool-calling loop, batched ledger writes, journaling, and termination
 * without any provider account (M1 exit criterion support).
 */

interface ScriptedTurn {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  content?: string
  /** Empty provider reply: no content, no tool calls (the ai-history failure mode). */
  empty?: boolean
}

function startMockProvider(turns: ScriptedTurn[]): { server: Server; url: string; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)]
      const message = turn.toolCalls
        ? {
            role: 'assistant',
            content: null,
            tool_calls: turn.toolCalls.map((t, i) => ({
              id: `call_${requests.length}_${i}`,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args) }
            }))
          }
        : turn.empty
          ? { role: 'assistant', content: null }
          : { role: 'assistant', content: turn.content ?? 'done' }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: turn.empty ? 'stop' : turn.toolCalls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests }))
  }) as unknown as { server: Server; url: string; requests: Array<Record<string, unknown>> }
}

class FakeBrowser {
  navigated: string[] = []
  constructor(
    private opts: { isPdf?: boolean; shot?: boolean; longText?: boolean; images?: Array<Record<string, unknown>> } = {}
  ) {}
  async navigate(url: string): Promise<{ url: string; title: string; isPdf: boolean }> {
    this.navigated.push(url)
    return { url, title: `Fake page: ${url}`, isPdf: this.opts.isPdf === true }
  }
  async read(): Promise<PageRead> {
    const text = this.opts.longText
      ? 'Cahokia was a large pre-Columbian settlement near the Mississippi. '.repeat(8)
      : 'Cahokia was a large pre-Columbian settlement.'
    return {
      url: this.navigated.at(-1) ?? '',
      title: 'fake',
      text,
      html: null,
      links: [],
      screenshotBase64: this.opts.shot ? 'ZmFrZS1zY3JlZW5zaG90LWRhdGE=' : null
    }
  }
  async collectImages(_minWidth?: number): Promise<Array<Record<string, unknown>>> {
    return (
      this.opts.images ?? [
        {
          provider: 'web',
          title: 'page photo',
          download_url: 'https://example.org/page-photo.jpg',
          media_type: 'image',
          license: 'unverified (editorial review required)'
        }
      ]
    )
  }
  scrollCalls: Array<{ direction: string; viewports?: number }> = []
  async scroll(opts: { direction: 'down' | 'up' | 'top' | 'bottom'; viewports?: number } = { direction: 'down' }): Promise<{
    url: string
    title: string
    scroll_y: number
    page_height: number
    viewport_height: number
    at_top: boolean
    at_bottom: boolean
    moved: boolean
  }> {
    this.scrollCalls.push({ direction: opts.direction, viewports: opts.viewports })
    const vh = 850
    const pageHeight = 4250 // 5 viewports tall
    const y =
      opts.direction === 'top' ? 0 : opts.direction === 'bottom' ? pageHeight - vh : Math.min(pageHeight - vh, (this.scrollCalls.filter((c) => c.direction === 'down').length) * vh)
    return {
      url: this.navigated.at(-1) ?? '',
      title: 'fake',
      scroll_y: y,
      page_height: pageHeight,
      viewport_height: vh,
      at_top: y <= 4,
      at_bottom: y >= pageHeight - vh - 4,
      moved: y > 0
    }
  }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeBridge {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  constructor(private opts: { pdfExtract?: boolean; videoSearch?: boolean } = {}) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>
    this.calls.push({ method, params: p })
    const rows = (p.rows ?? []) as Array<Record<string, unknown>>
    switch (method) {
      case 'ledger.append_sources': {
        const out = rows.map((r, i) => ({ ...r, source_id: `WEB-${String(i + 1).padStart(4, '0')}` }))
        return { count: out.length, rows: out }
      }
      case 'ledger.append_claims': {
        const out = rows.map((r, i) => ({ ...r, claim_id: `CLM-${String(i + 1).padStart(4, '0')}` }))
        return { count: out.length, rows: out }
      }
      case 'ledger.append_assets':
        return { count: rows.length, rows: rows.map((r, i) => ({ ...r, asset_id: `A-${String(i + 1).padStart(4, '0')}` })) }
      case 'extract.article':
        return this.opts.pdfExtract
          ? { ok: true, kind: 'pdf', chars: 800, path: 'research/article_text/x.txt', url: 'https://arxiv.org/pdf/1706.03762', preview: 'Attention is all you need…' }
          : { ok: true, kind: 'web', chars: 4200, path: 'research/article_text/x.txt', preview: 'Cahokia…' }
      case 'assets.save_screenshot':
        return { ok: true, path: 'media/screenshots/example.org_fake.jpg', asset_id: 'A-9999' }
      case 'web.research_fetch':
        return { downloaded: ((p.asset_ids as string[]) ?? []).length, failed: 0 }
      case 'ytdlp.search':
        return this.opts.videoSearch
          ? {
              count: 2,
              rows: [
                { title: 'Apollo 11 documentary', url: 'https://www.youtube.com/watch?v=abc', duration_s: 320 },
                { title: 'Apollo crew interview', url: 'https://www.youtube.com/watch?v=def', duration_s: 95 }
              ]
            }
          : {}
      case 'dwk.discover_sources':
        return { provider: 'crossref', count: 2, rows: [{ title: 'Study', url: 'https://journals.example/study' }] }
      case 'dwk.discover_media': {
        // Large result on purpose: exercises the journal's truncation path
        // (regression — compact() used to re-parse sliced JSON and crash).
        const bigRows = Array.from({ length: 60 }, (_, i) => ({
          provider: 'commons',
          title: `Mound photo ${i} with a reasonably long descriptive title for volume`,
          asset_page_url: `https://commons.wikimedia.org/wiki/File:Mound_${i}.jpg`,
          download_url: `https://upload.wikimedia.org/mound_${i}.jpg?utm_source=commons.wikimedia.org`,
          media_type: 'image',
          license: 'CC BY 4.0',
          creator: `Photographer ${i}`,
          notes: 'Verify item-page version, attribution, and all restrictions before use.'
        }))
        return { provider: 'commons', count: bigRows.length, rows: bigRows }
      }
      default:
        return {}
    }
  }
}

describe('Scout agent loop (mock provider)', () => {
  let ctx: { server: Server; url: string; requests: Array<Record<string, unknown>> } | null = null

  beforeAll(async () => {
    ctx = await Promise.resolve(
      startMockProvider([
        { toolCalls: [{ name: 'web_search', args: { query: 'cahokia mounds history' } }] },
        {
          toolCalls: [
            {
              name: 'register_sources',
              args: {
                rows: [
                  { title: 'Cahokia — Wikipedia', url: 'https://en.wikipedia.org/wiki/Cahokia', source_type: 'tertiary orientation only' },
                  { title: 'UNESCO Cahokia Mounds', url: 'https://whc.unesco.org/en/list/198/', source_type: 'primary' }
                ]
              }
            },
            {
              name: 'log_claims',
              args: {
                rows: [
                  {
                    claim_text: 'Cahokia was a large pre-Columbian settlement near the Mississippi River.',
                    source_id: 'WEB-0001',
                    locator: 'article lead',
                    confidence: 'high'
                  }
                ]
              }
            },
            {
              name: 'propose_media',
              args: {
                rows: [
                  {
                    provider: 'commons',
                    asset_page_url: 'https://commons.wikimedia.org/wiki/File:A.jpg',
                    download_url: 'https://upload.wikimedia.org/a.jpg',
                    media_type: 'image',
                    license: 'CC BY 4.0'
                  }
                ]
              }
            }
          ]
        },
        { toolCalls: [{ name: 'finish', args: { summary: 'Gathered 2 sources, 1 claim, 1 media candidate.' } }] }
      ])
    )
  })

  afterAll(() => {
    ctx?.server.close()
  })

  it('runs tools to finish, journals everything, and writes ledgers', async () => {
    const assert = ctx as unknown as { server: Server; url: string; requests: Array<Record<string, unknown>> }
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-test-'))
    const fakeBridge = new FakeBridge()
    const fakeBrowser = new FakeBrowser()
    const activities: Array<{ type: string; tool?: string }> = []
    const deps: ScoutDeps = {
      bridge: fakeBridge as unknown as import('../src/main/bridge').BridgeClient,
      browser: fakeBrowser as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: (a) => activities.push({ type: a.type, tool: a.tool })
    }
    const chat = new ChatClient({ baseUrl: assert.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('the lost city of Cahokia')

    expect(result.stoppedReason).toBe('finish')
    expect(result.summary).toContain('2 sources')
    expect(result.turns).toBe(3)
    expect(result.toolCalls).toBe(5) // 1 search + register + claims + propose + finish

    // tools hit the right bridge methods with sane payloads
    const methods = fakeBridge.calls.map((c) => c.method)
    expect(methods).toContain('ledger.append_sources')
    expect(methods).toContain('ledger.append_claims')
    expect(methods).toContain('ledger.append_assets')
    const claimCall = fakeBridge.calls.find((c) => c.method === 'ledger.append_claims')
    expect((claimCall!.params.rows as Array<Record<string, unknown>>)[0].locator).toBe('article lead')

    // web_search went through the (fake) browser via DDG-lite path
    expect(fakeBrowser.navigated[0]).toContain('duckduckgo.com')

    // activity feed saw tool calls and the done card
    expect(activities.filter((a) => a.type === 'tool_call').length).toBe(5)
    expect(activities.at(-1)?.type).toBe('done')

    // journal written to the project
    const journal = await readFile(join(projectPath, 'research', 'scout_sessions.jsonl'), 'utf-8')
    const lines = journal.trim().split('\n')
    // 5 tool calls + 5 results + 1 done + the per-type media guarantee entries
    // (the scripted run proposes an image, so the auto video AND audio phases fire)
    expect(lines.length).toBeGreaterThanOrEqual(12)
    expect(lines[0]).toContain('"tool_call"')
    expect(journal).toContain('auto_media_start')
  }, 20_000)
})

describe('Scout loop resilience — empty provider completions', () => {
  it('retries an empty completion and still finishes the run', async () => {
    // Regression: the ai-history run (2026-11-11) got one empty completion and
    // quit silently, mislabeled max_turns — zero sources, zero claims.
    const ctx = await Promise.resolve(
      startMockProvider([{ empty: true }, { toolCalls: [{ name: 'finish', args: { summary: 'done after retry' } }] }])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-empty-'))
    const deps: ScoutDeps = {
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser() as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('empty completion retry')
    expect(result.stoppedReason).toBe('finish')
    expect(result.turns).toBe(2)
    const journal = await readFile(join(projectPath, 'research', 'scout_sessions.jsonl'), 'utf-8')
    expect(journal).toContain('empty_completion')
    ctx.server.close()
  }, 20_000)

  it('stops honestly after three empty completions instead of faking max_turns', async () => {
    const ctx = await Promise.resolve(
      startMockProvider([{ empty: true }, { empty: true }, { empty: true }, { empty: true }])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-empty-abort-'))
    const deps: ScoutDeps = {
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser() as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('empty forever')
    expect(result.stoppedReason).toBe('message')
    expect(result.summary).toContain('empty completions')
    expect(result.summary).toContain('finish_reason=stop') // the abort explains WHY
    const journal = await readFile(join(projectPath, 'research', 'scout_sessions.jsonl'), 'utf-8')
    expect(journal).toContain('"attempt":3')
    ctx.server.close()
  }, 20_000)

  it('fails the run when the ledger ends with zero claims (R8 guarantee)', async () => {
    // Regression (2026-11-15, stock-market project): a 'finish' run over an
    // empty ledger set stage research_done and the Director designed an
    // evidence-free film. The claims guarantee must fail the job instead.
    class EmptyLedgerBridge extends FakeBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === 'ledger.digest') {
          return { source_urls: [], source_ids: [], claims: [], counts: { sources: 0, claims: 0, asset_candidates: 0 } }
        }
        return super.request(method, params)
      }
    }
    const ctx = await Promise.resolve(
      startMockProvider([{ toolCalls: [{ name: 'finish', args: { summary: 'found nothing writable' } }] }])
    )
    const deps: ScoutDeps = {
      bridge: new EmptyLedgerBridge() as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser() as unknown as ScoutBrowser,
      projectPath: mkdtempSync(join(tmpdir(), 'scout-noclaims-')),
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: deps.projectPath, maxTurns: 8 })
    await expect(runner.run('no claims scenario')).rejects.toThrow(/ZERO evidence claims/)
    ctx.server.close()
  }, 20_000)
})

describe('Scout per-type media guarantees — videos, audio, documents', () => {
  it('auto-proposes YouTube videos, audio twins, and read PDFs as document rows', async () => {
    const ctx = await Promise.resolve(
      startMockProvider([
        { toolCalls: [{ name: 'web_search', args: { query: 'apollo 11' } }] },
        { toolCalls: [{ name: 'extract_article', args: { url: 'https://arxiv.org/pdf/1706.03762' } }] },
        {
          toolCalls: [
            {
              name: 'propose_media',
              args: {
                rows: [
                  {
                    provider: 'web',
                    asset_page_url: 'https://example.org/apollo',
                    download_url: 'https://example.org/apollo.jpg',
                    media_type: 'image',
                    license: 'unverified (editorial review required)'
                  }
                ]
              }
            }
          ]
        },
        { toolCalls: [{ name: 'finish', args: { summary: 'ok' } }] }
      ])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-formats-'))
    const fakeBridge = new FakeBridge({ pdfExtract: true, videoSearch: true })
    const deps: ScoutDeps = {
      bridge: fakeBridge as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser() as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('the Apollo 11 moon landing')
    expect(result.stoppedReason).toBe('finish')

    const proposed = fakeBridge.calls
      .filter((c) => c.method === 'ledger.append_assets')
      .flatMap((c) => (c.params.rows ?? []) as Array<Record<string, unknown>>)
    // the model proposed an image; the runner must guarantee the other types
    expect(proposed.some((r) => r.media_type === 'image')).toBe(true)
    expect(proposed.some((r) => r.media_type === 'video')).toBe(true)
    expect(proposed.some((r) => r.media_type === 'audio')).toBe(true)
    expect(proposed.some((r) => r.media_type === 'document' && String(r.download_url).includes('arxiv'))).toBe(true)

    const journal = await readFile(join(projectPath, 'research', 'scout_sessions.jsonl'), 'utf-8')
    expect(journal).toContain('"source":"audio"')
    expect(journal).toContain('"source":"documents"')
    // research-time fetch pulled the proposed files onto disk
    const fetchCall = fakeBridge.calls.find((c) => c.method === 'web.research_fetch')
    expect(fetchCall).toBeTruthy()
    expect(((fetchCall!.params.asset_ids as string[]) ?? []).length).toBeGreaterThan(0)
    ctx.server.close()
  }, 20_000)
})

describe('Scout research-time capture — PDFs and screenshots', () => {
  it('auto-extracts PDF text on browser_open and proposes the PDF as a document', async () => {
    // Regression: Edge's PDF viewer has no DOM text — browser_read returned
    // 0k chars on turing.pdf and the run wasted turns (user report 2026-11-12).
    const ctx = await Promise.resolve(
      startMockProvider([
        { toolCalls: [{ name: 'browser_open', args: { url: 'https://courses.cs.umbc.edu/471/papers/turing.pdf' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'pdf read' } }] }
      ])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-pdf-'))
    const fakeBridge = new FakeBridge({ pdfExtract: true })
    const deps: ScoutDeps = {
      bridge: fakeBridge as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser({ isPdf: true }) as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('the Turing 1936 paper')
    expect(result.stoppedReason).toBe('finish')

    const extract = fakeBridge.calls.find((c) => c.method === 'extract.article')
    expect(extract).toBeTruthy()
    expect(String(extract!.params.url)).toContain('turing.pdf')

    const proposed = fakeBridge.calls
      .filter((c) => c.method === 'ledger.append_assets')
      .flatMap((c) => (c.params.rows ?? []) as Array<Record<string, unknown>>)
    expect(proposed.some((r) => r.media_type === 'document' && String(r.download_url).includes('turing.pdf'))).toBe(true)

    const fetchCall = fakeBridge.calls.find((c) => c.method === 'web.research_fetch')
    expect(fetchCall).toBeTruthy()
    ctx.server.close()
  }, 20_000)

  it('saves a screenshot of every meaningful page read', async () => {
    const ctx = await Promise.resolve(
      startMockProvider([
        { toolCalls: [{ name: 'browser_open', args: { url: 'https://example.org/cahokia' } }] },
        { toolCalls: [{ name: 'browser_read', args: {} }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'read and shot' } }] }
      ])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-shot-'))
    const fakeBridge = new FakeBridge()
    const deps: ScoutDeps = {
      bridge: fakeBridge as unknown as import('../src/main/bridge').BridgeClient,
      browser: new FakeBrowser({ shot: true, longText: true }) as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: () => {}
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('Cahokia mounds')
    expect(result.stoppedReason).toBe('finish')
    const shot = fakeBridge.calls.find((c) => c.method === 'assets.save_screenshot')
    expect(shot).toBeTruthy()
    expect(shot!.params.url).toBe('https://example.org/cahokia')
    expect(String(shot!.params.jpeg_base64)).not.toBe('')
    // the page's own images were auto-proposed and routed to the research fetch
    const autoRows = fakeBridge.calls
      .filter((c) => c.method === 'ledger.append_assets')
      .flatMap((c) => (c.params.rows ?? []) as Array<Record<string, unknown>>)
    expect(autoRows.some((r) => String(r.download_url) === 'https://example.org/page-photo.jpg')).toBe(true)
    const fetchCall = fakeBridge.calls.find((c) => c.method === 'web.research_fetch')
    expect(fetchCall).toBeTruthy()
    expect(((fetchCall!.params.asset_ids as string[]) ?? []).length).toBeGreaterThanOrEqual(1)
    ctx.server.close()
  }, 20_000)

  it('browser_scroll repositions the viewport so reads below the fold are possible', async () => {
    // Regression: every read screenshot was the page top — deep reads and the
    // auto image harvest reset scroll to 0, and no scroll tool existed, so the
    // model kept re-reading the header (user report 2026-11-16).
    const ctx = await Promise.resolve(
      startMockProvider([
        { toolCalls: [{ name: 'browser_open', args: { url: 'https://example.org/long-article' } }] },
        { toolCalls: [{ name: 'browser_scroll', args: { direction: 'down', viewports: 2 } }] },
        { toolCalls: [{ name: 'browser_scroll', args: { direction: 'bottom' } }] },
        { toolCalls: [{ name: 'browser_read', args: {} }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'mid-page read' } }] }
      ])
    )
    const projectPath = mkdtempSync(join(tmpdir(), 'scout-scroll-'))
    const fakeBridge = new FakeBridge()
    const fakeBrowser = new FakeBrowser({ shot: true, longText: true })
    const activities: Array<{ type: string; tool?: string; summary?: string }> = []
    const deps: ScoutDeps = {
      bridge: fakeBridge as unknown as import('../src/main/bridge').BridgeClient,
      browser: fakeBrowser as unknown as ScoutBrowser,
      projectPath,
      tavilyKey: null,
      visited: [],
      emit: (a) => activities.push(a)
    }
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'test-key', model: 'mock-model', timeoutMs: 5000 })
    const runner = new ScoutRunner({ chat, deps, dwkRoot: projectPath, maxTurns: 8 })
    const result = await runner.run('a long article')
    expect(result.stoppedReason).toBe('finish')

    expect(fakeBrowser.scrollCalls).toEqual([
      { direction: 'down', viewports: 2 },
      { direction: 'bottom', viewports: undefined }
    ])
    // the activity feed shows the position line so the model learns where it is
    const scrollSummaries = activities
      .filter((a) => a.type === 'tool_result' && a.tool === 'browser_scroll')
      .map((a) => String(a.summary))
    expect(scrollSummaries[0]).toContain('scrolled to 850/4250px')
    expect(scrollSummaries[1]).toContain('scrolled to 3400/4250px')
    expect(scrollSummaries[1]).toContain('[bottom]')
    // and the journal keeps the full position rows
    const journal = await readFile(join(projectPath, 'research', 'scout_sessions.jsonl'), 'utf-8')
    expect(journal).toContain('"tool":"browser_scroll"')
    expect(journal).toContain('"scroll_y":3400')
    ctx.server.close()
  }, 20_000)
})
