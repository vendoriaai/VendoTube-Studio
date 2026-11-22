import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { lowerProcessPriority } from './proc-priority'
import {
  encodeRequest,
  isResponse,
  parseFrame,
  RpcErrorCode
} from '@shared/bridge-protocol'
import type { BridgePingResult, BridgePathsResult, ValidationSummary, TtsVoice, TtsGenerateResult, SrtValidation } from '@shared/ipc'

/**
 * BridgeClient — supervises the Python Studio Bridge sidecar (JSON-RPC over
 * stdio, TAD §5): spawn, request/response with timeouts, crash restart with
 * backoff, and stderr log capture.
 */

export type BridgeStatus = 'stopped' | 'starting' | 'ready' | 'down'

interface BridgeEvents {
  status: (status: BridgeStatus, detail?: string) => void
  log: (line: [string]) => void
}

export class BridgeClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private statusValue: BridgeStatus = 'stopped'
  private statusDetail: string | null = null
  private pingCache: BridgePingResult | null = null
  private fastFailCount = 0
  private stopping = false
  readonly logLines: string[] = []

  constructor(
    private readonly resolvePython: () => string,
    private readonly resolveScript: () => string,
    private readonly resolveEnv: () => NodeJS.ProcessEnv,
    /**
     * When truthy (evaluated at spawn), the python bridge runs BELOW_NORMAL —
     * its ffmpeg/ffprobe/yt-dlp children inherit the class, so loudness/QC/
     * concat passes never starve the user's own apps (setting `render.priority`).
     */
    private readonly resolveLowPriority: (() => boolean) | boolean = false
  ) {
    super()
  }

  get status(): BridgeStatus {
    return this.statusValue
  }

  get lastDetail(): string | null {
    return this.statusDetail
  }

  get lastPing(): BridgePingResult | null {
    return this.pingCache
  }

  on<K extends keyof BridgeEvents>(event: K, listener: BridgeEvents[K]): this {
    return super.on(event, listener) as this
  }

  emit<K extends keyof BridgeEvents>(event: K, ...args: Parameters<BridgeEvents[K]>): boolean {
    return super.emit(event, ...args)
  }

  start(): void {
    if (this.stopping || this.child) return
    this.stopping = false
    this.setStatus('starting')
    const python = this.resolvePython()
    const script = this.resolveScript()
    if (!existsSync(script)) {
      this.setStatus('down', `bridge script not found: ${script}`)
      return
    }
    try {
      this.child = spawn(python, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // UTF-8 stdio on Windows (locale codecs like cp1252 crash on Unicode
        // research content); server.py also reconfigures its own streams.
        env: { ...this.resolveEnv(), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true
      })
    } catch (err) {
      this.setStatus('down', err instanceof Error ? err.message : String(err))
      return
    }
    // Background priority (setting render.priority): best-effort one-shot after
    // a successful spawn — the whole bridge tree inherits the priority class.
    if (typeof this.resolveLowPriority === 'function' ? this.resolveLowPriority() : this.resolveLowPriority) {
      lowerProcessPriority(this.child.pid)
    }
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        this.logLines.push(trimmed)
        if (this.logLines.length > 400) this.logLines.shift()
        this.emit('log', [trimmed])
      }
    })
    this.child.on('error', (err) => {
      this.setStatus('down', `spawn failed (${err.message}); python='${python}'`)
    })
    this.child.on('exit', (code, signal) => {
      this.child = null
      this.rejectAllPending(new Error(`bridge exited (code=${code}, signal=${signal})`))
      if (this.stopping) {
        this.setStatus('stopped')
        return
      }
      this.fastFailCount++
      this.setStatus('down', `bridge exited (code=${code}, signal=${signal})`)
      if (this.fastFailCount <= 5) {
        setTimeout(() => this.start(), Math.min(1000 * this.fastFailCount, 5000))
      }
    })
    // Readiness probe: first successful ping flips status to ready.
    void this.ping()
      .then((pong) => {
        this.fastFailCount = 0
        this.pingCache = pong
        this.setStatus('ready')
      })
      .catch((err: Error) => {
        this.setStatus('down', err.message)
      })
  }

  stop(): void {
    this.stopping = true
    this.rejectAllPending(new Error('bridge stopping'))
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    this.setStatus('stopped')
  }

  dispose(): void {
    this.stop()
    this.removeAllListeners()
  }

  private setStatus(status: BridgeStatus, detail?: string): void {
    this.statusValue = status
    this.statusDetail = detail ?? null
    this.emit('status', status, detail)
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  private handleLine(line: string): void {
    const frame = parseFrame(line)
    if (!frame) return
    if (!isResponse(frame)) return // notifications unused in M0
    const p = this.pending.get(frame.id)
    if (!p) return
    this.pending.delete(frame.id)
    clearTimeout(p.timer)
    if (frame.error) {
      const err = new Error(frame.error.message)
      ;(err as Error & { code?: number; data?: unknown }).code = frame.error.code
      ;(err as Error & { code?: number; data?: unknown }).data = frame.error.data
      p.reject(err)
    } else {
      p.resolve(frame.result)
    }
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.statusValue === 'down' || this.statusValue === 'stopped') {
      // Attempt a fresh start for one-shot use after a crash.
      this.start()
    }
    // Wait only for the child to exist — writing the first request is what
    // completes the readiness probe, so waiting for 'ready' here would deadlock.
    await this.waitForChild(timeoutMs)
    const child = this.child
    if (!child) throw new Error('bridge is not running')
    const id = ++this.nextId
    child.stdin.write(encodeRequest(id, method, params))
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
  }

  private waitForChild(timeoutMs: number): Promise<void> {
    if (this.child) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.child) {
          clearInterval(timer)
          resolve()
        } else if (this.statusValue === 'down' || this.statusValue === 'stopped') {
          clearInterval(timer)
          reject(new Error(`bridge is ${this.statusValue}`))
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          reject(new Error(`bridge did not spawn within ${timeoutMs}ms`))
        }
      }, 50)
    })
  }

  async ping(timeoutMs = 10_000): Promise<BridgePingResult> {
    const raw = await this.request<Record<string, unknown>>('sys.ping', undefined, timeoutMs)
    return {
      ok: raw.ok === true,
      version: String(raw.version ?? ''),
      python: String(raw.python ?? ''),
      dwkRoot: String(raw.dwk_root ?? ''),
      dwkLoaded: raw.dwk_loaded === true,
      dwkError: typeof raw.dwk_error === 'string' ? raw.dwk_error : null
    }
  }

  async paths(timeoutMs = 15_000): Promise<BridgePathsResult> {
    const raw = await this.request<Record<string, unknown>>('sys.paths', undefined, timeoutMs)
    return {
      python: String(raw.python ?? ''),
      dwkRoot: String(raw.dwk_root ?? ''),
      ffmpeg: typeof raw.ffmpeg === 'string' ? raw.ffmpeg : null,
      ffprobe: typeof raw.ffprobe === 'string' ? raw.ffprobe : null
    }
  }

  async initProject(
    params: { path: string; title: string; fps: number; runtime: number | null; language: string },
    timeoutMs = 60_000
  ): Promise<{ projectPath: string }> {
    const raw = await this.request<Record<string, unknown>>('dwk.init_project', params, timeoutMs)
    return { projectPath: String(raw.project_path ?? '') }
  }

  async validateProject(projectPath: string, timeoutMs = 60_000): Promise<ValidationSummary> {
    const raw = await this.request<Record<string, unknown>>('dwk.validate_project', { project_path: projectPath }, timeoutMs)
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
    return {
      project: String(raw.project ?? ''),
      title: typeof raw.title === 'string' ? raw.title : undefined,
      valid: raw.valid === true,
      errors: list(raw.errors),
      warnings: list(raw.warnings),
      shotCount: Number(raw.shot_count ?? 0),
      sourceCount: Number(raw.source_count ?? 0),
      claimCount: Number(raw.claim_count ?? 0)
    }
  }

  // ---------------------------------------------------------------- M3: tts

  async ttsVoices(
    params: { locale?: string } = {},
    timeoutMs = 60_000
  ): Promise<{ count: number; voices: TtsVoice[] }> {
    const raw = await this.request<{ count?: number; voices?: Array<Record<string, unknown>> }>(
      'tts.voices',
      { locale: params.locale ?? undefined },
      timeoutMs
    )
    const rows = Array.isArray(raw.voices) ? raw.voices : []
    return {
      count: Number(raw.count ?? rows.length),
      voices: rows.map((v) => ({
        shortName: String(v.short_name ?? ''),
        gender: String(v.gender ?? ''),
        locale: String(v.locale ?? ''),
        name: String(v.name ?? '')
      }))
    }
  }

  async ttsGenerate(
    params: {
      projectPath: string
      text: string
      voice?: string
      ratePct?: number
      outName?: string
      preview?: boolean
    },
    timeoutMs = 300_000
  ): Promise<TtsGenerateResult> {
    const raw = await this.request<Record<string, unknown>>(
      'tts.generate',
      {
        project_path: params.projectPath,
        text: params.text,
        voice: params.voice ?? undefined,
        rate_pct: params.ratePct ?? undefined,
        out_name: params.outName ?? undefined,
        preview: params.preview === true ? true : undefined
      },
      timeoutMs
    )
    return {
      engine: String(raw.engine ?? 'edge'),
      voice: String(raw.voice ?? ''),
      rate: String(raw.rate ?? '+0%'),
      wav: String(raw.wav ?? ''),
      wordsPath: typeof raw.words === 'string' && raw.words ? raw.words : null,
      wordsCount: Number(raw.words_count ?? 0),
      durationS: Number(raw.duration_s ?? 0),
      cacheKey: String(raw.cache_key ?? ''),
      cached: raw.cached === true,
      bytes: Number(raw.bytes ?? 0)
    }
  }

  async ttsPreview(params: { projectPath: string; text: string; voice?: string; ratePct?: number }, timeoutMs = 300_000): Promise<TtsGenerateResult> {
    return this.ttsGenerate({ ...params, preview: true, outName: 'voice_preview' }, timeoutMs)
  }

  async validateSrt(
    params: { srtPath: string; maxCps?: number },
    timeoutMs = 60_000
  ): Promise<SrtValidation> {
    const raw = await this.request<Record<string, unknown>>(
      'dwk.validate_srt',
      { srt_path: params.srtPath, max_cps: params.maxCps ?? undefined },
      timeoutMs
    )
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
    return {
      cueCount: Number(raw.cue_count ?? 0),
      maxCps: Number(raw.max_cps ?? 20),
      valid: raw.valid === true,
      errors: list(raw.errors),
      warnings: list(raw.warnings)
    }
  }
}

export { RpcErrorCode }
