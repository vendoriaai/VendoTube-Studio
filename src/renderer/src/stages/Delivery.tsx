import { useCallback, useEffect, useState } from 'react'
import { api, studioUrl } from '../lib/api'
import { useStudio } from '../state/store'
import { Badge, Button, Card, Mono, StatusDot } from '../components/ui'
import type { DeliveryBundle } from '@shared/ipc'

/**
 * Delivery stage (M3): final master, delivery ZIP (+SHA-256), QC/retention
 * verdicts, the YouTube kit, and the gate approval card (G-F and friends).
 */

function fmtBytes(n: number | undefined): string {
  if (!n) return '—'
  if (n > 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${Math.round(n / 1000)} KB`
}

const GATE_LABEL: Record<string, string> = {
  'G-D': 'Narration (TTS)',
  'G-M': 'Research media rights',
  'G-E': 'Picture render',
  'G-V': 'Visual QC verdict',
  'G-F': 'Delivery package'
}

export function Delivery() {
  const { activeProject, jobs, setStage } = useStudio()
  const [bundle, setBundle] = useState<DeliveryBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!activeProject) return
    const b = await api.deliveryGet(activeProject.id).catch(() => null)
    setBundle(b)
  }, [activeProject])

  useEffect(() => {
    void refresh()
  }, [refresh, jobs])

  if (!activeProject) return null

  const resolve = async (approve: boolean): Promise<void> => {
    if (!bundle?.pendingGate) return
    setBusy(true)
    setNote(null)
    try {
      await api.gateResolve(activeProject.id, bundle.pendingGate.gate, approve)
      if (!approve) setNote(`Gate ${bundle.pendingGate.gate} declined — the production run was cancelled.`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const produce = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await api.produceRun(activeProject.id)
      setStage('preview')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-3">
        <h2 className="font-display text-[17px] font-medium">Delivery</h2>
        {bundle?.stage ? <Badge tone="neutral">{bundle.stage}</Badge> : null}
        <div className="ml-auto">
          <Button onClick={() => void produce()} disabled={busy}>
            run / produce again
          </Button>
        </div>
      </div>

      {note ? <div className="rounded-card border border-line bg-surface px-3 py-2 text-[12.5px] text-ink-muted">{note}</div> : null}

      {bundle?.pendingGate ? (
        <Card className="border-accent p-4">
          <div className="flex items-center gap-2">
            <StatusDot tone="warn" />
            <span className="font-display text-[14.5px] font-medium">
              Approval gate {bundle.pendingGate.gate} — {GATE_LABEL[bundle.pendingGate.gate] ?? 'side effect'}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{bundle.pendingGate.summary}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void resolve(true)} disabled={busy}>
              approve
            </Button>
            <Button variant="ghost" onClick={() => void resolve(false)} disabled={busy}>
              decline
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <Mono className="text-[11px] uppercase tracking-wider text-ink-muted/70">Artifacts</Mono>
        <ul className="mt-2 space-y-2 text-[13px]">
          <li className="flex items-center gap-2">
            <StatusDot tone={bundle?.master ? 'ok' : 'idle'} />
            <span className="font-medium">documentary.mp4</span>
            <span className="text-ink-muted">{bundle?.master ? fmtBytes(bundle.master.bytes) : 'not produced yet'}</span>
            {bundle?.master ? (
              <a className="ml-auto text-accent underline-offset-2 hover:underline" href={studioUrl(bundle.master.abs)} target="_blank" rel="noreferrer">
                open
              </a>
            ) : null}
          </li>
          <li className="flex items-center gap-2">
            <StatusDot tone={bundle?.srt ? 'ok' : 'idle'} />
            <span className="font-medium">subtitles.en.srt</span>
            <span className="text-ink-muted">{bundle?.srt ? fmtBytes(bundle.srt.bytes) : 'not produced yet'}</span>
          </li>
          <li className="flex items-center gap-2">
            <StatusDot tone={bundle?.zip ? 'ok' : 'idle'} />
            <span className="font-medium">project.zip</span>
            <span className="text-ink-muted">{bundle?.zip ? fmtBytes(bundle.zip.bytes) : 'not produced yet'}</span>
            {bundle?.zip?.sha256 ? <Mono className="ml-auto text-[11px] text-ink-muted/70">sha256 {bundle.zip.sha256.slice(0, 12)}…</Mono> : null}
          </li>
        </ul>
        {bundle?.qcReport ? (
          <div className="mt-3 flex gap-2">
            <Badge tone={bundle.qcReport.passed ? 'ok' : 'danger'}>QC {bundle.qcReport.passed ? 'pass' : 'fail'}</Badge>
            {bundle.retentionReport ? (
              <Badge tone={bundle.retentionReport.verdict === 'pass' ? 'ok' : 'warn'}>
                retention {bundle.retentionReport.verdict}
                {bundle.retentionReport.lufs !== null ? ` · ${bundle.retentionReport.lufs} LUFS` : ''}
              </Badge>
            ) : null}
            {bundle.retentionReport && bundle.retentionReport.dead_zones.length > 0 ? (
              <Badge tone="warn">{bundle.retentionReport.dead_zones.length} dead zone(s)</Badge>
            ) : null}
            {bundle.visualReport ? (
              <Badge tone={bundle.visualReport.verdict === 'pass' ? 'ok' : bundle.visualReport.verdict === 'fail' ? 'danger' : 'warn'}>
                visual QC {bundle.visualReport.verdict}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Visual QC findings (M7): deterministic Layer 0 detectors + cut assertion. */}
      {bundle?.visualReport && bundle.visualReport.findings.length > 0 ? (
        <Card className="p-4">
          <Mono className="text-[11px] uppercase tracking-wider text-ink-muted/70">
            Visual QC findings ({bundle.visualReport.findings.length})
          </Mono>
          <ul className="mt-2 space-y-2 text-[12.5px]">
            {bundle.visualReport.findings.slice(0, 12).map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <Badge tone={f.severity === 'fail' ? 'danger' : f.severity === 'warn' ? 'warn' : 'neutral'}>{f.severity}</Badge>
                <div className="min-w-0">
                  <span className="font-medium">
                    {f.class} @ {f.t_s}s{f.to_s !== undefined ? `–${f.to_s}s` : ''}
                  </span>
                  {f.scene_id ? <Mono className="ml-2 text-[11px] text-ink-muted/70">{f.scene_id}</Mono> : null}
                  <div className="text-ink-muted">{f.evidence}</div>
                  {f.suggestion ? <div className="text-ink-muted/80">{f.suggestion}</div> : null}
                </div>
              </li>
            ))}
          </ul>
          {bundle.visualReport.findings.length > 12 ? (
            <p className="mt-2 text-[12px] text-ink-muted">+{bundle.visualReport.findings.length - 12} more in qc/visual_report.json</p>
          ) : null}
          <p className="mt-2 text-[12px] text-ink-muted">
            Layer 0 = local ffmpeg detectors + cut assertion (no AI, no network).{bundle.visualReport.coverage?.vision ? ' Vision review: on.' : ' Vision review: off (R11).'}
          </p>
        </Card>
      ) : null}

      <Card className="p-4">
        <Mono className="text-[11px] uppercase tracking-wider text-ink-muted/70">Thumbnail concepts</Mono>
        {(bundle?.thumbnails?.length ?? 0) > 0 ? (
          <div className="mt-2 grid grid-cols-3 gap-3">
            {bundle!.thumbnails.map((abs, i) => (
              <a key={abs} href={studioUrl(abs)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-card border border-line transition-colors hover:border-accent">
                <img src={studioUrl(abs)} alt={`Thumbnail concept ${i + 1}`} className="w-full" />
              </a>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-ink-muted">Three 1280×720 concepts land here after a production run.</p>
        )}
      </Card>

      <Card className="p-4">
        <Mono className="text-[11px] uppercase tracking-wider text-ink-muted/70">YouTube kit</Mono>
        {bundle?.youtubeKit ? (
          <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-muted">{bundle.youtubeKit}</pre>
        ) : (
          <p className="mt-2 text-[13px] text-ink-muted">Titles, chapters, sources, and tags are written here after a production run.</p>
        )}
      </Card>
    </div>
  )
}
