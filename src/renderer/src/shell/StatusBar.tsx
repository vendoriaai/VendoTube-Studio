import { useStudio } from '../state/store'
import { Mono, StatusDot } from '../components/ui'

export function StatusBar() {
  const { bridge, provider, keyStatus, jobs, appInfo } = useStudio()
  const activeCount = Object.values(jobs).filter((j) => ['queued', 'running'].includes(j.status)).length
  const bridgeTone = bridge.status === 'ready' ? 'ok' : bridge.status === 'starting' ? 'warn' : 'err'
  const providerTone = provider?.ok ? 'ok' : keyStatus?.configured ? 'warn' : 'muted'

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-bg-elevated px-3 text-[11px] text-ink-muted">
      <span className="flex items-center gap-1.5" title={bridge.detail ?? undefined}>
        <StatusDot tone={bridgeTone} pulse={bridge.status === 'starting'} />
        Bridge: <Mono className="text-[11px]">{bridge.status}</Mono>
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot tone={providerTone} />
        Provider: <Mono className="text-[11px]">{provider?.ok ? 'ok' : keyStatus?.configured ? 'key set' : 'no key'}</Mono>
      </span>
      <span className="flex-1" />
      <span>
        Jobs: <Mono className="text-[11px]">{activeCount}</Mono>
      </span>
      <span>
        <Mono className="text-[11px]">v{appInfo?.version ?? '—'}</Mono>
      </span>
    </footer>
  )
}
