import { useStudio } from '../state/store'
import { Mono, StatusDot, cn } from '../components/ui'

/** Crew roster + project tree (UI-UX-SPEC §3). Agents arrive M1+. */

const CREW = [
  { id: 'showrunner', name: 'Showrunner', milestone: 'M1', blurb: 'orchestrator' },
  { id: 'scout', name: 'Scout', milestone: 'M1', blurb: 'research & harvest' },
  { id: 'director', name: 'Director', milestone: 'M2', blurb: 'bible & script' },
  { id: 'producer', name: 'Producer', milestone: 'M3', blurb: 'make the film' }
]

const TREE = ['research/', 'media/', 'production/', 'studio/', 'delivery/', 'qc/']

export function CrewRail() {
  const { activeProject, projects, setActiveProject, setStage } = useStudio()

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-bg-elevated p-3">
      <section>
        <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Crew</h2>
        <ul className="space-y-1">
          {CREW.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded-input px-2 py-1.5 text-[13px] text-ink-muted" title={`Arrives in ${m.milestone}`}>
              <StatusDot tone="muted" />
              <span>{m.name}</span>
              <Mono className="ml-auto text-[10px] text-ink-muted/70">{m.milestone}</Mono>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Projects</h2>
        <ul className="space-y-0.5">
          {projects.length === 0 ? <li className="px-2 text-[12px] text-ink-muted/70">None yet</li> : null}
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={cn(
                  'w-full truncate rounded-input px-2 py-1.5 text-left text-[13px] transition-colors',
                  activeProject?.id === p.id ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                )}
                onClick={() => {
                  setActiveProject(p)
                  setStage('chat')
                }}
                title={p.path}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {activeProject ? (
        <section className="min-h-0 flex-1">
          <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{activeProject.slug}</h2>
          <ul className="space-y-0.5">
            {TREE.map((entry) => (
              <li key={entry} className="rounded-input px-2 py-1 font-mono text-[11.5px] text-ink-muted/80">
                {entry}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  )
}
