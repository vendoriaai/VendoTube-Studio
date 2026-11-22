import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { useStudio } from '../state/store'
import { Mono } from '../components/ui'

/**
 * Command palette (UI-UX-SPEC §4.2 composer, M5): ⌘K/Ctrl+K opens a filtered
 * command list; Esc closes; stage shortcuts 1–6 live in App's key handler.
 */

interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void | Promise<void>
}

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeProject, setStage, setToast, theme, setTheme, setProjects, setActiveProject } = useStudio()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const commands = useMemo<Array<PaletteCommand>>(() => {
    const go = (stage: Parameters<typeof setStage>[0], label: string, hint: string): PaletteCommand => ({
      id: `go:${stage}`,
      label,
      hint,
      run: () => setStage(stage)
    })
    const list: PaletteCommand[] = [
      go('chat', 'Go to Chat', '1'),
      go('bible', 'Go to Bible', '2'),
      go('assets', 'Go to Assets', '3'),
      go('script', 'Go to Script', '4'),
      go('preview', 'Go to Preview', '5'),
      go('delivery', 'Go to Delivery', '6'),
      go('settings', 'Open Settings', '⌘,'),
      go('home', 'Go Home (project list)', '')
    ]
    if (activeProject) {
      list.push({
        id: 'produce',
        label: `Produce film (draft) — ${activeProject.name}`,
        hint: '',
        run: () => {
          void api.produceRun(activeProject.id, undefined, 'draft')
          setStage('preview')
          setToast('Producer queued (draft) — gates will pause for you')
        }
      })
    }
    list.push({
      id: 'theme',
      label: `Switch theme (${theme})`,
      hint: '',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
    })
    list.push({
      id: 'sample',
      label: 'Create the sample demo film',
      hint: 'onboarding',
      run: async () => {
        const record = await api.createSampleProject()
        setProjects(await api.listProjects())
        setActiveProject(record)
        setStage('preview')
        setToast('Sample film seeded — press produce')
      }
    })
    return list
  }, [activeProject, theme, setStage, setToast, setTheme, setProjects, setActiveProject])

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))

  if (!open) return null

  const run = (c: PaletteCommand | undefined): void => {
    if (!c) return
    onClose()
    void c.run()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-card border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder="Type a command…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-ink-muted/60"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-[13px] text-ink-muted">No matching command.</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] ${i === index ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2'}`}
                  onClick={() => run(c)}
                  onMouseEnter={() => setIndex(i)}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint ? <Mono className="shrink-0 text-[10px] text-ink-muted/60">{c.hint}</Mono> : null}
                  {i === index ? <span className="shrink-0 text-[10px] text-ink-muted/60">↵</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-line px-4 py-1.5 text-[10.5px] text-ink-muted/70">
          <Mono>↑↓</Mono> navigate · <Mono>↵</Mono> run · <Mono>Esc</Mono> close · <Mono>1–6</Mono> stages
        </div>
      </div>
    </div>
  )
}

export function usePaletteHotkey(setOpen: (v: boolean) => void): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])
  return null
}
