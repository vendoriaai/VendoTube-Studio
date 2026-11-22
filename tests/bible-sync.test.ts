import { describe, expect, it } from 'vitest'
import {
  BibleSyncService,
  collectAssetLinks,
  collectBiblePayload,
  collectSourceLinks,
  type AssetLink,
  type BibleDocumentInput,
  type BibleSyncDeps,
  type BibleSyncInput,
  type SourceLink,
  type SyncUser
} from '../src/main/bibleSync'
import type { BibleBundle } from '../src/shared/ipc'

/** Bible cloud-sync unit tests — pure collectors + the service orchestration
 *  (no electron import; the PostgREST adapter is exercised only live). */

function fixtureBundle(overrides: Partial<BibleBundle> = {}): BibleBundle {
  return {
    bible: {
      title: 'The Vanishing Ice',
      thesis: 'Glacier loss is accelerating',
      targetRuntimeSeconds: 900,
      runtimeDecision: null,
      stylePreset: 'science-explainer',
      emotionalPromise: 'wonder to urgency',
      arc: 'beauty → collapse → agency',
      scenes: [
        {
          id: 's01',
          label: 'HOOK',
          title: 'A River Where Ice Was',
          shows: 'archive footage',
          feels: 'unease',
          motion: 'kenburns',
          look: null,
          onScreenText: '1979',
          durationTargetS: 12,
          claims: ['c-1'],
          assetIds: ['a-1']
        }
      ]
    },
    beats: [
      { id: 'b1', scene: 's01', label: 'hook', startS: 0, durS: 12, curiosity: 8, tension: 5, rehook: false, opensLoop: 'why did it vanish', closesLoop: null }
    ],
    workflow: { scenes: 1 },
    scriptSections: [{ id: 'sec-1', title: 'Hook', body: 'In 1979 this ice was forty meters thick.' }],
    sceneNotes: { s01: 'use the 1979 still' },
    validation: { valid: true, errors: [], warnings: [] },
    stage: 'bible_ready',
    ...overrides
  }
}

describe('collectSourceLinks (websites/articles)', () => {
  it('maps ledger source rows to link rows', () => {
    const rows = [
      {
        source_id: 'src-1',
        source_type: 'article',
        title: 'Glacier Mass Loss Study',
        creator_or_publisher: 'Nature Climate',
        published_date: '2024-01-15',
        url: 'https://www.nature.com/articles/ice-2024',
        license: 'fair use',
        rights_statement: 'quoted excerpt',
        notes: 'core stat'
      }
    ]
    expect(collectSourceLinks(rows)).toEqual([
      {
        url: 'https://www.nature.com/articles/ice-2024',
        title: 'Glacier Mass Loss Study',
        publisher: 'Nature Climate',
        published_date: '2024-01-15',
        source_type: 'article',
        license: 'fair use'
      }
    ])
  })

  it('skips rows without a real http(s) URL and dedupes by URL', () => {
    const rows = [
      { url: '', title: 'no url' },
      { url: 'not-a-url', title: 'bad' },
      { url: 'ftp://files.example.org/x', title: 'ftp' },
      { url: 'https://a.example.org/page', title: 'first' },
      { url: 'https://a.example.org/page', title: 'dup' }
    ]
    const links = collectSourceLinks(rows)
    expect(links).toHaveLength(1)
    expect(links[0].title).toBe('first')
  })
})

describe('collectAssetLinks (images/videos)', () => {
  it('prefers the asset page URL over the direct download URL', () => {
    const rows = [
      {
        assetId: 'a-1',
        assetPageUrl: 'https://commons.wikimedia.org/wiki/File:Ice.jpg',
        downloadUrl: 'https://upload.wikimedia.org/…/Ice.jpg',
        title: 'Ice core',
        mediaType: 'image',
        provider: 'commons',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        creator: 'A. Photographer'
      }
    ]
    expect(collectAssetLinks(rows)).toEqual([
      {
        url: 'https://commons.wikimedia.org/wiki/File:Ice.jpg',
        title: 'Ice core',
        media_type: 'image',
        provider: 'commons',
        license: 'CC BY 4.0',
        license_url: 'https://creativecommons.org/licenses/by/4.0/',
        creator: 'A. Photographer'
      }
    ])
  })

  it('falls back to snake_case fields and the download URL', () => {
    const rows = [{ download_url: 'https://video.example.org/clip.mp4', media_type: 'video', title: 'Clip' }]
    const links = collectAssetLinks(rows)
    expect(links[0].url).toBe('https://video.example.org/clip.mp4')
    expect(links[0].media_type).toBe('video')
  })
})

describe('collectBiblePayload', () => {
  it('stores the bible-section result (text/JSON only) and omits local QC state', () => {
    const payload = collectBiblePayload(fixtureBundle())
    expect(payload.bible).toMatchObject({ title: 'The Vanishing Ice' })
    expect(payload.beats).toHaveLength(1)
    expect(payload.scriptSections).toHaveLength(1)
    expect(payload.sceneNotes).toEqual({ s01: 'use the 1979 still' })
    expect(payload.stage).toBe('bible_ready')
    expect(payload).not.toHaveProperty('validation')
    expect(payload).not.toHaveProperty('workflow')
  })
})

describe('BibleSyncService', () => {
  const input = (over: Partial<BibleSyncInput> = {}): BibleSyncInput => ({
    projectSlug: 'the-vanishing-ice',
    projectTitle: 'The Vanishing Ice',
    bundle: fixtureBundle(),
    sourceRows: [{ url: 'https://a.example.org/x', title: 'X' }],
    assetRows: [{ assetPageUrl: 'https://commons.example.org/y', mediaType: 'image', title: 'Y' }],
    ...over
  })

  function stubDeps(overrides: Partial<BibleSyncDeps> = {}): BibleSyncDeps & { calls: string[]; docInputs: BibleDocumentInput[]; sourceRows: SourceLink[]; assetRows: AssetLink[] } {
    const calls: string[] = []
    const docInputs: BibleDocumentInput[] = []
    const sourceRows: SourceLink[] = []
    const assetRows: AssetLink[] = []
    const user: SyncUser = { id: 'user-1' }
    return {
      calls,
      docInputs,
      sourceRows,
      assetRows,
      getSessionUser: async () => user,
      upsertDocument: async (doc) => {
        calls.push('upsertDocument')
        docInputs.push(doc)
        return { id: 'bible-1' }
      },
      replaceSources: async (_id, rows) => {
        calls.push('replaceSources')
        sourceRows.push(...rows)
      },
      replaceAssets: async (_id, rows) => {
        calls.push('replaceAssets')
        assetRows.push(...rows)
      },
      ...overrides
    }
  }

  it('is a silent skip when Supabase is not configured', async () => {
    const res = await new BibleSyncService(null).sync(input())
    expect(res).toEqual({ saved: false, reason: 'not configured' })
  })

  it('skips with a reason when nobody is signed in', async () => {
    const deps = stubDeps({ getSessionUser: async () => null })
    const res = await new BibleSyncService(deps).sync(input())
    expect(res).toEqual({ saved: false, reason: 'not signed in' })
    expect(deps.calls).toEqual([])
  })

  it('upserts the document then replaces links, returning counts', async () => {
    const deps = stubDeps()
    const res = await new BibleSyncService(deps).sync(input())
    expect(res).toEqual({ saved: true, bibleId: 'bible-1', sources: 1, assets: 1 })
    expect(deps.calls).toEqual(['upsertDocument', 'replaceSources', 'replaceAssets'])
    expect(deps.docInputs[0]).toMatchObject({
      user_id: 'user-1',
      project_slug: 'the-vanishing-ice',
      title: 'The Vanishing Ice',
      stage: 'bible_ready'
    })
    expect(deps.sourceRows[0].url).toBe('https://a.example.org/x')
    expect(deps.assetRows[0].url).toBe('https://commons.example.org/y')
  })

  it('propagates database errors so the caller can disclose them', async () => {
    const deps = stubDeps({
      upsertDocument: async () => {
        throw new Error('bible upsert failed: RLS violated')
      }
    })
    await expect(new BibleSyncService(deps).sync(input())).rejects.toThrow('RLS violated')
  })
})
