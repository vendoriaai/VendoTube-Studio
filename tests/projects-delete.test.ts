import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectService } from '../src/main/projects'
import type { Db } from '../src/main/db'

/**
 * better-sqlite3 is built for Electron's ABI, so it cannot load under vitest.
 * `ProjectService.delete` only needs a few statements, so the tests drive a
 * tiny in-memory stand-in: rows are plain objects keyed by id.
 */

interface Row {
  id: string
  name: string
  path: string
  slug: string
  created_at: string
  updated_at: string
  last_opened_at: string | null
  fps: number | null
  runtime_seconds: number | null
  status: string
  stage: string | null
}

function fakeDb(rows: Row[]): Db {
  const noop = { changes: 0 }
  return {
    prepare(sql: string) {
      return {
        get: (id: string) => rows.find((r) => r.id === id),
        all: () => [...rows],
        run: (arg?: unknown) => {
          if (/^DELETE FROM projects WHERE id = \?/.test(sql)) {
            const i = rows.findIndex((r) => r.id === arg)
            if (i >= 0) rows.splice(i, 1)
          }
          return noop
        }
      }
    }
  } as unknown as Db
}

function makeService(): { svc: ProjectService; root: string; rows: Row[] } {
  const base = mkdtempSync(join(tmpdir(), 'vf-projects-'))
  const root = join(base, 'projects')
  mkdirSync(root, { recursive: true })
  const rows: Row[] = []
  return { svc: new ProjectService(fakeDb(rows), () => root), root, rows }
}

/** A registry row for a project folder at `dir`. */
function rowFor(name: string, dir: string): Row {
  const now = new Date().toISOString()
  return {
    id: `id-${name}`,
    name,
    path: dir,
    slug: name,
    created_at: now,
    updated_at: now,
    last_opened_at: null,
    fps: 30,
    runtime_seconds: 180,
    status: 'active',
    stage: 'created'
  }
}

/** Create a project folder on disk and add its registry row. */
function register(rows: Row[], root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'delivery'), { recursive: true })
  writeFileSync(join(dir, 'project.yml'), 'title: t\n')
  writeFileSync(join(dir, 'delivery', 'documentary.mp4'), Buffer.from('fake-master'))
  rows.push(rowFor(name, dir))
  return dir
}

describe('ProjectService.delete', () => {
  it('removes the registry row and the folder in one call', () => {
    const { svc, root, rows } = makeService()
    const dir = register(rows, root, 'film-a')

    const res = svc.delete('id-film-a', true)

    expect(res).toEqual({ folderDeleted: true, registryRemoved: true })
    expect(existsSync(dir)).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('keeps the registry row when the folder cannot be removed', async () => {
    // The 2026-11-18 bug: the row was deleted BEFORE the folder removal threw
    // EBUSY, so the project vanished from the UI while its folder stayed and
    // every retry reported "project not found". A failed folder delete must
    // leave the row so the user can retry.
    //
    // An OS-level lock cannot be reproduced in-process (Node opens files with
    // share-delete), so inside a fresh module graph `rmSync` is made to throw
    // a real EBUSY.
    const base = mkdtempSync(join(tmpdir(), 'vf-locked-'))
    const root = join(base, 'projects')
    const dir = join(root, 'film-locked')
    mkdirSync(join(dir, 'delivery'), { recursive: true })
    writeFileSync(join(dir, 'delivery', 'documentary.mp4'), Buffer.from('m'))
    const rows: Row[] = [rowFor('film-locked', dir)]

    vi.resetModules()
    vi.doMock('node:fs', async (orig) => {
      const real = await orig<typeof import('node:fs')>()
      return {
        ...real,
        rmSync: () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), {
            code: 'EBUSY',
            path: join(dir, 'delivery', 'documentary.mp4')
          })
        }
      }
    })
    try {
      const { ProjectService: Fresh } = await import('../src/main/projects')
      const svc = new Fresh(fakeDb(rows), () => root)

      expect(() => svc.delete('id-film-locked', true)).toThrow(/in use.*documentary\.mp4/s)
      expect(rows).toHaveLength(1)
      expect(existsSync(dir)).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('refuses a folder outside the projects root', () => {
    const { svc, rows } = makeService()
    const root = (svc as unknown as { resolveRoot: () => string }).resolveRoot()
    register(rows, root, 'inside')
    const outside = mkdtempSync(join(tmpdir(), 'vf-outside-'))
    rows[0].path = outside

    expect(() => svc.delete('id-inside', true)).toThrow(/outside the projects root/)
    expect(existsSync(outside)).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it('cleans an orphaned folder whose registry row is already gone', () => {
    // Recovery path for projects stranded by the old row-first delete.
    const { svc, root, rows } = makeService()
    const dir = register(rows, root, 'orphan')
    rows.length = 0

    const res = svc.delete('id-orphan', true, dir)

    expect(res.folderDeleted).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('still rejects an orphaned path outside the root', () => {
    const { svc } = makeService()
    const outside = mkdtempSync(join(tmpdir(), 'vf-outside2-'))
    expect(() => svc.delete('gone', true, outside)).toThrow(/outside the projects root/)
    expect(existsSync(outside)).toBe(true)
  })

  it('registry-only delete keeps the folder on disk', () => {
    const { svc, root, rows } = makeService()
    const dir = register(rows, root, 'keep-me')
    const res = svc.delete('id-keep-me', false)
    expect(res).toEqual({ folderDeleted: false, registryRemoved: true })
    expect(existsSync(dir)).toBe(true)
  })
})