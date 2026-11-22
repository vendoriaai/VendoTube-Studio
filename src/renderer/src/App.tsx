import { useEffect, useState, type ReactNode } from 'react'
import { api, subscribeEvents } from './lib/api'
import { listenForReleaseRequests } from './lib/media-handles'
import { useStudio } from './state/store'
import { TopBar } from './shell/TopBar'
import { CrewRail } from './shell/CrewRail'
import { JobsRail } from './shell/JobsRail'
import { Inspector } from './shell/Inspector'
import { StatusBar } from './shell/StatusBar'
import { Palette, usePaletteHotkey } from './shell/Palette'
import { Home } from './stages/Home'
import { Chat } from './stages/Chat'
import { Settings } from './stages/Settings'
import { Assets } from './stages/Assets'
import { Bible } from './stages/Bible'
import { Preview } from './stages/Preview'
import { Delivery } from './stages/Delivery'
import { Placeholder } from './stages/Placeholder'
import { Auth } from './stages/Auth'
import logoMark from './assets/logo-mark.png'
import type { ThemeMode } from '@shared/ipc'

/** Shell layout: glass top bar / crew rail / stage / inspector / status bar. */

export default function App() {
  const {
    theme,
    stage,
    activeProject,
    setTheme,
    setAppInfo,
    setProjects,
    setJobs,
    setBridge,
    setKeyStatus,
    upsertJob,
    booted,
    setBooted,
    setStage,
    appInfo,
    authUser,
    authOffline,
    setAuthUser,
    setAuthConfigured,
    setAuthOffline
  } = useStudio()
  const [paletteOpen, setPaletteOpen] = useState(false)
  usePaletteHotkey(setPaletteOpen)

  // Stage shortcuts 1–6 (UI-UX-SPEC §5) — ignored while typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const stages = ['chat', 'bible', 'assets', 'script', 'preview', 'delivery'] as const
      const n = Number(e.key)
      if (n >= 1 && n <= 6) {
        setStage(stages[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setStage])

  // Boot: info + persisted state + event subscriptions.
  useEffect(() => {
    // Answer main's "release media handles" request before a project delete,
    // so a preview stream never keeps the folder locked (2026-11-19).
    listenForReleaseRequests()
    let disposed = false
    const boot = async (): Promise<void> => {
      const [info, themeMode, projects, jobs, keyStatus, bridgeState, authSt] = await Promise.all([
        api.appInfo(),
        api.getTheme(),
        api.listProjects(),
        api.listJobs(),
        api.providerKeyStatus().catch(() => null),
        api.bridgeStatus().catch(() => null),
        api.authStatus().catch(() => null)
      ])
      if (disposed) return
      setAppInfo(info)
      setTheme(themeMode)
      setProjects(projects)
      setJobs(jobs)
      if (keyStatus) setKeyStatus(keyStatus)
      // Sync bridge status at boot — the ready event may have fired before
      // this window's listeners existed.
      if (bridgeState) setBridge(bridgeState.status, bridgeState.detail)
      // Supabase session restore (auth gate). null = auth:status itself failed;
      // the gate then shows the generic form and surfaces any live errors.
      if (authSt) {
        setAuthConfigured(authSt.configured)
        setAuthUser(authSt.user)
        setAuthOffline(authSt.offline)
      }
      setBooted(true)
    }
    void boot().catch((err) => console.error('boot failed', err))
    const off = subscribeEvents({
      onJob: (job) => upsertJob(job),
      onBridge: ({ status, detail }) => setBridge(status, detail),
      onProvider: () => void api.providerKeyStatus().then((k) => useStudio.getState().setKeyStatus(k)),
      onScout: () => undefined // Scout activity is consumed by the Chat stage
    })
    return () => {
      disposed = true
      off()
    }
  }, [setAppInfo, setTheme, setProjects, setJobs, setKeyStatus, setBridge, upsertJob, setBooted, setAuthUser, setAuthConfigured, setAuthOffline])

  // Theme application (dark is the design default).
  useEffect(() => {
    const resolve = (): 'dark' | 'light' =>
      theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme
    const apply = (): void => {
      document.documentElement.dataset.theme = resolve()
    }
    apply()
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // Keep main's theme row in sync when changed from TopBar.
  useEffect(() => {
    if (booted) void window.api.invoke('theme:set', useStudio.getState().theme as ThemeMode).catch(() => undefined)
  }, [theme, booted])

  const stageEl = (): ReactNode => {
    if (stage === 'home' || (!activeProject && stage !== 'chat' && stage !== 'settings')) return <Home />
    switch (stage) {
      case 'chat':
        return <Chat />
      case 'settings':
        return <Settings />
      case 'assets':
        return <Assets />
      case 'bible':
        return <Bible />
      case 'script':
        return <Placeholder stage={stage} />
      case 'preview':
        return <Preview />
      case 'delivery':
        return <Delivery />
      default:
        return <Home />
    }
  }

  // Boot splash — avoids a flash of the gate/shell while IPC is in flight.
  if (!booted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <img src={logoMark} alt="" className="h-14 w-14 opacity-80" draggable={false} />
        <span className="text-[12px] text-ink-muted">Starting VendoTube Studio…</span>
      </div>
    )
  }

  // Sign-in gate (Supabase). Smoke runs bypass it — the exit-criteria harness
  // must not depend on a cloud account. A session that can't be verified
  // (offline) re-enters the gate with a retry card.
  const smoke = appInfo?.smoke === true
  if (!smoke && (!authUser || authOffline)) {
    return <Auth />
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {stage !== 'settings' ? <CrewRail /> : null}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">{stageEl()}</div>
          <JobsRail />
        </main>
        <Inspector />
      </div>
      <StatusBar />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
