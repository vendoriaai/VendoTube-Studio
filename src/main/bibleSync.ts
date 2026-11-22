import type { SupabaseClient } from '@supabase/supabase-js'
import type { BibleBundle } from '@shared/ipc'

/**
 * Cloud-save of the Bible result to the vendoria.ai Supabase project.
 *
 * Runs in the main process after a successful Director run (runDirectorJob in
 * index.ts). Only LINKS are stored — source rows (websites/articles) and asset
 * rows (images/videos) keep their URLs, titles, licenses and creators; the
 * downloaded files themselves never leave the machine (local-first invariant).
 *
 * Layout (co-tenant-safe, `vendotube_` prefix, all RLS-scoped to the owner):
 *   vendotube_bibles        — one row per (user_id, project_slug), payload jsonb
 *   vendotube_bible_sources — website/article links (unique bible_id+url)
 *   vendotube_bible_assets  — image/video links       (unique bible_id+url)
 *
 * This module must stay importable under vitest and plain node (no `electron`
 * import; type-only @shared imports only), so the service takes its database
 * access as an injected `BibleSyncDeps` interface and the PostgREST adapter is
 * a separate thin function.
 */

// ------------------------------------------------------------- row mappers

const HTTP_URL = /^https?:\/\/\S+$/i

export interface SourceLink {
  url: string
  title: string | null
  publisher: string | null
  published_date: string | null
  source_type: string | null
  license: string | null
}

export interface AssetLink {
  url: string
  title: string | null
  media_type: string | null
  provider: string | null
  license: string | null
  license_url: string | null
  creator: string | null
}

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length > 0 ? s : null
}

/** DWK sources.csv rows → link rows (websites/articles). Deduped by URL. */
export function collectSourceLinks(rows: Array<Record<string, unknown>>): SourceLink[] {
  const byUrl = new Map<string, SourceLink>()
  for (const row of rows ?? []) {
    const url = str(row.url)
    if (!url || !HTTP_URL.test(url) || byUrl.has(url)) continue
    byUrl.set(url, {
      url,
      title: str(row.title),
      publisher: str(row.creator_or_publisher ?? row.publisher),
      published_date: str(row.published_date),
      source_type: str(row.source_type),
      license: str(row.license)
    })
  }
  return [...byUrl.values()]
}

/**
 * DWK assets.csv rows → link rows (images/videos). The canonical link is the
 * asset PAGE URL (stable, human-visible); the direct download URL is only used
 * when no page URL exists. Deduped by URL.
 */
export function collectAssetLinks(rows: Array<Record<string, unknown>>): AssetLink[] {
  const byUrl = new Map<string, AssetLink>()
  for (const row of rows ?? []) {
    const url = str(row.assetPageUrl) ?? str(row.asset_page_url) ?? str(row.downloadUrl) ?? str(row.download_url)
    if (!url || !HTTP_URL.test(url) || byUrl.has(url)) continue
    byUrl.set(url, {
      url,
      title: str(row.title),
      media_type: str(row.mediaType ?? row.media_type),
      provider: str(row.provider),
      license: str(row.license),
      license_url: str(row.licenseUrl ?? row.license_url),
      creator: str(row.creator)
    })
  }
  return [...byUrl.values()]
}

/** The Bible-section result that gets stored — text/JSON only, no file blobs. */
export function collectBiblePayload(bundle: BibleBundle): Record<string, unknown> {
  return {
    // The Director's bible + beats + script draft — what the Bible reader shows.
    bible: bundle.bible,
    beats: bundle.beats,
    scriptSections: bundle.scriptSections,
    sceneNotes: bundle.sceneNotes,
    stage: bundle.stage
    // `workflow` (the producer's machine input) and `validation` (local QC
    // state) are intentionally not synced.
  }
}

// ----------------------------------------------------------------- service

export interface SyncUser {
  id: string
}

export interface BibleDocumentInput {
  user_id: string
  project_slug: string
  title: string | null
  stage: string | null
  payload: Record<string, unknown>
  updated_at: string
}

export interface BibleSyncDeps {
  /** Signed-in user from the shared session, or null (caller skips). */
  getSessionUser(): Promise<SyncUser | null>
  /** Upsert on (user_id, project_slug) → the stored document's id. */
  upsertDocument(input: BibleDocumentInput): Promise<{ id: string }>
  /** Replace ALL source links for the document (delete + insert). */
  replaceSources(bibleId: string, rows: SourceLink[]): Promise<void>
  /** Replace ALL asset links for the document (delete + insert). */
  replaceAssets(bibleId: string, rows: AssetLink[]): Promise<void>
}

export interface BibleSyncInput {
  projectSlug: string
  projectTitle: string | null
  bundle: BibleBundle
  /** Raw DWK ledger rows (sources.csv / assets.csv) — mapped to links here. */
  sourceRows: Array<Record<string, unknown>>
  assetRows: Array<Record<string, unknown>>
}

export interface BibleSyncResult {
  saved: boolean
  reason?: string
  bibleId?: string
  sources?: number
  assets?: number
}

export class BibleSyncService {
  /** null = Supabase not configured (no URL/anon key yet).
   *  Explicit field + assignment (not a TS parameter property) so plain-node
   *  type-stripping can load this module for the live scripts. */
  private readonly deps: BibleSyncDeps | null
  constructor(deps: BibleSyncDeps | null) {
    this.deps = deps
  }

  /**
   * Best-effort cloud save. Never throws for the expected skip cases (not
   * configured / not signed in) — returns a reason instead. Database errors
   * DO throw so the caller can disclose them in the activity feed.
   */
  async sync(input: BibleSyncInput): Promise<BibleSyncResult> {
    if (!this.deps) return { saved: false, reason: 'not configured' }
    const user = await this.deps.getSessionUser()
    if (!user) return { saved: false, reason: 'not signed in' }
    const doc = await this.deps.upsertDocument({
      user_id: user.id,
      project_slug: input.projectSlug,
      title: input.projectTitle,
      stage: input.bundle.stage,
      payload: collectBiblePayload(input.bundle),
      updated_at: new Date().toISOString()
    })
    const sources = collectSourceLinks(input.sourceRows)
    const assets = collectAssetLinks(input.assetRows)
    await this.deps.replaceSources(doc.id, sources)
    await this.deps.replaceAssets(doc.id, assets)
    return { saved: true, bibleId: doc.id, sources: sources.length, assets: assets.length }
  }
}

// ------------------------------------------------------- PostgREST adapter

/** Wire the service to a real supabase-js client (same instance as auth —
 *  one client, one session, shared refresh). */
export function createSupabaseBibleSync(client: SupabaseClient): BibleSyncDeps {
  return {
    async getSessionUser() {
      const { data } = await client.auth.getSession()
      const user = data.session?.user
      return user?.id ? { id: user.id } : null
    },
    async upsertDocument(input) {
      const { data, error } = await client
        .from('vendotube_bibles')
        .upsert(input, { onConflict: 'user_id,project_slug' })
        .select('id')
        .single()
      if (error) throw new Error(`bible upsert failed: ${error.message}`)
      if (!data?.id) throw new Error('bible upsert returned no id')
      return { id: data.id }
    },
    async replaceSources(bibleId, rows) {
      const del = await client.from('vendotube_bible_sources').delete().eq('bible_id', bibleId)
      if (del.error) throw new Error(`source link cleanup failed: ${del.error.message}`)
      if (rows.length === 0) return
      const ins = await client.from('vendotube_bible_sources').insert(rows.map((r) => ({ bible_id: bibleId, ...r })))
      if (ins.error) throw new Error(`source link save failed: ${ins.error.message}`)
    },
    async replaceAssets(bibleId, rows) {
      const del = await client.from('vendotube_bible_assets').delete().eq('bible_id', bibleId)
      if (del.error) throw new Error(`asset link cleanup failed: ${del.error.message}`)
      if (rows.length === 0) return
      const ins = await client.from('vendotube_bible_assets').insert(rows.map((r) => ({ bible_id: bibleId, ...r })))
      if (ins.error) throw new Error(`asset link save failed: ${ins.error.message}`)
    }
  }
}
