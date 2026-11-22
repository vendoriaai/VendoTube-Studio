import { useCallback, useEffect, useRef, useState } from 'react'
import { api, subscribeEvents } from '../lib/api'
import { useStudio } from '../state/store'
import { Badge, Button, Input, Mono, StatusDot, cn } from '../components/ui'
import type { ChatMessageRecord, JobRecord, ScoutActivity } from '@shared/ipc'

/** Crew chat (UI-UX-SPEC §4.2). M1: Scout runs + live activity feed. */

interface ActivityCard extends ScoutActivity {
  key: string
}

export function Chat() {
  const { activeProject, bridge, keyStatus, upsertJob, setStage, setToast } = useStudio()
  const [messages, setMessages] = useState<ChatMessageRecord[]>([])
  const [activities, setActivities] = useState<ActivityCard[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const projectId = activeProject?.id ?? null

  const reload = useCallback((): void => {
    void api.chatList(projectId).then(setMessages)
  }, [projectId])

  useEffect(() => {
    reload()
    setActivities([])
  }, [reload])

  useEffect(() => {
    const off = subscribeEvents({
      onScout: (payload) => {
        if (payload.projectId !== projectId) return
        setActivities((prev) => [...prev.slice(-79), { ...payload.activity, key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }])
      },
      onDirector: (payload) => {
        if (payload.projectId !== projectId) return
        setActivities((prev) => [
          ...prev.slice(-79),
          {
            ...payload.activity,
            summary: `[Director] ${payload.activity.summary ?? ''}`,
            key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          }
        ])
      },
      onJob: (job: JobRecord) => {
        upsertJob(job)
        if (['scout.research', 'director.build'].includes(job.kind) && ['done', 'failed', 'cancelled'].includes(job.status)) {
          reload()
        }
        // Showrunner autopilot (M6): when the crew lands the draft, celebrate
        // it in Preview; if it parks at the media-rights gate, jump there too
        // so the approval card is unmissable.
        if (job.projectId === projectId && job.kind.startsWith('showrunner.')) {
          if (job.status === 'done') {
            const paused = (job.artifacts as Array<{ pausedAtGate?: string }> | undefined)?.[0]
            if (!paused?.pausedAtGate) {
              setStage('preview')
              setToast('Draft ready — refine it below or export the final master.')
            }
          }
          if (job.status === 'awaiting_approval') {
            setStage('preview')
            setToast('The crew needs one approval — research media rights (G-M).')
          }
        }
      }
    })
    return off
  }, [projectId, reload, upsertJob, setStage, setToast])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages.length, activities.length])

  const send = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    try {
      await api.chatSend(projectId, content) // /research enqueues the Scout job in main
      reload()
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-2 text-[12px] text-ink-muted">
        <span className="mr-3 inline-flex items-center gap-1.5">
          <StatusDot tone="muted" />
          Showrunner: arrives M2
        </span>
        <span className="mr-3 inline-flex items-center gap-1.5">
          <StatusDot tone={bridge.status === 'ready' ? 'ok' : 'warn'} pulse={bridge.status === 'starting'} />
          Scout: ready — type <Mono className="mx-1 text-[11px]">/research {"<topic>"}</Mono>
        </span>
        {projectId ? <span>transcript: this project</span> : <span>transcript: global (no project selected — /research needs a project)</span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && activities.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <p className="font-display text-[18px]">Brief the crew</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              Start with <Mono>/research the lost city of Cahokia</Mono>. Scout browses the live internet in a visible window, then
              files sources, claims, and media candidates into the project.
            </p>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[78%] rounded-card px-3.5 py-2.5 text-[13px] leading-relaxed',
                    m.role === 'user' ? 'bg-surface-2' : 'border border-line bg-surface'
                  )}
                >
                  {m.role !== 'user' ? (
                    <div className="mb-1 flex items-center gap-1.5">
                      <Badge tone={m.content.startsWith('[Scout]') ? 'ok' : 'accent'}>
                        {m.content.startsWith('[Scout]') ? 'Scout' : 'Studio'}
                      </Badge>
                      <span className="text-[10px] text-ink-muted/70">{new Date(m.createdAt).toLocaleTimeString()}</span>
                    </div>
                  ) : null}
                  {m.content}
                </div>
              </div>
            ))}
            {activities.length > 0 ? (
              <div className="space-y-1.5 rounded-card border border-line/60 bg-bg-elevated/50 p-2">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">Scout activity</div>
                {activities.map((a) => (
                  <ActivityRow key={a.key} card={a} />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void send()}
            placeholder={projectId ? '/research <topic> — or message the studio…' : 'No project selected — create one from Home'}
          />
          <Button onClick={() => void send()} disabled={sending || !draft.trim()}>
            Send
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-muted/70">
          {bridge.status === 'ready' ? 'Studio Bridge ready' : `Studio Bridge: ${bridge.status}`} ·{' '}
          {keyStatus?.configured ? 'provider key set' : 'no provider key — Scout needs one in Settings'}
        </p>
      </div>
    </div>
  )
}

function ActivityRow({ card }: { card: ActivityCard }) {
  if (card.type === 'page' && card.imageBase64) {
    return (
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <img src={`data:image/jpeg;base64,${card.imageBase64}`} alt="page" className="max-h-44 w-full object-cover object-top" />
        <div className="px-2 py-1 text-[11px] text-ink-muted">{safeText(card.summary) || 'page'}</div>
      </div>
    )
  }
  const tone = card.type === 'error' ? 'text-danger' : card.type === 'done' ? 'text-signal' : 'text-ink-muted'
  const icon = card.type === 'tool_call' ? '▸' : card.type === 'error' ? '✕' : card.type === 'done' ? '✓' : '·'
  return (
    <div className={cn('flex items-baseline gap-1.5 px-1 text-[11.5px]', tone)}>
      <Mono className="text-[10px]">{icon}</Mono>
      {card.tool ? <Mono className="text-[10.5px] text-accent">{card.tool}</Mono> : null}
      <span className="truncate" title={safeText(card.summary)}>
        {safeText(card.summary)}
      </span>
    </div>
  )
}

/** Activity payloads are cross-IPC — coerce anything non-string before rendering. */
function safeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
