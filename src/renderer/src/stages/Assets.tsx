import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, studioUrl } from '../lib/api'
import { useStudio } from '../state/store'
import { Badge, Button, Card, Mono, Spinner, cn } from '../components/ui'
import type { AssetRecord } from '@shared/ipc'

/** Asset Library (PRD F4) — candidates with rights gates, downloads, sources, evidence. */

type SubTab = 'candidates' | 'library' | 'sources' | 'evidence'

function licenseTone(license: string): 'ok' | 'warn' | 'neutral' {
  const s = license.toLowerCase().replace(/\s/g, '')
  if (s.startsWith('unverified')) return 'warn'
  if (s.includes('publicdomain') || s.includes('cc0')) return 'ok'
  if (s.includes('cc by') || s.includes('ccby')) return s.includes('nc') || s.includes('nd') ? 'warn' : 'ok'
  return 'neutral'
}

export function Assets() {
  const { activeProject, setToast } = useStudio()
  const [subTab, setSubTab] = useState<SubTab>('candidates')
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const projectId = activeProject?.id ?? null

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const view = await api.assetsList(projectId)
      setAssets(view.assets)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
    setSelected(new Set())
  }, [refresh])

  // Auto-refresh when a download or scout job for this project finishes.
  const jobs = useStudio((s) => s.jobs)
  const lastJob = useMemo(() => Object.values(jobs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0], [jobs])
  const [dataVersion, setDataVersion] = useState(0)
  useEffect(() => {
    if (lastJob && ['done', 'failed'].includes(lastJob.status) && ['assets.download', 'scout.research'].includes(lastJob.kind)) {
      void refresh()
      setDataVersion((v) => v + 1)
    }
  }, [lastJob?.id, lastJob?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = assets.filter((a) => !a.downloaded)
  const downloaded = assets.filter((a) => a.downloaded)

  const allCandidatesSelected = candidates.length > 0 && candidates.every((a) => selected.has(a.assetId))
  const toggleSelectAll = (): void => {
    setSelected(allCandidatesSelected ? new Set() : new Set(candidates.map((a) => a.assetId)))
  }

  const approve = async (approved: boolean): Promise<void> => {
    if (!projectId || selected.size === 0) return
    try {
      const res = await api.assetsSetRights(projectId, [...selected], approved)
      setToast(`${approved ? 'Approved' : 'Reset'} ${res.changed} asset(s) — gate ${approved ? 'G-C' : 'reset'} applied`)
      setSelected(new Set())
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const download = async (): Promise<void> => {
    if (!projectId) return
    const targetIds = [...selected].filter((id) => {
      const asset = candidates.find((c) => c.assetId === id)
      return asset && asset.rightsStatus === 'approved'
    })
    if (targetIds.length === 0) {
      setToast('Select approved rows to download (gate G-B blocks unapproved rows — by design).')
      return
    }
    await api.assetsDownload(projectId)
    setToast('Download job queued — DWK downloads approved, allow-listed rows only (gate G-B).')
  }

  const openExternal = (url: string): void => {
    window.open(url, '_blank')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        {(['candidates', 'library', 'sources', 'evidence'] as SubTab[]).map((t) => (
          <button
            key={t}
            className={cn(
              'rounded-input px-3 py-1 text-[12.5px] capitalize transition-colors',
              subTab === t ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
            )}
            onClick={() => setSubTab(t)}
          >
            {t === 'library' ? `Library (${downloaded.length})` : t}
            {t === 'candidates' ? ` (${candidates.length})` : ''}
          </button>
        ))}
        <div className="flex-1" />
        {loading ? <Spinner /> : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      {error ? <div className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">{error}</div> : null}

      {subTab === 'candidates' || subTab === 'library' ? (
        <>
          {subTab === 'candidates' ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-elevated px-3 py-2 text-[12px]">
              <label className="flex cursor-pointer items-center gap-1.5 text-ink-muted">
                <input
                  type="checkbox"
                  checked={allCandidatesSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.size > 0 && !allCandidatesSelected
                  }}
                  onChange={toggleSelectAll}
                />
                Select all
              </label>
              <span className="text-ink-muted">Selected: {selected.size}</span>
              <Button variant="subtle" disabled={selected.size === 0} onClick={() => void approve(true)}>
                Approve rights (G-C)
              </Button>
              <Button variant="ghost" disabled={selected.size === 0} onClick={() => void approve(false)}>
                Reset to review
              </Button>
              <Button onClick={() => void download()} disabled={loading}>
                Download approved (G-B)
              </Button>
              <span className="text-[11px] text-ink-muted/70">
                DWK downloads only approved rows with allow-listed licenses (PD / CC0 / CC BY).
              </span>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {(subTab === 'candidates' ? candidates : downloaded).length === 0 ? (
              <p className="mt-16 text-center text-[13px] text-ink-muted">
                {subTab === 'candidates'
                  ? 'No candidates yet — run `/research <topic>` in Chat and Scout will propose media.'
                  : 'Nothing downloaded yet — approve rights on candidates and run the gated download.'}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                {(subTab === 'candidates' ? candidates : downloaded).map((a) => (
                  <AssetCard
                    key={a.assetId}
                    asset={a}
                    projectId={projectId}
                    projectPath={activeProject?.path ?? ''}
                    selectable={subTab === 'candidates'}
                    checked={selected.has(a.assetId)}
                    onCheck={(on) =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (on) next.add(a.assetId)
                        else next.delete(a.assetId)
                        return next
                      })
                    }
                    onOpen={openExternal}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {subTab === 'sources' ? <SourcesView projectId={projectId} dataVersion={dataVersion} /> : null}
      {subTab === 'evidence' ? <EvidenceView projectId={projectId} dataVersion={dataVersion} /> : null}
    </div>
  )
}

// ------------------------------------------------------------- asset card

function AssetCard({
  asset,
  projectId,
  projectPath,
  selectable,
  checked,
  onCheck,
  onOpen
}: {
  asset: AssetRecord
  projectId: string | null
  projectPath: string
  selectable: boolean
  checked: boolean
  onCheck: (on: boolean) => void
  onOpen: (url: string) => void
}) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (asset.downloaded && projectId && projectPath && asset.savedPath && ['image', 'video'].includes(asset.mediaType.toLowerCase())) {
      const absMedia = joinAbs(projectPath, asset.savedPath)
      void api
        .assetsThumb(projectId, absMedia)
        .then((rel) => {
          if (!cancelled && rel) setThumb(studioUrl(joinAbs(absMedia, rel)))
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [asset.assetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusTone = asset.rightsStatus === 'approved' ? 'ok' : asset.rightsStatus === 'blocked' ? 'danger' : 'warn'

  return (
    <Card className={cn('overflow-hidden p-0', checked && 'border-accent')}>
      <div className="relative grid h-28 place-items-center bg-surface-2">
        {thumb ? (
          <img src={thumb} alt="" className="h-28 w-full object-cover" />
        ) : (
          <span className="text-[22px] opacity-40">
            {/video/.test(asset.mediaType.toLowerCase()) ? '🎬' : /audio/.test(asset.mediaType.toLowerCase()) ? '🎵' : /document|pdf/.test(asset.mediaType.toLowerCase()) ? '📄' : '🖼'}
          </span>
        )}
        {selectable ? (
          <input
            type="checkbox"
            className="absolute left-2 top-2 h-4 w-4 accent-[var(--accent)]"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={`select ${asset.assetId}`}
          />
        ) : null}
        <Badge tone={statusTone} className="absolute right-2 top-2">
          {asset.rightsStatus}
        </Badge>
      </div>
      <div className="space-y-1 p-2.5">
        <div className="truncate text-[12.5px] font-medium" title={asset.title || asset.filename}>
          {asset.title || asset.filename || asset.assetId}
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone={licenseTone(asset.license)}>{asset.license || 'unknown license'}</Badge>
          <Mono className="text-[10px] text-ink-muted">{asset.assetId}</Mono>
        </div>
        {asset.creator ? <div className="truncate text-[11px] text-ink-muted">by {asset.creator}</div> : null}
        {asset.downloaded && asset.sha256 ? (
          <span title={asset.sha256} className="block">
            <Mono className="block truncate text-[10px] text-ink-muted/70">sha256 {asset.sha256.slice(0, 12)}…</Mono>
          </span>
        ) : null}
        <button className="text-[11px] text-accent hover:underline" onClick={() => onOpen(asset.assetPageUrl)}>
          item page ↗
        </button>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------ views

function SourcesView({ projectId, dataVersion }: { projectId: string | null; dataVersion: number }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  useEffect(() => {
    if (!projectId) return
    void api
      .ledgerList(projectId, 'sources')
      .then(setRows)
      .catch(() => setRows([]))
  }, [projectId, dataVersion])
  if (!rows.length) return <Empty text="No sources registered yet — Scout fills this ledger." />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <table className="w-full text-left text-[12px]">
        <thead className="text-ink-muted">
          <tr>
            <th className="px-2 py-1.5">id</th>
            <th className="px-2 py-1.5">title</th>
            <th className="px-2 py-1.5">type</th>
            <th className="px-2 py-1.5">url</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line/60">
              <td className="px-2 py-1.5"><Mono>{String(r.source_id ?? '')}</Mono></td>
              <td className="max-w-72 truncate px-2 py-1.5" title={String(r.title ?? '')}>{String(r.title ?? '')}</td>
              <td className="px-2 py-1.5 text-ink-muted">{String(r.source_type ?? '')}</td>
              <td className="max-w-56 truncate px-2 py-1.5">
                <button className="text-accent hover:underline" onClick={() => window.open(String(r.url ?? ''), '_blank')}>
                  {String(r.url ?? '')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EvidenceView({ projectId, dataVersion }: { projectId: string | null; dataVersion: number }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  useEffect(() => {
    if (!projectId) return
    void api
      .ledgerList(projectId, 'evidence')
      .then(setRows)
      .catch(() => setRows([]))
  }, [projectId, dataVersion])
  if (!rows.length) return <Empty text="No claims logged yet — Scout logs claims with locators and confidence." />
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {rows.map((r, i) => (
        <Card key={i} className="p-3">
          <div className="mb-1 flex items-center gap-2">
            <Mono className="text-[11px]">{String(r.claim_id ?? '')}</Mono>
            <Mono className="text-[11px] text-ink-muted">{String(r.source_id ?? '')}</Mono>
            {r.confidence ? (
              <Badge tone={r.confidence === 'high' ? 'ok' : r.confidence === 'low' ? 'warn' : 'neutral'}>{String(r.confidence)}</Badge>
            ) : null}
          </div>
          <p className="text-[12.5px] leading-relaxed">{String(r.claim_text ?? '')}</p>
          <p className="mt-1 text-[11px] text-ink-muted">
            locator: {String(r.locator ?? '—')}
            {r.exact_support_or_quote ? ` · “${String(r.exact_support_or_quote).slice(0, 120)}”` : ''}
          </p>
        </Card>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="mt-16 text-center text-[13px] text-ink-muted">{text}</p>
}

function joinAbs(abs: string, rel: string): string {
  return abs.replace(/[\\/]+$/, '') + '\\' + rel.replace(/[\\/]+$/, '')
}
