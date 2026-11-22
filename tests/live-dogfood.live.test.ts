import { describe, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatClient } from '../src/main/agent/chat'
import { DirectorRunner } from '../src/main/agent/director'
import { ProducerPipeline, type ProducerDeps } from '../src/main/producer/pipeline'

/**
 * LIVE dogfood harness (M5 exit demo, not a CI test): continues a REAL
 * project — Director designs from the actual evidence, Producer renders and
 * packages. Run through scripts/live-key-bridge.js (injects VT_* provider
 * env) with VENDOTUBE_DOGFOOD=1 and VT_PROJECT=<existing project folder>.
 * Gates are auto-approved INSIDE the harness (disclosed in the log) — this
 * run measures the pipeline on real content.
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

describe('LIVE dogfood run (M5 exit demo)', () => {
  it('directs and produces the real project end-to-end', async () => {
    const baseUrl = process.env.VT_BASE_URL
    const model = process.env.VT_MODEL
    const apiKey = process.env.VT_KEY
    if (!baseUrl || !model || !apiKey || process.env.VENDOTUBE_DOGFOOD !== '1') {
      console.warn('[dogfood] VT_* env or VENDOTUBE_DOGFOOD missing — skipping (driver only)')
      return
    }
    const projectPath =
      process.env.VT_PROJECT || join(homedir(), 'OneDrive', 'Documents', 'VendoTube Studio', 'dogfood')
    if (!existsSync(join(projectPath, 'project.yml'))) {
      throw new Error(`not a documentary project: ${projectPath}`)
    }
    const quality = process.env.VT_QUALITY === 'standard' ? 'standard' : 'draft'
    const dwkRoot = resolve(process.cwd(), '..', 'documentary_workflow_kit', 'documentary_workflow_kit')
    const bridge = new LiveBridge()
    const t0 = Date.now()
    const since = (): string => `[t+${Math.round((Date.now() - t0) / 1000)}s]`
    try {
      const ping = (await bridge.request('sys.ping', undefined, 60_000)) as { ok?: boolean; dwk_loaded?: boolean }
      console.log(`[dogfood] ${since()} bridge ok=${ping.ok} dwk=${ping.dwk_loaded} | provider=${model} @ ${baseUrl} | quality=${quality}`)

      // ---- Director: design the film from the REAL evidence ----------------
      const voice = 'en-US-AndrewMultilingualNeural'
      const director = new DirectorRunner({
        // 16384 + reasoningEffort match the app's Settings default
        // (src/main/index.ts): a free-reasoning model can burn the whole
        // budget on hidden reasoning and answer with nothing
        // (finish_reason=length, no content).
        chat: new ChatClient({ baseUrl, apiKey, model, maxTokens: 16384, reasoningEffort: 'low' }),
        dwkRoot,
        maxTurns: 26,
        deps: {
          bridge: bridge as unknown as ConstructorParameters<typeof DirectorRunner>[0]['deps']['bridge'],
          projectPath,
          voice,
          revisionNotes: null,
          emit: (a) => console.log(`[director] ${a.type}${a.tool ? ` ${a.tool}` : ''}: ${a.summary ?? ''}`.slice(0, 240))
        }
      })
      const dT = Date.now()
      const dRes = await director.run()
      console.log(`[dogfood] ${since()} director done: turns=${dRes.turns} stopped=${dRes.stoppedReason} (${Math.round((Date.now() - dT) / 1000)}s)`)
      console.log(`[dogfood] director summary: ${dRes.summary.slice(0, 400)}`)

      const report = (await bridge.request('dwk.validate_project', { project_path: projectPath }, 120_000)) as {
        valid?: boolean
        errors?: string[]
      }
      console.log(`[dogfood] ${since()} dwk validate: valid=${report.valid} errors=${(report.errors ?? []).length}`)

      // ---- Producer: narrate → compose → render → QC → conform → package ---
      const pipeline = new ProducerPipeline({
        bridge: bridge as unknown as ProducerDeps['bridge'],
        projectPath,
        defaultVoice: voice,
        qualityOverride: quality,
        setProgress: (phase, pct) => console.log(`[producer] ${since()} ${phase}${pct !== undefined ? ` (${pct}%)` : ''}`),
        emit: (a) => console.log(`[producer] ${a.type}${a.tool ? ` ${a.tool}` : ''}: ${a.summary ?? ''}`.slice(0, 240)),
        throwIfCancelled: () => undefined,
        gate: async (gate, summary) => {
          console.log(`[dogfood] gate ${gate} AUTO-APPROVED (harness): ${summary}`)
          return true
        }
      })
      const pT = Date.now()
      const pRes = await pipeline.run()
      console.log(`[dogfood] ${since()} producer: ${pRes.status} (${Math.round((Date.now() - pT) / 1000)}s)`)
      console.log(`[dogfood] producer summary: ${pRes.summary}`)

      // ---- Timing record (for docs/METRICS.md) -----------------------------
      const record = {
        project: projectPath,
        subject: 'Dogfood (2021 short film, Vincent D’Alessandro)',
        provider: `${model} @ ${baseUrl}`,
        quality,
        directorSeconds: Math.round((Date.now() - dT) / 1000),
        producerSeconds: Math.round((Date.now() - pT) / 1000),
        totalSeconds: Math.round((Date.now() - t0) / 1000),
        producedAt: new Date().toISOString(),
        result: pRes
      }
      writeFileSync(join(projectPath, 'qc', 'dogfood_run.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
      console.log(`[dogfood] TIMING RECORD: ${JSON.stringify({ director: record.directorSeconds, producer: record.producerSeconds, total: record.totalSeconds, quality })}`)
    } finally {
      bridge.close()
    }
  }, 5_400_000)
})
