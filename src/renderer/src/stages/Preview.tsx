import { useCallback, useEffect, useRef, useState } from 'react'
import { api, studioUrl } from '../lib/api'
import { holdMedia, releaseAllMedia } from '../lib/media-handles'
import { useStudio } from '../state/store'
import { Badge, Button, Card, Input, Mono, Spinner, StatusDot, cn } from '../components/ui'
import type { DeliveryBundle, ProducerActivity } from '@shared/ipc'

/**
 * Preview stage (M3): the draft picture master plays in-app over studio://;
 * producing controls + live Producer activity feed. Beat-chip seeking and
 * the retention overlay arrive with M4 — honest v1 scope.
 */

const PHASE_LABEL: Record<string, string> = {
  phase: 'working',
  tool_result: 'done step',
  message: 'note',
  error: 'error',
  gate: 'waiting for you',
  done: 'finished'
}

export function Preview() {
  const { activeProject, jobs, setToast } = useStudio()
  const [bundle, setBundle] = useState<DeliveryBundle | null>(null)
  const [activity, setActivity] = useState<ProducerActivity[]>([])
  const [producing, setProducing] = useState(false)
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('draft')
  const [showFinal, setShowFinal] = useState(true)
  const [refineNote, setRefineNote] = useState('')
  const [refining, setRefining] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeProject) return
    const b = await api.deliveryGet(activeProject.id).catch(() => null)
    setBundle(b)
  }, [activeProject])

  useEffect(() => {
    void refresh()
  }, [refresh, jobs])

  useEffect(() => {
    if (!activeProject) return
    const off = window.api.on('producer:activity', (p) => {
      const payload = p as { projectId: string; activity: ProducerActivity }
      if (payload.projectId !== activeProject.id) return
      setActivity((prev) => [...prev.slice(-80), payload.activity])
    })
    return () => {
      off()
    }
  }, [activeProject])

  /**
   * Release the media file when Preview unmounts (2026-11-19).
   *
   * The <video> streams the master through studio://, so Chromium holds an
   * open handle on documentary.mp4 for as long as the element exists — even
   * after leaving Preview. On Windows that lock made project deletion fail
   * with EBUSY. The element is also registered in the media-handle registry so
   * a delete request can detach it even before navigation.
   */
  useEffect(() => {
    return () => {
      releaseAllMedia()
    }
  }, [])

  if (!activeProject) return null

  const producingJob = Object.values(jobs).find((j) => {
    if (!['producer.produce', 'showrunner.make', 'showrunner.refine'].includes(j.kind)) return false
    return j.status === 'running' || j.status === 'queued' || j.status === 'awaiting_approval'
  })
  // A/B (UI-UX §4.6): "final master" = the muxed documentary.mp4 (video + audio);
  // "fast draft" = the 720p video-only draft. `picture.mp4` is the full-res
  // SILENT intermediate feeding finalize — only fall back to it before the
  // audio master exists, so the player never sits on a trackless file.
  const finalAbs = bundle?.master?.abs ?? bundle?.picture?.abs ?? null
  const draftAbs = bundle?.pictureDraft?.abs ?? null
  const playableAbs = showFinal ? (finalAbs ?? draftAbs) : (draftAbs ?? finalAbs)
  const durationS = bundle?.qcReport?.durationSeconds ?? 0
  const deadZones = bundle?.retentionReport?.dead_zones ?? []
  // Visual QC findings (M7): seekable severity markers on the timeline strip.
  const visualFindings = bundle?.visualReport?.findings ?? []
  const seekTo = (t: number): void => {
    const v = videoRef.current
    if (!v || !Number.isFinite(t)) return
    v.currentTime = Math.max(0, t)
    void v.play().catch(() => undefined)
  }

  const produce = async (): Promise<void> => {
    setProducing(true)
    setActivity([])
    try {
      await api.produceRun(activeProject.id, undefined, quality)
    } finally {
      setProducing(false)
    }
  }

  // Export final (M6): standard-quality master with Showrunner autopilot —
  // the click is the consent; G-E/G-F are auto-approved and audited.
  const exportFinal = async (): Promise<void> => {
    setProducing(true)
    setActivity([])
    try {
      await api.produceRun(activeProject.id, undefined, 'standard', true)
      setToast('Export started — rendering the full-resolution master.')
    } finally {
      setProducing(false)
    }
  }

  // Refine (M6): a prompt to the Director, then an automatic fresh draft.
  const refine = async (): Promise<void> => {
    const notes = refineNote.trim()
    if (!notes || refining) return
    setRefining(true)
    try {
      await api.refineFilm(activeProject.id, notes)
      setRefineNote('')
      setToast('Revision queued — the Director redesigns, then a fresh draft renders.')
    } finally {
      setRefining(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-3">
        <h2 className="font-display text-[17px] font-medium">Preview</h2>
        {/* master = the finalized audio master (documentary.mp4); picture = the
            video-only render feeding it. Show the quality the picture holds. */}
        {bundle?.master ? <Badge tone="ok">final master</Badge> : bundle?.picture ? <Badge tone="accent">picture only</Badge> : null}
        {bundle?.pictureQuality ? <Badge tone="neutral">{bundle.pictureQuality}</Badge> : null}
        {bundle?.qcReport ? <Badge tone={bundle.qcReport.passed ? 'ok' : 'danger'}>QC {bundle.qcReport.passed ? 'pass' : 'fail'}</Badge> : null}
        {bundle?.retentionReport ? <Badge tone={bundle.retentionReport.verdict === 'pass' ? 'ok' : 'warn'}>retention {bundle.retentionReport.verdict}</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded border border-line bg-surface-2 px-2 py-1 text-[12.5px]"
            value={quality}
            onChange={(e) => setQuality(e.target.value as 'draft' | 'standard' | 'high')}
            title="draft = 720p24 fast preview; standard/high = full-resolution master"
          >
            <option value="draft">draft (720p24)</option>
            <option value="standard">standard (1080p)</option>
            <option value="high">high</option>
          </select>
          <Button variant="ghost" onClick={() => void refresh()}>
            refresh
          </Button>
          <Button onClick={() => void produce()} disabled={!!producingJob || producing}>
            {producingJob ? 'producing…' : `produce (${quality})`}
          </Button>
          <Button
            variant="subtle"
            onClick={() => void exportFinal()}
            disabled={!!producingJob || producing}
            title="Render the full-resolution master (1080p) with autopilot gates — the click is your consent, every auto-approval is audited"
          >
            Export final
          </Button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {playableAbs ? (
          <video
            ref={(el) => {
              videoRef.current = el
              // Track the element so a project delete can detach it first.
              if (el) holdMedia(el)
            }}
            className="min-h-0 w-full flex-1 bg-black"
            src={studioUrl(playableAbs)}
            controls
            autoPlay={false}
            onClick={() => void videoRef.current?.play().catch(() => undefined)}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-center">
            <div className="max-w-sm">
              <Mono className="text-[12px] text-ink-muted/70">M4</Mono>
              <p className="mt-2 font-display text-[16px] font-medium">No picture master yet</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                Run <Mono>/produce</Mono> — the Producer narrates the script, builds compositions, and renders a draft
                preview. Gates pause the run for your approval.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Retention overlay (UI-UX §4.6): dead zones marked on the timeline. */}
      {deadZones.length > 0 && durationS > 0 ? (
        <div className="relative h-3 w-full overflow-hidden rounded border border-line bg-surface">
          {deadZones.map((d, i) => (
            <div
              key={i}
              className="absolute top-0 h-full bg-warm/70"
              title={`dead zone ${d.from_s}–${d.to_s}s${d.reason ? ` (${d.reason})` : ''}`}
              style={{ left: `${Math.min(100, (d.from_s / durationS) * 100)}%`, width: `${Math.max(1, ((d.to_s - d.from_s) / durationS) * 100)}%` }}
            />
          ))}
        </div>
      ) : null}
      {deadZones.length > 0 ? (
        <p className="text-[12px] text-ink-muted">
          {deadZones.length} dead zone(s) ≥ 8s (amber bars above).{' '}
          {bundle?.retentionReport?.suggestion ? 'The retention report proposes a re-pace — see the Delivery tab.' : ''}
        </p>
      ) : null}

      {/* Visual QC markers (M7): click a marker to seek to the finding. */}
      {visualFindings.length > 0 && durationS > 0 ? (
        <div className="relative h-4 w-full overflow-hidden rounded border border-line bg-surface">
          {visualFindings.slice(0, 60).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => seekTo(f.t_s)}
              className={cn(
                'absolute top-0 h-full w-[3px] min-w-[3px] cursor-pointer border-0 p-0',
                f.severity === 'fail' ? 'bg-[var(--danger,#e5484d)]' : f.severity === 'warn' ? 'bg-warm' : 'bg-ink-muted/40'
              )}
              title={`${f.severity}: ${f.class} @ ${f.t_s}s${f.scene_id ? ` (${f.scene_id})` : ''} — ${f.evidence}`}
              aria-label={`${f.severity} finding ${f.class} at ${f.t_s} seconds`}
            />
          ))}
        </div>
      ) : null}
      {visualFindings.length > 0 ? (
        <p className="text-[12px] text-ink-muted">
          {visualFindings.length} visual QC finding(s) — click a marker to jump. Details in the Delivery tab.
        </p>
      ) : null}
      {finalAbs && draftAbs ? (
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="text-ink-muted">A/B:</span>
          <Button variant={showFinal ? 'subtle' : 'ghost'} onClick={() => setShowFinal(true)}>
            final master
          </Button>
          <Button variant={!showFinal ? 'subtle' : 'ghost'} onClick={() => setShowFinal(false)}>
            fast draft
          </Button>
        </div>
      ) : null}

      {/* Refine loop (M6): a prompt to the Director, then an automatic fresh draft. */}
      <Card className="p-3">
        <div className="flex items-center gap-2">
          <Input
            value={refineNote}
            onChange={(e) => setRefineNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !refining && void refine()}
            placeholder="Tell the Director what to change — e.g. make the hook punchier, cut scene 3"
            disabled={!!producingJob || refining}
          />
          <Button onClick={() => void refine()} disabled={!refineNote.trim() || !!producingJob || refining}>
            {refining ? <Spinner /> : null}
            Refine
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-muted/80">
          The Director revises the film design, then a fresh draft renders automatically — narration you kept stays cached.
        </p>
      </Card>

      {producingJob ? (
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <StatusDot tone={producingJob.status === 'awaiting_approval' ? 'warn' : 'warn'} />
            <span className="text-[13px] font-medium">
              Producer: {producingJob.progress?.phase ?? producingJob.status}
              {typeof producingJob.progress?.pct === 'number' ? ` (${producingJob.progress.pct}%)` : ''}
            </span>
          </div>
          {producingJob.status === 'awaiting_approval' ? (
            <p className="mt-1.5 text-[12.5px] text-ink-muted">
              The run is parked at an approval gate — approve it from the Jobs rail or the Delivery tab.
            </p>
          ) : null}
        </Card>
      ) : null}

      {activity.length > 0 ? (
        <Card className="max-h-56 overflow-y-auto p-3">
          <Mono className="text-[11px] uppercase tracking-wider text-ink-muted/70">Producer activity</Mono>
          <ul className="mt-2 space-y-1">
            {[...activity].reverse().map((a, i) => (
              <li key={i} className="flex items-baseline gap-2 text-[12.5px]">
                <span
                  className={cn(
                    'shrink-0',
                    a.type === 'error' ? 'text-danger' : a.type === 'gate' ? 'text-accent' : 'text-ink-muted/70'
                  )}
                >
                  {PHASE_LABEL[a.type] ?? a.type}
                </span>
                <span className="text-ink-muted">{a.summary}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {showFinal && playableAbs && !bundle?.master && bundle?.picture ? (
        <p className="text-[12px] text-ink-muted">
          Previewing the silent picture — the audio master (documentary.mp4) hasn't been finalized yet. Produce the film to hear narration.
        </p>
      ) : null}
      {!showFinal && draftAbs ? (
        <p className="text-[12px] text-ink-muted">Previewing the fast draft — video only, no narration.</p>
      ) : null}
    </div>
  )
}
