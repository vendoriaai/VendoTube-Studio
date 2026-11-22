import { useState } from 'react'
import { api } from '../lib/api'
import { useStudio } from '../state/store'
import { Button, Card, Field, Input, Mono, Select, Spinner } from '../components/ui'
import logoMark from '../assets/logo-mark.png'
import type { ProjectRecord } from '@shared/ipc'

/** Home — new project + recent projects (UI-UX-SPEC §4.1). */

export function Home() {
  const { appInfo, projects, setProjects, setActiveProject, activeProject, setStage, setToast, bridge, keyStatus } = useStudio()
  const [title, setTitle] = useState('')
  const [minutes, setMinutes] = useState('15')
  const [fps, setFps] = useState('60')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  const bridgeReady = bridge.status === 'ready'
  const firstRun = projects.length === 0

  const createSample = async (): Promise<void> => {
    setSeeding(true)
    setError(null)
    try {
      const record = await api.createSampleProject()
      setProjects(await api.listProjects())
      setActiveProject(record)
      setToast('Sample film seeded — open Preview and press produce')
      setStage('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSeeding(false)
    }
  }

  const create = async (): Promise<void> => {
    setError(null)
    if (!title.trim()) {
      setError('Give the film a working title.')
      return
    }
    setBusy(true)
    try {
      const record = await api.createProject({
        title: title.trim(),
        // Empty Minutes = auto: the Director picks the runtime from the research.
        runtimeSeconds: Number(minutes) > 0 ? Math.max(30, Math.round(Number(minutes) * 60)) : undefined,
        fps: Number(fps)
      })
      setProjects(await api.listProjects())
      setActiveProject(record)
      setTitle('')
      setToast(`Project created at ${record.path}`)
      setStage('chat')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Showrunner autopilot (M6): one idea → research → film design → draft.
  const make = async (): Promise<void> => {
    setError(null)
    if (!title.trim()) {
      setError('Describe the film idea first.')
      return
    }
    setBusy(true)
    try {
      const { project } = await api.makeFilm(title.trim(), {
        // Empty Minutes = auto: the Director picks the runtime from the research.
        minutes: Number(minutes) > 0 ? Math.min(60, Math.max(1, Number(minutes))) : undefined,
        fps: Number(fps)
      })
      setProjects(await api.listProjects())
      setActiveProject(project)
      setTitle('')
      setToast('The crew is on it — research → film design → draft render. It will ask once about research media.')
      setStage('chat')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const open = async (path: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { project } = await api.openProject(path)
      setProjects(await api.listProjects())
      setActiveProject(project)
      setStage('chat')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeProject = async (p: ProjectRecord): Promise<void> => {
    if (!window.confirm(`Delete "${p.name}" from the studio?`)) return
    const alsoFolder = window.confirm(
      `Also delete the folder from disk?\n\n${p.path}\n\nOK = delete folder with all research/media\nCancel = keep the folder on disk`
    )
    try {
      const res = await api.deleteProject(p.id, alsoFolder, p.path)
      const remaining = await api.listProjects()
      setProjects(remaining)
      if (activeProject?.id === p.id) setActiveProject(remaining[0] ?? null)
      setToast(`Deleted "${p.name}"${res.folderDeleted ? ' — folder removed' : ' — folder kept on disk'}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aurora mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-10">
      <div className="relative z-10 text-center">
        <img src={logoMark} alt="VendoTube Studio" className="mx-auto mb-5 h-24 w-24" draggable={false} />
        <h1 className="font-display text-[34px] font-semibold leading-tight">What story do we tell today?</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          One brief → a crew of agents → an evidence-led documentary.
        </p>
      </div>

      {firstRun || !keyStatus?.configured ? (
        <Card className="relative z-10 w-full max-w-xl border-accent/40 p-4">
          <h2 className="font-display text-[14px] font-semibold">Get started</h2>
          <ol className="mt-2 space-y-1 text-[12.5px] text-ink-muted">
            <li>
              1. Add your model provider key{' '}
              <Button variant="subtle" className="!px-2 !py-0.5 !text-[11px]" onClick={() => setStage('settings')}>
                open Settings
              </Button>
              {keyStatus?.configured ? <span className="ml-1 text-signal">✓ done</span> : null}
            </li>
            <li>
              2. Make your first film right now — a seeded demo documentary (no research needed):
              <div className="mt-1">
                <Button variant="subtle" className="!px-2 !py-0.5 !text-[11px]" onClick={() => void createSample()} disabled={seeding || !bridgeReady}>
                  {seeding ? 'seeding…' : 'create sample film'}
                </Button>{' '}
                then open <Mono>Preview → produce</Mono>
              </div>
            </li>
            <li>3. Or type an idea below and press <Mono>Make my film</Mono> — the crew runs everything to a draft preview.</li>
          </ol>
        </Card>
      ) : null}

      <Card className="relative z-10 w-full max-w-xl p-5">
        <h2 className="mb-1 font-display text-[16px] font-semibold">New film</h2>
        <p className="mb-4 text-[12px] text-ink-muted">
          The crew runs end-to-end: research → film design → draft preview. It pauses once to ask about research media; narration, rendering and packaging are pre-approved and audited.
        </p>
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
          <Field label="Your idea">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void make()}
              placeholder="The Forgotten City of Cahokia"
              autoFocus
            />
          </Field>
          <Field label="Minutes">
            <Input
              className="w-20"
              type="number"
              min={1}
              max={60}
              placeholder="Auto"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              title="Target film length in minutes. Defaults to 15. Clear it to let the Director decide from your research."
            />
          </Field>
          <Field label="fps">
            <Select value={fps} onChange={(e) => setFps(e.target.value)}>
              {['24', '25', '30', '50', '60'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-muted/80">
          Defaults to a 15-minute film. Clear Minutes to let the Director pick the runtime from your research (it explains its choice in the bible).
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => void make()} disabled={busy || !bridgeReady}>
            {busy ? <Spinner /> : null}
            Make my film
          </Button>
          <Button variant="subtle" onClick={() => void create()} disabled={busy || !bridgeReady} title="Create the project folder only — drive each agent yourself">
            Create empty project
          </Button>
          {!bridgeReady ? <Mono className="text-[11px] text-warm">waiting for the Studio Bridge…</Mono> : null}
          {error ? <span className="text-[12px] text-danger">{error}</span> : null}
        </div>
        {appInfo ? (
          <p className="mt-3 text-[11px] text-ink-muted/80">
            Projects root: <Mono>{appInfo.projectsRoot}</Mono>
          </p>
        ) : null}
      </Card>

      {projects.length > 0 ? (
        <div className="relative z-10 w-full">
          <h2 className="mb-3 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Recent projects</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {projects.map((p) => (
              <Card key={p.id} className="group cursor-pointer p-4 transition-colors hover:border-accent">
                <button className="w-full text-left" onClick={() => void open(p.path)} disabled={busy} title={`Open ${p.path}`}>
                  <div className="font-display text-[14px] font-medium">{p.name}</div>
                  <div className="mt-1 truncate text-[11px] text-ink-muted">{p.path}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <Mono className="text-[10px] text-ink-muted/70">
                      {p.fps ? `${p.fps} fps` : ''} {p.runtimeSeconds ? `· ${Math.round(p.runtimeSeconds / 60)} min` : ''}
                    </Mono>
                  </div>
                </button>
                <div className="mt-2 flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    className="!px-1.5 !py-0.5 !text-[11px] !text-danger"
                    title="Delete project"
                    onClick={() => void removeProject(p)}
                  >
                    delete
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
