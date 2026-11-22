import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTool } from './chat'
import type { ScoutBrowser } from '../browser/scoutBrowser'
import type { BridgeClient } from '../bridge'

/**
 * Scout's tool catalog (AGENT-SPEC §3, Scout column). Schemas are exposed to
 * the LLM; handlers execute against the Studio Bridge + Scout browser.
 * Side-effect classes: register/log/propose write review-state CSV rows only
 * (auditable, no network side effects) — downloads are NEVER agent tools;
 * they run behind the user gates G-B/G-C in the UI.
 */

export interface ScoutActivity {
  type: 'tool_call' | 'tool_result' | 'page' | 'message' | 'error' | 'done'
  tool?: string
  args?: unknown
  summary?: string
  imageBase64?: string | null
  at: string
}

export interface ScoutDeps {
  bridge: BridgeClient
  browser: ScoutBrowser
  projectPath: string
  tavilyKey: string | null
  /** Pages visited this run (most recent last) — used by the auto media phase. */
  visited: string[]
  emit: (activity: ScoutActivity) => void
}

export const scoutToolSchemas: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web. Returns a ranked list of {title, url}. Prefer specific queries; run several narrow searches rather than one broad one.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10, default: 8 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a URL in the visible local browser window. Returns the final URL and page title.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read',
      description:
        'Read the current page in the visible browser. The screenshot captures the CURRENT viewport only — use browser_scroll first to reach a specific section. deep:true scrolls through the ENTIRE page first (loads lazy content) and returns up to 60k chars of text — use it for robots-blocked or JS-heavy pages. html:true additionally returns the cleaned page HTML (scripts/styles stripped). screenshot:true adds a visual capture.',
      parameters: {
        type: 'object',
        properties: {
          deep: { type: 'boolean', default: false, description: 'scroll the whole page and extract extended text' },
          html: { type: 'boolean', default: false, description: 'also return cleaned HTML of the page' },
          screenshot: { type: 'boolean', default: false }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description:
        'Scroll the visible browser page. The browser_read screenshot captures the current viewport, so scroll first to capture the middle or bottom of a long page (article body, exhibits, footers are often below the fold). Returns the new position (scroll_y / page_height / at_top / at_bottom) so you know where you are and when to stop.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'scroll direction; top/bottom jump straight to the ends' },
          viewports: { type: 'integer', minimum: 1, maximum: 10, default: 1, description: 'how many screen-heights to move (down/up only)' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_article',
      description:
        'Robots-aware server-side extraction of clean article/PDF text for a URL into research/article_text/. Refuses robots-disallowed URLs. On timeout or robots-refusal, fall back to browser_open + browser_read for the same page instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          source_id: { type: 'string', description: 'existing source id (e.g. WEB-0001) to file the text under' },
          title: { type: 'string' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'discover_scholar',
      description: 'Find scholarly (Crossref) or Wikipedia orientation sources for a query. Returns metadata rows you can register.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          provider: { type: 'string', enum: ['crossref', 'wikipedia'], default: 'crossref' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'discover_media',
      description:
        'Find candidate images/video/audio in open collections (Wikimedia Commons, Library of Congress, Internet Archive). Rows include license metadata; discovery is NOT clearance.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          provider: { type: 'string', enum: ['commons', 'loc', 'archive'], default: 'commons' },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'register_sources',
      description: 'Register source rows (deduped by URL) into research/sources.csv. Provide title, url, and source_type (primary | secondary | tertiary orientation only).',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                source_type: { type: 'string' },
                creator_or_publisher: { type: 'string' },
                published_date: { type: 'string' },
                notes: { type: 'string' }
              },
              required: ['title', 'url']
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
      name: 'log_claims',
      description:
        'Append checkable factual claims to the evidence ledger. Every claim needs the source_id it came from and a locator (page/section/timecode). Copy exact support quotes where possible; set confidence honestly.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                claim_text: { type: 'string' },
                source_id: { type: 'string' },
                locator: { type: 'string' },
                exact_support_or_quote: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                caveat: { type: 'string' }
              },
              required: ['claim_text', 'source_id', 'locator']
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
      name: 'propose_media',
      description:
        'Propose discovered media rows as download candidates (rights_status=review). The USER reviews item pages and approves rights — never claim clearance yourself.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                title: { type: 'string' },
                asset_page_url: { type: 'string' },
                download_url: { type: 'string' },
                filename: { type: 'string' },
                media_type: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
                license: { type: 'string' },
                license_url: { type: 'string' },
                creator: { type: 'string' },
                source_id: { type: 'string' }
              },
              required: ['provider', 'asset_page_url', 'download_url', 'media_type', 'license']
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
      name: 'search_videos',
      description:
        'Search YouTube for relevant videos (via yt-dlp, no download). Returns {title, url, duration_s} rows ready to pass into propose_media (media_type=video, provider=youtube).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10, default: 6 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'harvest_page_media',
      description:
        'Collect the meaningful images on the CURRENT page (after browser_open) as ready-to-propose media rows (provider=web, license unverified). Curate: propose only the 2-4 most story-relevant images via propose_media — key moments, products, people, factories.',
      parameters: {
        type: 'object',
        properties: {
          min_width: { type: 'integer', default: 380, description: 'ignore images narrower than this' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the research task with an honest summary of what was gathered and what is still missing.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary']
      }
    }
  }
]

// ------------------------------------------------------------ search impls

interface SearchHit {
  title: string
  url: string
}

async function tavilySearch(key: string, query: string, limit: number): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`tavily ${res.status}`)
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string }> }
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? r.url ?? '', url: r.url as string }))
    .slice(0, limit)
}

async function ddgLiteSearch(browser: ScoutBrowser, query: string, limit: number): Promise<SearchHit[]> {
  await browser.navigate(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`)
  const read = await browser.read()
  const hits: SearchHit[] = []
  for (const link of read.links) {
    try {
      let url = link.href
      const u = new URL(url)
      // DDG lite wraps every result in a redirect link: /l/?uddg=<encoded real url>
      if (u.hostname.endsWith('duckduckgo.com')) {
        const uddg = u.searchParams.get('uddg')
        if (!uddg) continue
        url = uddg
      }
      const target = new URL(url)
      if (target.protocol !== 'https:' && target.protocol !== 'http:') continue
      hits.push({ title: link.text, url: target.toString() })
    } catch {
      continue
    }
    if (hits.length >= limit) break
  }
  return hits
}

// ---------------------------------------------------------------- handlers

export function createScoutHandlers(deps: ScoutDeps): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const { bridge, browser, projectPath, tavilyKey } = deps
  let discoverCalls = 0 // per-run rate limit: weak models spam discovery

  return {
    web_search: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is required')
      const limit = Math.min(Number(args.limit ?? 8) || 8, 10)
      if (tavilyKey) return tavilySearch(tavilyKey, query, limit)
      return ddgLiteSearch(browser, query, limit)
    },

    browser_open: async (args) => {
      const url = String(args.url ?? '')
      const nav = await browser.navigate(url)
      if (!deps.visited.includes(nav.url)) deps.visited.push(nav.url)
      deps.emit({ type: 'page', summary: `${nav.title || nav.url}`, at: new Date().toISOString() })
      if (nav.isPdf) {
        // Edge's PDF viewer has no extractable DOM text — pull the file
        // server-side (robots-aware, pypdf) and hand Scout the actual text so
        // the turn isn't wasted.
        const res = (await bridge.request('extract.article', {
          project_path: projectPath,
          url: nav.url,
          title: nav.title || undefined
        })) as { ok?: boolean; reason?: string; chars?: number; path?: string; preview?: string }
        if (res.ok) {
          return {
            ...nav,
            note: `PDF detected — the in-browser viewer has no text, so it was extracted server-side instead: ${res.chars} chars saved to ${res.path}. Register this URL as a source and take claims from this text.`,
            pdf_text_preview: res.preview,
            pdf_chars: res.chars,
            pdf_path: res.path
          }
        }
        return {
          ...nav,
          note: `PDF detected but server-side extraction failed (${res.reason ?? 'error'}). If robots-refused, read what you can visually and say so honestly.`
        }
      }
      return nav
    },

    browser_scroll: async (args) => {
      const direction = String(args.direction ?? 'down')
      if (!['down', 'up', 'top', 'bottom'].includes(direction)) throw new Error(`direction must be down|up|top|bottom, got ${direction}`)
      return browser.scroll({
        direction: direction as 'down' | 'up' | 'top' | 'bottom',
        viewports: args.viewports === undefined ? undefined : Math.max(1, Math.min(Number(args.viewports) || 1, 10))
      })
    },

    browser_read: async (args) => {
      // Screenshot every read: key-page captures are film material (saved via
      // assets.save_screenshot) and the user watches Scout work in the UI.
      const read = await browser.read({
        screenshot: true,
        deep: args.deep === true,
        html: args.html === true
      })
      if (read.screenshotBase64) {
        deps.emit({ type: 'page', summary: `read: ${read.title || read.url}`, imageBase64: read.screenshotBase64, at: new Date().toISOString() })
      }
      const meaningfulPage = read.text.trim().length >= 200
      let screenshotSaved: string | null = null
      if (read.screenshotBase64 && meaningfulPage) {
        try {
          const res = (await bridge.request('assets.save_screenshot', {
            project_path: projectPath,
            url: read.url,
            title: read.title,
            jpeg_base64: read.screenshotBase64
          })) as { path?: string }
          screenshotSaved = res.path ?? null
        } catch (err) {
          deps.emit({
            type: 'error',
            summary: `screenshot save failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
            at: new Date().toISOString()
          })
        }
      }
      if (read.text.trim().length >= 2000) {
        // Persist substantial reads as article snapshots — the project keeps a
        // .txt of every source even when the model skips extract_article.
        try {
          const host = new URL(read.url).hostname.replace(/^www\./, '')
          const slug = `${host}_${read.title || 'page'}`
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || 'page'
          const dir = join(projectPath, 'research', 'article_text')
          mkdirSync(dir, { recursive: true })
          writeFileSync(
            join(dir, `read_${slug}_${Date.now()}.txt`),
            `TITLE: ${read.title}\nURL: ${read.url}\nCAPTURED: ${new Date().toISOString()}\n\n${read.text}\n`,
            'utf-8'
          )
        } catch {
          // snapshot is best-effort — never break the read
        }
      }
      // Auto page-image harvest: the images ON the article pages are film
      // material — propose the top ones without waiting for the model to ask.
      let autoProposedImages: Array<Record<string, unknown>> = []
      let autoImageNote: string | undefined
      if (meaningfulPage) {
        try {
          const imgs = (await browser.collectImages(420)) as Array<Record<string, unknown>>
          const picked = Array.isArray(imgs) ? imgs.slice(0, 4) : []
          if (picked.length > 0) {
            const res = (await bridge.request('ledger.append_assets', {
              project_path: projectPath,
              rows: picked
            })) as { count?: number; rows?: Array<Record<string, unknown>> }
            autoProposedImages = Array.isArray(res.rows) ? res.rows : []
            autoImageNote = `${res.count ?? 0} page image(s) auto-proposed from this page (top ${picked.length} ≥420px) — do not propose these again`
          }
        } catch (err) {
          autoImageNote = `page image harvest failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 140)
        }
      }
      const emptyNote = read.challenge
        ? ' — verification/challenge page (Cloudflare or similar): its checkbox was clicked once; it did not clear, so try another source.'
        : read.text.trim().length < 200
          ? ' — page returned almost no text (PDF viewer or JS-only app). For PDF URLs call extract_article instead; for JS pages retry with deep:true.'
          : ''
      return {
        url: read.url,
        title: read.title,
        text: read.text,
        ...(read.html ? { html: read.html } : {}),
        links: read.links,
        screenshot: screenshotSaved
          ? `(screenshot of the key part saved to ${screenshotSaved})`
          : read.screenshotBase64
            ? `(screenshot captured, not saved — page had too little text)`
            : null,
        note: emptyNote || undefined,
        ...(autoImageNote ? { auto_images: autoImageNote } : {}),
        ...(autoProposedImages.length > 0 ? { auto_proposed_images: autoProposedImages } : {})
      }
    },

    extract_article: async (args) => {
      const res = (await bridge.request('extract.article', {
        project_path: projectPath,
        url: String(args.url ?? ''),
        source_id: args.source_id ? String(args.source_id) : undefined,
        title: args.title ? String(args.title) : undefined
      })) as { ok?: boolean; reason?: string; chars?: number; path?: string }
      return res
    },

    discover_scholar: async (args) => {
      return bridge.request('dwk.discover_sources', {
        project_path: projectPath,
        query: String(args.query ?? ''),
        provider: args.provider ? String(args.provider) : 'crossref',
        limit: Math.min(Number(args.limit ?? 8) || 8, 20)
      })
    },

    discover_media: async (args) => {
      if (discoverCalls >= 3) {
        throw new Error('discover_media limit reached (3 per run) — propose what you have and move to the next phase')
      }
      discoverCalls++
      return bridge.request('dwk.discover_media', {
        project_path: projectPath,
        query: String(args.query ?? ''),
        provider: args.provider ? String(args.provider) : 'commons',
        limit: Math.min(Number(args.limit ?? 10) || 10, 25)
      })
    },

    register_sources: async (args) => {
      const rows = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : []
      if (!rows.length) throw new Error('rows is required')
      return bridge.request('ledger.append_sources', { project_path: projectPath, rows })
    },

    log_claims: async (args) => {
      const rows = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : []
      if (!rows.length) throw new Error('rows is required')
      return bridge.request('ledger.append_claims', { project_path: projectPath, rows })
    },

    propose_media: async (args) => {
      const rows = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : []
      if (!rows.length) throw new Error('rows is required')
      return bridge.request('ledger.append_assets', { project_path: projectPath, rows })
    },

    harvest_page_media: async (args) => {
      const minWidth = Math.max(200, Math.min(Number(args.min_width ?? 380) || 380, 1200))
      return browser.collectImages(minWidth)
    },

    search_videos: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is required')
      const limit = Math.max(1, Math.min(Number(args.limit ?? 6) || 6, 10))
      const res = (await bridge.request('ytdlp.search', { query, limit })) as {
        count: number
        rows: Array<{ title: string; url: string; duration_s?: number | null }>
      }
      // Shape rows so Scout can pass them straight into propose_media.
      return {
        count: res.count,
        rows: res.rows.map((r) => ({
          provider: 'youtube',
          title: r.title,
          asset_page_url: r.url,
          download_url: r.url,
          media_type: 'video',
          duration_s: r.duration_s ?? undefined,
          license: 'unverified (editorial review required)',
          notes: `YouTube search result${r.duration_s ? ` (${Math.round(r.duration_s)}s)` : ''}; editorial rights review required`
        }))
      }
    },

    finish: async (args) => ({ done: true, summary: String(args.summary ?? 'Research finished.') })
  }
}
