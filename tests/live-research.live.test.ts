import { describe, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatClient } from '../src/main/agent/chat'
import { ScoutRunner } from '../src/main/agent/scout'
import type { ScoutActivity, ScoutDeps } from '../src/main/agent/tools'
import { ScoutBrowser } from '../src/main/browser/scoutBrowser'

/**
 * LIVE research harness (not a CI test — run via the python driver, which
 * injects the provider config through VT_* env vars and skips cleanly when
 * they are absent). Drives the app's own Scout stack end-to-end: real
 * provider, real bridge, VISIBLE Edge browser, real downloads — so the
 * "does it fetch everything?" question is answered against reality.
 */

class LiveBridge {
  private readonly proc = spawn('python', ['bridge/server.py'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  private buf = ''
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor() {
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk
      let idx: number
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { id?: number; error?: { message?: string }; result?: unknown }
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message ?? 'bridge error'))
            else p.resolve(msg.result)
          }
        } catch {
          // ignore non-JSON noise
        }
      }
    })
    this.proc.stderr!.on('data', (c: string) => process.stdout.write(`[bridge] ${c}`))
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 600_000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectP(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolveP(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rejectP(e)
        }
      })
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
    })
  }

  close(): void {
    try {
      this.proc.stdin!.end()
    } catch {
      /* already gone */
    }
  }
}

describe('LIVE research run (user-driven verification)', () => {
  it('researches a fresh topic end-to-end: articles, images, videos, audio, documents, screenshots, downloads', async () => {
    const baseUrl = process.env.VT_BASE_URL
    const model = process.env.VT_MODEL
    const apiKey = process.env.VT_KEY
    if (!baseUrl || !model || !apiKey) {
      console.warn('[live] VT_* provider env missing — skipping (driver only)')
      return
    }

    const dwkRoot = resolve(process.cwd(), '..', 'documentary_workflow_kit', 'documentary_workflow_kit')
    const topic = process.env.VT_TOPIC || 'the history of the Concorde supersonic airliner'
    const slug =
      topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .split('-')
        .slice(0, 3)
        .join('-') || 'live'
    const projectRoot = join(homedir(), 'OneDrive', 'Documents', 'VendoTube Studio')
    const projectName = `${slug}-live-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
    const projectPath = join(projectRoot, projectName)
    const bridge = new LiveBridge()
    const browser = new ScoutBrowser('msedge', false) // headed — the user watches Scout work
    try {
      const ping = (await bridge.request('sys.ping', undefined, 60_000)) as { ok?: boolean; dwk_loaded?: boolean }
      console.log(`[live] bridge ping ok=${ping.ok} dwk_loaded=${ping.dwk_loaded}`)
      await bridge.request(
        'dwk.init_project',
        { path: projectPath, title: `${topic} (live research)`, fps: 30, runtime: 600, language: 'en' },
        120_000
      )
      console.log(`[live] project: ${projectPath}`)
      console.log(`[live] provider: ${model} @ ${baseUrl}`)

      const visited: string[] = []
      const emit = (a: ScoutActivity): void => {
        if (a.type === 'tool_call') console.log(`[scout] > ${a.tool} ${JSON.stringify(a.args).slice(0, 160)}`)
        else if (a.type === 'tool_result') console.log(`[scout]   ${a.tool}: ${a.summary}`)
        else if (a.type === 'page') console.log(`[scout] page: ${a.summary}`)
        else if (a.type === 'message') console.log(`[scout] ${a.summary}`)
        else if (a.type === 'error') console.log(`[scout] !! ${a.summary}`)
        else if (a.type === 'done') console.log(`[scout] done: ${a.summary}`)
      }
      const deps: ScoutDeps = {
        bridge: bridge as unknown as ScoutDeps['bridge'],
        browser,
        projectPath,
        tavilyKey: null,
        visited,
        emit
      }
      const chat = new ChatClient({ baseUrl, apiKey, model })
      const runner = new ScoutRunner({ chat, deps, dwkRoot })
      const result = await runner.run(topic)
      console.log(`[live] run: ${JSON.stringify(result)}`)

      // The bridge is single-threaded: a still-running download blocks these
      // calls. Report what we can with short timeouts, then leave disk truth.
      const listKind = async (kind: string): Promise<void> => {
        try {
          const res = (await bridge.request('ledger.list', { project_path: projectPath, kind }, 15_000)) as {
            rows?: Array<Record<string, unknown>>
          }
          const rows = res.rows ?? []
          console.log(`[live] ledger ${kind}: ${rows.length} row(s)`)
          for (const r of rows.slice(0, kind === 'downloaded' ? 40 : 10)) {
            const brief =
              kind === 'downloaded'
                ? `${r.saved_path} (${r.bytes}B)`
                : kind === 'assets'
                  ? `${r.asset_id} ${r.media_type} review=${r.rights_status} :: ${String(r.title).slice(0, 60)}`
                  : kind === 'sources'
                    ? `${r.source_id} :: ${String(r.title).slice(0, 70)}`
                    : `${r.claim_id} [${r.source_id}] :: ${String(r.claim_text).slice(0, 80)}`
            console.log(`   - ${brief}`)
          }
        } catch {
          console.log(`[live] ledger ${kind}: bridge busy (download still running) — check the project folder`)
        }
      }
      for (const kind of ['sources', 'evidence', 'assets', 'downloaded'] as const) await listKind(kind)
      for (const folder of ['media/web', 'media/video', 'media/audio', 'media/images', 'media/screenshots', 'research/article_text']) {
        const abs = join(projectPath, ...folder.split('/'))
        const files = existsSync(abs) ? readdirSync(abs) : []
        console.log(`[live] ${folder}: ${files.length} file(s) ${files.map((f) => f.slice(0, 48)).join(' | ').slice(0, 400)}`)
      }
    } finally {
      await browser.close().catch(() => undefined)
      bridge.close()
    }
  }, 1_800_000)
})
