import { describe, expect, it, vi } from 'vitest'
import { JobManager, MemoryJobRepo, JobCancelled } from '../src/main/jobs'

/** M0 exit criterion: jobs survive restarts in queued/running states. */

function bootedManager(repo = new MemoryJobRepo(), emit?: (e: string, j: unknown) => void): JobManager {
  return new JobManager(repo, emit ?? (() => undefined))
}

describe('JobManager restart safety', () => {
  it('requeues resumable running jobs on recover()', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    mgr.registerHandler('forever', () => new Promise(() => undefined)) // never resolves
    const job = await mgr.enqueue('forever', { resumable: true })
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('running'))

    // Simulate restart: new manager over the same repo.
    const mgr2 = bootedManager(repo)
    const res = mgr2.recover()
    expect(res.requeued).toBe(1)
    expect(repo.get(job.id)?.status).toBe('queued')
  })

  it('fails non-resumable running jobs on recover()', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    mgr.registerHandler('forever', () => new Promise(() => undefined))
    const job = await mgr.enqueue('forever', { resumable: false })
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('running'))

    const mgr2 = bootedManager(repo)
    const res = mgr2.recover()
    expect(res.failed).toBe(1)
    const row = repo.get(job.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/interrupted/)
  })

  it('re-runs requeued jobs when a handler is registered (resume)', async () => {
    const repo = new MemoryJobRepo()
    const first = bootedManager(repo)
    first.registerHandler('stuck', () => new Promise(() => undefined))
    const job = await first.enqueue('stuck', { resumable: true })
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('running'))

    // Restart with a working handler; recovery + drain should complete it.
    const second = bootedManager(repo)
    second.registerHandler('stuck', async (ctx) => {
      ctx.setProgress('working', 50)
      return 'payload-42'
    })
    second.recover()
    await second.drain()
    const row = repo.get(job.id)
    expect(row?.status).toBe('done')
    expect(row?.artifacts[0]).toBe('payload-42')
  })

  it('cancel marks queued jobs cancelled without running them', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let ran = false
    mgr.registerHandler('work', async () => {
      ran = true
    })
    const job = await mgr.enqueue('work', {})
    await mgr.cancel(job.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(repo.get(job.id)?.status).toBe('cancelled')
    expect(ran).toBe(false)
  })

  it('cancel interrupts running jobs via throwIfCancelled', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    mgr.registerHandler('long', async (ctx) => {
      for (let i = 0; i < 50; i++) {
        ctx.throwIfCancelled()
        await new Promise((r) => setTimeout(r, 5))
      }
      return 'finished'
    })
    const job = await mgr.enqueue('long', {})
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('running'))
    await mgr.cancel(job.id)
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('cancelled'))
  })

  it('stores task errors and supports retry of resumable failures', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let attempts = 0
    mgr.registerHandler('flaky', async () => {
      attempts++
      if (attempts === 1) throw new Error('boom')
      return 'recovered'
    })
    const job = await mgr.enqueue('flaky', { resumable: true })
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('failed'))
    expect(repo.get(job.id)?.error).toBe('boom')

    const retried = await mgr.retry(job.id)
    expect(retried).not.toBeNull()
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('done'))
    expect(repo.get(job.id)?.artifacts[0]).toBe('recovered')
  })

  it('reports jobs missing handlers as failed, not crashed', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    const job = await mgr.enqueue('unknown.kind', {})
    await vi.waitFor(() => expect(repo.get(job.id)?.status).toBe('failed'))
    expect(repo.get(job.id)?.error).toContain('no handler')
  })

  it('JobCancelled is distinguishable', () => {
    expect(new JobCancelled().name).toBe('JobCancelled')
  })

  it('M5 recovery: a crash mid-produce requeues and the resumed run reaches done (segments skip is pipeline-side)', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let phase = 0
    // First boot: the produce handler "crashes" mid-render (job left 'running').
    mgr.registerHandler('producer.produce', async () => {
      phase++
      if (phase === 1) {
        await new Promise(() => undefined) // the process dies here — handler never returns
      }
      // Second boot (after recover): the pipeline resumes from producer_state
      // (segments skip) and completes.
      return { status: 'done', summary: 'resumed' }
    })
    await mgr.enqueue('producer.produce', { resumable: true, params: { projectId: 'p1' } })
    await vi.waitFor(() => expect(repo.list().some((r) => r.status === 'running')).toBe(true))

    // Restart over the same repo: recover requeues the interrupted produce.
    const mgr2 = bootedManager(repo)
    mgr2.registerHandler('producer.produce', async () => ({ status: 'done', summary: 'resumed' }))
    mgr2.recover()
    await mgr2.drain()
    const row = repo.list().find((r) => r.kind === 'producer.produce')
    expect(row?.status).toBe('done')
    expect(row?.artifacts?.[0]).toEqual({ status: 'done', summary: 'resumed' })
  })
})

describe('heavy render serialization (render performance, 2026-11-16)', () => {
  const heavy = async (): Promise<string> => {
    await new Promise((r) => setTimeout(r, 25))
    return 'ok'
  }

  it('runs heavy jobs one at a time — the second starts only after the first finishes', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let inFlight = 0
    let overlap = false
    const tracked = async (): Promise<string> => {
      inFlight++
      if (inFlight > 1) overlap = true
      const r = await heavy()
      inFlight--
      return r
    }
    mgr.registerHandler('producer.produce', tracked)
    mgr.registerHandler('showrunner.make', tracked)
    const a = await mgr.enqueue('producer.produce', {})
    const b = await mgr.enqueue('showrunner.make', {})
    await vi.waitFor(() => expect(repo.get(b.id)?.status).toBe('done'))
    expect(repo.get(a.id)?.status).toBe('done')
    expect(overlap).toBe(false)
  })

  it('keeps quick jobs concurrent with a running heavy render', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let releaseHeavy!: () => void
    const gate = new Promise<void>((r) => {
      releaseHeavy = r
    })
    mgr.registerHandler('producer.produce', async () => {
      await gate
      return 'heavy'
    })
    mgr.registerHandler('scout.research', async () => 'quick')
    const render = await mgr.enqueue('producer.produce', {})
    await vi.waitFor(() => expect(repo.get(render.id)?.status).toBe('running'))
    const quick = await mgr.enqueue('scout.research', {})
    await vi.waitFor(() => expect(repo.get(quick.id)?.status).toBe('done'))
    expect(repo.get(render.id)?.status).toBe('running')
    releaseHeavy()
    await vi.waitFor(() => expect(repo.get(render.id)?.status).toBe('done'))
  })

  it('releases the chain when a heavy job parks at a gate (awaiting_approval)', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    mgr.registerHandler('producer.produce', async (ctx) => {
      ctx.setAwaitingApproval()
      return { status: 'paused_at_gate' }
    })
    mgr.registerHandler('showrunner.make', async () => 'ok')
    const parked = await mgr.enqueue('producer.produce', {})
    await vi.waitFor(() => expect(repo.get(parked.id)?.status).toBe('awaiting_approval'))
    const second = await mgr.enqueue('showrunner.make', {})
    await vi.waitFor(() => expect(repo.get(second.id)?.status).toBe('done'))
  })

  it('a heavy job cancelled while queued-waiting never runs AND releases its slot for later jobs', async () => {
    const repo = new MemoryJobRepo()
    const mgr = bootedManager(repo)
    let releaseHeavy!: () => void
    const gate = new Promise<void>((r) => {
      releaseHeavy = r
    })
    mgr.registerHandler('producer.produce', async () => {
      await gate
      return 'heavy'
    })
    mgr.registerHandler('showrunner.make', async () => 'ok')
    const first = await mgr.enqueue('producer.produce', {})
    await vi.waitFor(() => expect(repo.get(first.id)?.status).toBe('running'))
    const waiting = await mgr.enqueue('showrunner.make', {})
    await new Promise((r) => setTimeout(r, 20)) // let it enter the wait
    expect(repo.get(waiting.id)?.status).toBe('queued')
    await mgr.cancel(waiting.id)
    expect(repo.get(waiting.id)?.status).toBe('cancelled')
    releaseHeavy()
    await vi.waitFor(() => expect(repo.get(first.id)?.status).toBe('done'))
    // The chain must still flow past the cancelled waiter.
    const third = await mgr.enqueue('showrunner.make', {})
    await vi.waitFor(() => expect(repo.get(third.id)?.status).toBe('done'))
  })
})
