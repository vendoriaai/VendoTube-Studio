import { randomUUID } from 'node:crypto'
import type { JobProgress, JobRecord, JobStatus } from '@shared/ipc'

/**
 * Job manager — every long operation is a persisted, cancellable job that
 * survives app restarts (TAD §4). Persistence goes through the JobRepo
 * interface so restart-safety is unit-testable without SQLite.
 */

export type JobTask<T = unknown> = (ctx: JobContext) => Promise<T>

export interface JobContext {
  readonly jobId: string
  /** Parameters the job was enqueued with. */
  readonly params: unknown
  setProgress(phase: string, pct?: number, eta?: string): void
  throwIfCancelled(): void
  /**
   * Approval gates (M3): park the job in `awaiting_approval`. The task keeps
   * running until it returns; execute() preserves the parked status instead
   * of marking it done. Resume via resumeAwaiting() after the user decides.
   */
  setAwaitingApproval(): void
}

export interface JobStartOptions {
  projectId?: string | null
  agent?: string
  resumable?: boolean
  params?: unknown
}

export interface JobRepo {
  list(): JobRecord[]
  get(id: string): JobRecord | null
  insert(job: JobRecord): void
  update(id: string, patch: Partial<JobRecord>): void
  delete(id: string): void
}

export class JobCancelled extends Error {
  constructor() {
    super('Job cancelled')
    this.name = 'JobCancelled'
  }
}

export class MemoryJobRepo implements JobRepo {
  private rows = new Map<string, JobRecord>()
  list(): JobRecord[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  get(id: string): JobRecord | null {
    return this.rows.get(id) ?? null
  }
  insert(job: JobRecord): void {
    this.rows.set(job.id, { ...job })
  }
  update(id: string, patch: Partial<JobRecord>): void {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, ...patch })
  }
  delete(id: string): void {
    this.rows.delete(id)
  }
}

const INTERRUPTED_ERROR = 'interrupted by app restart'

/**
 * Job kinds that drive real renders (hyperframes + full-core ffmpeg). They
 * serialize against each other so two films never fight over the machine —
 * quick crew jobs (research/direct/chat) keep running concurrently.
 * showrunner.make runs produce inline (no sub-job enqueue), so the chain
 * cannot deadlock; a gate-parked job releases the chain when it returns.
 */
const HEAVY_KINDS = new Set(['producer.produce', 'showrunner.make'])

export class JobManager {
  private tasks = new Map<string, JobTask>()
  private cancelled = new Set<string>()
  private running = new Set<string>()
  private awaiting = new Set<string>()

  constructor(
    private readonly repo: JobRepo,
    private readonly emit: (event: string, payload: JobRecord) => void = () => {}
  ) {}

  /** Register the executor for a job kind (e.g. 'project.create'). */
  registerHandler(kind: string, task: JobTask): void {
    this.tasks.set(kind, task)
  }

  private notify(row: JobRecord): void {
    this.emit('job:updated', row)
  }

  list(): JobRecord[] {
    return this.repo.list()
  }

  get(id: string): JobRecord | null {
    return this.repo.get(id)
  }

  /**
   * Restart recovery: `running` jobs never finished, so the process died
   * mid-flight. Resumable ones are requeued (their handlers are idempotent
   * per ROADMAP M0), the rest fail honestly. `awaiting_approval` jobs also
   * return to the queue — approvals persist separately (M1+).
   */
  recover(): { requeued: number; failed: number } {
    let requeued = 0
    let failed = 0
    for (const row of this.repo.list()) {
      if (row.status !== 'running' && row.status !== 'awaiting_approval') continue
      if (row.resumable) {
        this.repo.update(row.id, { status: 'queued', progress: {}, updatedAt: now() })
        requeued++
      } else {
        this.repo.update(row.id, { status: 'failed', error: INTERRUPTED_ERROR, updatedAt: now() })
        failed++
      }
    }
    if (requeued + failed > 0) this.emitCounts()
    return { requeued, failed }
  }

  /** Execute every queued job (boot drain + retries). Serialized per manager. */
  async drain(): Promise<void> {
    for (const row of this.repo.list()) {
      if (row.status === 'queued') await this.execute(row.id)
    }
  }

  async enqueue(kind: string, options: JobStartOptions = {}): Promise<JobRecord> {
    const record: JobRecord = {
      id: randomUUID(),
      projectId: options.projectId ?? null,
      kind,
      agent: options.agent ?? 'system',
      params: options.params ?? null,
      status: 'queued',
      progress: {},
      artifacts: [],
      error: null,
      resumable: options.resumable ?? false,
      createdAt: now(),
      updatedAt: now()
    }
    this.repo.insert(record)
    this.notify(record)
    // Execute on the next macrotask so a cancel issued right after enqueue
    // deterministically wins over the drain.
    setTimeout(() => void this.execute(record.id).catch(() => undefined), 0)
    return record
  }

  /** Promise that resolves with the job record once it leaves the queue. */
  whenDone(jobId: string): Promise<JobRecord> {
    return new Promise((resolve) => {
      const check = (): void => {
        const row = this.repo.get(jobId)
        if (row && row.status !== 'queued' && row.status !== 'running') resolve(row)
        else setImmediate(check)
      }
      check()
    })
  }

  private heavyTail: Promise<void> = Promise.resolve()

  private async execute(jobId: string): Promise<void> {
    const kind = this.repo.get(jobId)?.kind
    if (!kind || !HEAVY_KINDS.has(kind)) {
      await this.claimAndRun(jobId)
      return
    }
    // Heavy job: hold its place in the render chain while it waits (status
    // stays 'queued' so the UI reads it as waiting for the other render).
    let release = (): void => undefined
    const prev = this.heavyTail
    this.heavyTail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await prev
      await this.claimAndRun(jobId)
    } finally {
      release()
    }
  }

  private async claimAndRun(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return
    // Re-read at claim time: a cancel may have landed between enqueue and drain.
    const row = this.repo.get(jobId)
    if (!row || row.status !== 'queued' || this.cancelled.has(jobId)) return
    const task = this.tasks.get(row.kind)
    if (!task) {
      const failed = { ...row, status: 'failed' as JobStatus, error: `no handler for kind '${row.kind}'`, updatedAt: now() }
      this.repo.update(jobId, failed)
      this.notify(failed)
      return
    }
    this.running.add(jobId)
    const running = { ...row, status: 'running' as JobStatus, progress: {}, updatedAt: now() }
    this.repo.update(jobId, { status: 'running', progress: {}, updatedAt: now() })
    this.notify(running)
    const ctx: JobContext = {
      jobId,
      params: row.params,
      setProgress: (phase, pct, eta) => {
        const progress: JobProgress = { phase, ...(pct !== undefined ? { pct } : {}), ...(eta !== undefined ? { eta } : {}) }
        this.repo.update(jobId, { progress, updatedAt: now() })
        this.notify(this.repo.get(jobId) ?? running)
      },
      throwIfCancelled: () => {
        if (this.cancelled.has(jobId)) throw new JobCancelled()
      },
      setAwaitingApproval: () => {
        this.awaiting.add(jobId)
        this.repo.update(jobId, { status: 'awaiting_approval', updatedAt: now() })
        this.notify(this.repo.get(jobId) ?? running)
      }
    }
    try {
      const result: unknown = await task(ctx)
      if (this.cancelled.has(jobId)) throw new JobCancelled()
      if (this.awaiting.has(jobId)) {
        // Parked at an approval gate — keep awaiting_approval, just record the
        // task result as artifacts so the UI can render the gate card.
        this.repo.update(jobId, {
          artifacts: result === undefined ? [] : [result],
          updatedAt: now()
        })
        this.notify(this.repo.get(jobId) ?? running)
        return
      }
      this.repo.update(jobId, {
        status: 'done',
        progress: { phase: 'done', pct: 100 },
        artifacts: result === undefined ? [] : [result],
        updatedAt: now()
      })
    } catch (err) {
      const cancelled = err instanceof JobCancelled || this.cancelled.has(jobId)
      this.repo.update(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : err instanceof Error ? err.message : String(err),
        updatedAt: now()
      })
    } finally {
      this.running.delete(jobId)
      this.cancelled.delete(jobId)
      this.notify(this.repo.get(jobId) ?? running)
    }
  }

  /**
   * Approval-gate resume: re-queue a parked job with the SAME id and params.
   * Handlers are idempotent (producer_state.json + caches), so the run
   * continues from where it paused.
   */
  async resumeAwaiting(jobId: string): Promise<JobRecord | null> {
    const row = this.repo.get(jobId)
    if (!row || row.status !== 'awaiting_approval') return null
    this.awaiting.delete(jobId)
    this.repo.update(jobId, { status: 'queued', error: null, progress: {}, updatedAt: now() })
    this.notify(this.repo.get(jobId) ?? row)
    setTimeout(() => void this.execute(jobId).catch(() => undefined), 0)
    return this.repo.get(jobId)
  }

  /** Decline: an awaiting job is cancelled honestly (the gate said no). */
  private declineAwaiting(jobId: string): boolean {
    const row = this.repo.get(jobId)
    if (!row || row.status !== 'awaiting_approval' || !this.awaiting.has(jobId)) return false
    this.awaiting.delete(jobId)
    this.repo.update(jobId, { status: 'cancelled', error: 'declined at approval gate', updatedAt: now() })
    this.notify(this.repo.get(jobId) ?? row)
    return true
  }

  async cancel(jobId: string): Promise<void> {
    const row = this.repo.get(jobId)
    if (!row) return
    if (row.status === 'queued') {
      // Guard: also set the flag so an in-flight execute() claim bails.
      this.cancelled.add(jobId)
      this.repo.update(jobId, { status: 'cancelled', updatedAt: now() })
      this.notify(this.repo.get(jobId) ?? row)
      return
    }
    if (row.status === 'running') {
      this.cancelled.add(jobId)
    }
    if (row.status === 'awaiting_approval') {
      this.declineAwaiting(jobId)
    }
  }

  /** Re-enqueue a cancelled/failed job (M0: only resumable ones). */
  async retry(jobId: string): Promise<JobRecord | null> {
    const row = this.repo.get(jobId)
    if (!row || !row.resumable) return null
    if (row.status !== 'failed' && row.status !== 'cancelled') return null
    this.repo.update(jobId, { status: 'queued', error: null, progress: {}, updatedAt: now() })
    this.notify(this.repo.get(jobId) ?? row)
    setTimeout(() => void this.execute(jobId).catch(() => undefined), 0)
    return this.repo.get(jobId)
  }

  /** Remove a terminal job from history (failed/cancelled/done only). */
  dismiss(jobId: string): boolean {
    const row = this.repo.get(jobId)
    if (!row) return false
    if (row.status === 'queued' || row.status === 'running' || row.status === 'awaiting_approval') return false
    this.repo.delete(jobId)
    return true
  }

  /** Remove all terminal jobs. Returns the count removed. */
  dismissAllFinished(): number {
    let n = 0
    for (const row of this.repo.list()) {
      if (!['queued', 'running', 'awaiting_approval'].includes(row.status)) {
        this.repo.delete(row.id)
        n++
      }
    }
    return n
  }

  private emitCounts(): void {
    // Restart recovery changed many rows at once; push the full list once.
    for (const row of this.repo.list()) this.emit('job:updated', row)
  }
}

function now(): string {
  return new Date().toISOString()
}
