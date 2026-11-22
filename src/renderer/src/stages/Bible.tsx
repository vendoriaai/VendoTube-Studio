import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, subscribeEvents } from '../lib/api'
import { useStudio } from '../state/store'
import { Badge, Button, Card, Mono, Spinner, cn } from '../components/ui'
import type { BibleBundle, JobRecord } from '@shared/ipc'

/** Bible Reader (UI-UX-SPEC §4.3): arc chart, scene cards, edits, workflow. */

type ArcPoint = { x: number; y: number; beat: BibleBundle['beats'][number] }

export function Bible() {
  const { activeProject, setToast, upsertJob } = useStudio()
  const [bundle, setBundle] = useState<BibleBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const projectId = activeProject?.id ?? null

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    try {
      setBundle(await api.bibleGet(projectId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
    const off = subscribeEvents({
      onJob: (job: JobRecord) => {
        upsertJob(job)
        if (job.kind === 'director.build' && ['done', 'failed'].includes(job.status)) void refresh()
      },
      onDirector: (payload) => {
        if (payload.projectId !== projectId) return
        setToast(`Director: ${payload.activity.summary?.slice(0, 80) ?? 'working'}`)
      }
    })
    return off
  }, [refresh, projectId, upsertJob, setToast])

  const saveNote = async (sceneId: string): Promise<void> => {
    if (!projectId) return
    await api.bibleSaveSceneNotes(projectId, sceneId, noteDrafts[sceneId] ?? '')
    setToast(`Notes for ${sceneId} saved — include them via /direct <notes>`)
  }

  const direct = async (notes: string): Promise<void> => {
    if (!projectId) return
    await api.directorRun(projectId, notes)
    setToast('Director job queued — watch the jobs rail')
  }

  const arc = useMemo<ArcPoint[]>(() => {
    if (!bundle?.beats?.length) return []
    const total = Math.max(
      1,
      bundle.beats.reduce((m, b) => Math.max(m, b.startS + b.durS), 0)
    )
    return bundle.beats.map((b) => ({
      x: ((b.startS + b.durS / 2) / total) * 100,
      y: 100 - Math.max(b.curiosity, b.tension) * 100,
      beat: b
    }))
  }, [bundle])

  // <polyline> takes a space-separated point list ("x,y x,y …") — not a path
  // "M… L…" string (that typo rendered console errors and no arc line).
  const arcPoints = arc.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  if (!projectId) {
    return <p className="mt-16 text-center text-[13px] text-ink-muted">Select a project first.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Badge tone={bundle?.stage === 'bible_ready' ? 'ok' : 'warn'}>{bundle?.stage ?? 'created'}</Badge>
        {bundle?.validation ? (
          <Badge
            tone={bundle.validation.valid ? 'ok' : 'danger'}
            title={bundle.validation.valid ? undefined : bundle.validation.errors.join('\n')}
          >
            {bundle.validation.valid ? 'DWK validation PASS' : `${bundle.validation.errors.length} validation issue(s)`}
          </Badge>
        ) : null}
        <div className="flex-1" />
        {loading ? <Spinner /> : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      {error ? <div className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">{error}</div> : null}

      {bundle?.validation && !bundle.validation.valid ? (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] leading-relaxed text-danger">
          {bundle.validation.errors.slice(0, 3).map((e, i) => (
            <p key={i}>• {e}</p>
          ))}
          {bundle.validation.errors.length > 3 ? <p>… +{bundle.validation.errors.length - 3} more</p> : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!bundle?.bible ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <p className="font-display text-[18px]">No Bible yet</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              Run <Mono>/direct</Mono> in Chat (after /research) — the Director designs the film: thesis, arc, scenes, emotional
              beats, script, shot list, and the executable workflow.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            <div>
              <h1 className="font-display text-[24px] font-semibold">{bundle.bible.title}</h1>
              <p className="mt-1 text-[13px] text-ink-muted">{bundle.bible.thesis}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="accent">
                  {bundle.bible.runtimeDecision
                    ? `≈ ${Math.round(bundle.bible.targetRuntimeSeconds / 60)} min — decided from research`
                    : `${Math.round(bundle.bible.targetRuntimeSeconds / 60)} min target`}
                </Badge>
                <Badge>{bundle.bible.stylePreset}</Badge>
                <Badge tone="ok">{bundle.bible.emotionalPromise}</Badge>
              </div>
              {bundle.bible.runtimeDecision ? (
                <p className="mt-1 text-[12px] text-ink-muted">Runtime: {bundle.bible.runtimeDecision}</p>
              ) : null}
            </div>

            {/* Emotional arc (SVG) */}
            {arc.length > 1 ? (
              <Card className="p-4">
                <h2 className="mb-2 font-display text-[14px] font-semibold">Emotional arc</h2>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-32 w-full">
                  <polyline points={arcPoints} fill="none" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
                  {arc.map((p) => (
                    <circle key={p.beat.id} cx={p.x} cy={p.y} r="1.1" fill="var(--signal)" />
                  ))}
                </svg>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {bundle.beats.map((b) => (
                    <Mono key={b.id} className="text-[10px] text-ink-muted">
                      {b.id}·{b.label}
                      {b.rehook ? ' ↻' : ''}
                    </Mono>
                  ))}
                </div>
              </Card>
            ) : null}

            {/* Arc paragraph */}
            <Card className="p-4">
              <h2 className="mb-1 font-display text-[14px] font-semibold">Arc</h2>
              <p className="text-[13px] leading-relaxed">{bundle.bible.arc}</p>
            </Card>

            {/* Scene cards */}
            {bundle.bible.scenes.map((scene) => {
              const sceneBeats = bundle.beats.filter((b) => b.scene === scene.id)
              return (
                <Card key={scene.id} className="p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{scene.id}</Badge>
                    <Badge>{scene.label}</Badge>
                    <span className="font-display text-[15px] font-semibold">{scene.title}</span>
                    <Mono className="ml-auto text-[11px] text-ink-muted">{scene.durationTargetS}s</Mono>
                  </div>
                  <div className="space-y-1.5 text-[12.5px] leading-relaxed">
                    <p>
                      <span className="font-medium text-signal">shows:</span> {scene.shows}
                    </p>
                    <p>
                      <span className="font-medium text-warm">feels:</span> {scene.feels}
                    </p>
                    <p className="text-ink-muted">
                      <span className="font-medium">motion:</span> {scene.motion}
                    </p>
                    {scene.look ? (
                      <p className="text-ink-muted">
                        <span className="font-medium text-accent">look:</span> {scene.look}
                      </p>
                    ) : null}
                    <p className="text-ink-muted">
                      <span className="font-medium">on-screen:</span> {scene.onScreenText}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {scene.claims.map((c) => (
                      <Chip key={c} tone="accent">
                        {c}
                      </Chip>
                    ))}
                    {scene.assetIds.map((a) => (
                      <Chip key={a}>{a}</Chip>
                    ))}
                    {sceneBeats.map((b) => (
                      <Chip key={b.id} tone="neutral">
                        {b.id} · {Math.round(b.curiosity * 100)}%✦ {Math.round(b.tension * 100)}%⚡
                        {b.opensLoop ? ' ↺' : ''}
                        {b.closesLoop ? ' ✓' : ''}
                      </Chip>
                    ))}
                  </div>
                  {/* Notes-to-Director editor */}
                  <div className="mt-3 border-t border-line pt-2">
                    <textarea
                      className="w-full rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-muted/60 focus:border-accent focus:outline-none"
                      rows={2}
                      placeholder="Notes to the Director for this scene (applied via /direct <notes>)…"
                      value={noteDrafts[scene.id] ?? bundle.sceneNotes[scene.id] ?? ''}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [scene.id]: e.target.value }))}
                    />
                    <div className="mt-1.5 flex justify-end">
                      <Button variant="subtle" className="!px-2 !py-0.5 !text-[11px]" onClick={() => void saveNote(scene.id)}>
                        Save note
                      </Button>
                    </div>
                  </div>
                </Card>
              )
            })}

            {/* Script preview */}
            {bundle.scriptSections?.length ? (
              <Card className="p-4">
                <h2 className="mb-2 font-display text-[14px] font-semibold">Script ({bundle.scriptSections.length} sections)</h2>
                {bundle.scriptSections.map((s) => (
                  <div key={s.id} className="mb-3 border-l-2 border-accent/40 pl-3">
                    <Mono className="text-[10.5px] text-accent">
                      [{s.id}] {s.title}
                    </Mono>
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{s.body}</p>
                  </div>
                ))}
              </Card>
            ) : null}

            {/* Workflow summary */}
            {bundle.workflow ? (
              <Card className="p-4">
                <h2 className="mb-2 font-display text-[14px] font-semibold">Executable workflow</h2>
                <Mono className="block whitespace-pre-wrap text-[11px] leading-relaxed text-ink-muted">
                  {JSON.stringify(bundle.workflow, null, 2).slice(0, 1800)}
                </Mono>
              </Card>
            ) : null}

            {/* Style editor (M4, DATA-SCHEMA §6) */}
            {projectId ? <StylePanel projectId={projectId} preset={bundle.bible?.stylePreset ?? 'vox-explainer'} onSaved={setToast} /> : null}

            <div className="pb-6 pt-2 text-center">
              <Button onClick={() => void direct('revise with the saved scene notes')}>↻ Regenerate with saved notes</Button>
              <p className="mt-2 text-[11px] text-ink-muted/70">
                or in Chat: <Mono>/direct focus more on the decline era</Mono>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'accent' | 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px]',
        tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-muted'
      )}
    >
      {children}
    </span>
  )
}

/** Design systems the Director picks from (DATA-SCHEMA §6); user can override per project. */
const STYLE_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'vox-explainer', label: 'vox-explainer — editorial grid (black/cream/acid)' },
  { id: 'kallaway', label: 'kallaway — premium glass' },
  { id: 'true-crime', label: 'true-crime — case file (kraft/letterpress)' },
  { id: 'archival-history', label: 'archival-history — newsprint broadsheet' },
  { id: 'science-explainer', label: 'science-explainer — vivid navy' },
  { id: 'investigative-cinema', label: 'investigative-cinema — cinematic noir' },
  { id: 'business-clean', label: 'business-clean — clean data' }
]

/** Per-project style.json editor (M4). Tokens apply at the next composition build. */
function StylePanel({ projectId, preset, onSaved }: { projectId: string; preset: string; onSaved: (msg: string | null) => void }) {
  const [style, setStyle] = useState<import('@shared/ipc').ProjectStyle | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api.styleGet(projectId).then((s) => setStyle(s ?? {}))
  }, [projectId])

  const set = (patch: Partial<import('@shared/ipc').ProjectStyle>): void => {
    setStyle((prev) => ({ ...(prev ?? {}), ...patch }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (!style) return
    setSaving(true)
    try {
      await api.styleSave(projectId, style)
      setDirty(false)
      onSaved('Style saved — re-run /produce to rebuild compositions with it.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-[14px] font-semibold">Style</h2>
        <Chip tone="accent">{style?.preset || preset}</Chip>
        <div className="ml-auto">
          <Button variant="ghost" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'saving…' : dirty ? 'save style' : 'saved'}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-muted">Overrides written to studio/style.json — applied when compositions rebuild.</p>
      {style?.look ? (
        <p className="mt-1 border-l-2 border-accent/50 pl-2 text-[11.5px] italic text-ink-muted">Director&rsquo;s look: {style.look}</p>
      ) : null}
      {style?.transition_set ? (
        <p className="mt-1 text-[11.5px] text-ink-muted">Transition signature: {style.transition_set} (scenes that author none inherit it)</p>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-[12.5px]">
          Preset
          <select
            className="rounded border border-line bg-surface-2 px-2 py-1 text-[12.5px]"
            value={style?.preset ?? ''}
            onChange={(e) => set({ preset: e.target.value })}
          >
            <option value="">bible default</option>
            {STYLE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          Accent
          <input
            type="color"
            className="h-7 w-10 cursor-pointer rounded border border-line bg-transparent"
            value={style?.accent ?? '#37BDF8'}
            onChange={(e) => set({ accent: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          Captions
          <select
            className="rounded border border-line bg-surface-2 px-2 py-1 text-[12.5px]"
            value={style?.caption_style ?? 'kinetic'}
            onChange={(e) => set({ caption_style: e.target.value })}
          >
            <option value="kinetic">kinetic</option>
            <option value="boxed">boxed</option>
            <option value="off">off</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={style?.vignette !== false} onChange={(e) => set({ vignette: e.target.checked })} />
          Vignette
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={style?.grain !== false} onChange={(e) => set({ grain: e.target.checked })} />
          Film grain
        </label>
      </div>
    </Card>
  )
}
