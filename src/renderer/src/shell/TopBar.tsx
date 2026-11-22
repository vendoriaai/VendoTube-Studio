import { useStudio, STAGE_TABS } from '../state/store'
import { api } from '../lib/api'
import { Badge, Button, Select, cn } from '../components/ui'
import logoMark from '../assets/logo-mark.png'

export function TopBar() {
  const { projects, activeProject, setActiveProject, setStage, theme, setTheme, authUser, setAuthUser, setToast } =
    useStudio()

  const signOut = (): void => {
    // Clear the user even if the server call fails — the gate re-appears and a
    // fresh sign-in re-establishes the session.
    void api
      .authSignOut()
      .catch(() => setToast('Sign-out could not reach the server — signing out locally'))
      .finally(() => setAuthUser(null))
  }

  const cycleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'
    setTheme(next)
    void window.api.invoke('theme:set', next)
  }

  const themeLabel = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🖥'

  return (
    <header className="glass relative z-10 flex h-12 shrink-0 items-center gap-3 border-b border-line px-4 backdrop-blur-md">
      <button
        className="flex items-center gap-2 rounded-input px-1.5 py-1 transition-colors hover:bg-surface-2"
        onClick={() => setStage('home')}
        title="Home — create or open projects"
      >
        <img src={logoMark} alt="" className="h-7 w-7" draggable={false} />
        <span className="font-display text-[14px] font-semibold tracking-wide">VENDOTUBE STUDIO</span>
      </button>
      <Button variant="ghost" className="!px-2 !text-[13px]" onClick={() => setStage('home')} title="Home">
        ⌂
      </Button>
      <Badge tone="accent">M1</Badge>

      <div className="mx-2 h-5 w-px bg-line" />

      <Select
        aria-label="Active project"
        className="max-w-64"
        value={activeProject?.id ?? ''}
        onChange={(e) => {
          const p = projects.find((x) => x.id === e.target.value) ?? null
          setActiveProject(p)
          if (!p) setStage('home')
        }}
      >
        <option value="">No project selected</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>

      <div className="flex-1" />

      <nav className="hidden items-center gap-1 lg:flex" aria-label="Stages">
        {STAGE_TABS.map((t) => (
          <button
            key={t.id}
            className={cn(
              'rounded-input px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink',
              t.needsProject && !activeProject && 'cursor-not-allowed opacity-40 hover:bg-transparent'
            )}
            onClick={() => {
              if (t.needsProject && !activeProject) return
              setStage(t.id)
            }}
            title={t.needsProject && !activeProject ? 'Select or create a project first' : t.label}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      {authUser ? (
        <>
          <span
            className="max-w-44 truncate text-[11px] text-ink-muted"
            title={`Signed in as ${authUser.email ?? authUser.id}`}
          >
            {authUser.email ?? authUser.id}
          </span>
          <Button variant="ghost" onClick={signOut} title="Sign out">
            ⏻
          </Button>
        </>
      ) : null}

      <Button variant="ghost" onClick={cycleTheme} title={`Theme: ${theme}`}>
        {themeLabel}
      </Button>
      <Button variant="ghost" onClick={() => setStage('settings')} title="Settings">
        ⚙
      </Button>
    </header>
  )
}
