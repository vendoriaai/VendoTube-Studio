import { useEffect, useState } from 'react'
import { useStudio } from '../state/store'
import { api } from '../lib/api'
import { Badge, Button, Mono } from '../components/ui'
import { JobStatusBadge } from './JobsRail'
import type { AgentRunRow } from '@shared/ipc'

/** Contextual right rail (job details + agent_runs audit view, M5). */

export function Inspector() {
  const { inspectJobId, jobs, activeProject, setInspectJob, removeJob } = useStudio()
  const job = inspectJobId ? jobs[inspectJobId] : null
  const [runs, setRuns] = useState<AgentRunRow[]>([])

  useEffect(() => {
    const projectId = activeProject?.id ?? null
    let alive = true
    const load = (): void => {
      void api
        .agentRunsList(projectId)
        .then((rows) => {
          if (alive) setRuns(rows)
        })
        .catch(() => undefined)
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [activeProject?.id, inspectJobId])

  const dismiss = async (): Promise<void> => {
    if (!job) return
    await api.dismissJob(job.id)
    removeJob(job.id)
    setInspectJob(null)
  }

  return (
    <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-bg-elevated p-3 xl:flex">
      <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Inspector</h2>
      {!job ? (
        <>
          <p className="px-1 text-[12px] leading-relaxed text-ink-muted/80">
            Select a job from the rail below, or run something from Home. Jobs are persisted and survive restarts.
          </p>
          <AgentRunsList runs={runs} />
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Mono className="text-[12px] font-semibold">{job.kind}</Mono>
            <JobStatusBadge job={job} />
          </div>
          <dl className="space-y-1.5 text-[12px]">
            <Row label="agent" value={job.agent} />
            <Row label="created" value={new Date(job.createdAt).toLocaleTimeString()} />
            <Row label="updated" value={new Date(job.updatedAt).toLocaleTimeString()} />
            <Row label="resumable" value={job.resumable ? 'yes' : 'no'} />
            <Row label="phase" value={job.progress?.phase ?? '—'} />
            {typeof job.progress?.pct === 'number' ? <Row label="pct" value={`${Math.round(job.progress.pct)}%`} /> : null}
          </dl>
          {job.error ? (
            <div className="rounded-card border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger">{job.error}</div>
          ) : null}
          <div>
            <span className="mb-1 block text-[11px] font-medium text-ink-muted">params</span>
            <pre className="overflow-auto rounded-card border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed text-ink-muted">
              {JSON.stringify(job.params ?? null, null, 2)}
            </pre>
          </div>
          <div className="flex gap-2">
            {job.status === 'running' || job.status === 'queued' ? (
              <Button variant="subtle" onClick={() => void api.cancelJob(job.id)}>
                Cancel job
              </Button>
            ) : null}
            {['failed', 'cancelled', 'done'].includes(job.status) ? (
              <Button variant="ghost" onClick={() => void dismiss()}>
                Dismiss
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setInspectJob(null)}>
              Close
            </Button>
          </div>
        </div>
      )}
      {job ? <AgentRunsList runs={runs} /> : null}
    </aside>
  )
}

/** agent_runs audit (M5): every crew run, newest first (PRD metric: 100% auditable). */
function AgentRunsList({ runs }: { runs: AgentRunRow[] }) {
  if (runs.length === 0) return null
  return (
    <div className="mt-4">
      <span className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Agent runs</span>
      <ul className="space-y-1">
        {runs.slice(0, 12).map((r) => (
          <li key={r.id} className="flex items-baseline gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-surface-2">
            <span
              className={
                r.status === 'running'
                  ? 'text-warm'
                  : r.status === 'done'
                    ? 'text-signal'
                    : 'text-danger'
              }
            >
              ●
            </span>
            <span className="font-medium capitalize">{r.agent}</span>
            <span className="min-w-0 flex-1 truncate text-ink-muted" title={`${r.stage ?? ''} · ${r.model ?? ''}`}>
              {r.stage ?? '—'} · {r.model ?? '—'}
            </span>
            <Mono className="shrink-0 text-[10px] text-ink-muted/70">
              {r.startedAt ? new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
            </Mono>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate text-right">
        <Mono>{value}</Mono>
      </dd>
    </div>
  )
}

export function InspectorBadge({ children }: { children: string }): JSX.Element {
  return <Badge tone="accent">{children}</Badge>
}
