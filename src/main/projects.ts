import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Db } from './db'
import type { ProjectRecord } from '@shared/ipc'

/** Project registry — SQLite rows pointing at portable DWK-layout folders. */

/**
 * Delete a project folder. A rendered master (`delivery/documentary.mp4`) is
 * commonly held for a moment by OneDrive sync or a video player; naming the
 * locked file beats silently leaving a half-deleted folder behind.
 *
 * Exported so tests can inject a failure — an OS lock (EBUSY) cannot be
 * reproduced in-process, since Node opens files with share-delete.
 */
export function removeProjectFolder(dir: string): void {
  try {
    // rmSync's own retries cover a lock released within a few hundred ms;
    // beyond that the folder is genuinely in use.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const file = e.path
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      throw new Error(
        `A file in this project is in use${file ? `: ${file}` : ''}. Close it (or pause OneDrive sync) and delete again — the project was kept on disk, so nothing is lost.`
      )
    }
    throw new Error(`Could not delete the project folder${file ? ` (${file})` : ''}: ${e.message}`)
  }
}

interface ProjectRow {
  id: string
  name: string
  path: string
  slug: string
  fps: number | null
  runtime_seconds: number | null
  created_at: string
  updated_at: string
  last_opened_at: string | null
  status: string
  stage: string | null
}

const DEFAULT_FPS = 60

function mapRow(r: ProjectRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    slug: r.slug,
    fps: r.fps,
    runtimeSeconds: r.runtime_seconds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastOpenedAt: r.last_opened_at,
    status: r.status === 'archived' ? 'archived' : 'active',
    stage: r.stage ?? 'created'
  }
}

export function slugify(text: string): string {
  // Mirrors DWK's slugify (workflow/init_project.py) so both stay identical.
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documentary'
  )
}

/** The slice of BridgeClient that project creation needs. */
export interface ProjectServiceBridge {
  initProject(params: { path: string; title: string; fps: number; runtime: number | null; language: string }): Promise<{ projectPath: string }>
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly resolveRoot: () => string
  ) {}

  list(): ProjectRecord[] {
    return this.db
      .prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY last_opened_at IS NULL, last_opened_at DESC')
      .all()
      .map(mapRow)
  }

  recent(limit = 10): ProjectRecord[] {
    return this.list().slice(0, limit)
  }

  getByPath(path: string): ProjectRecord | null {
    const row = this.db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE path = ?').get(path)
    return row ? mapRow(row) : null
  }

  byId(id: string): ProjectRecord | null {
    const row = this.db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? mapRow(row) : null
  }

  /**
   * Remove a project. Registry-only by default; folder deletion is guarded to
   * folders created inside the projects root (opened folders are never deleted).
   *
   * Order matters: the folder is removed FIRST, while the registry row still
   * exists. Deleting the row first left the project half-gone when a file was
   * locked (`EBUSY` on `delivery/documentary.mp4`, held by OneDrive sync or a
   * player) — the app lost the entry but the folder stayed, so every retry
   * failed with "project not found" (2026-11-18).
   */
  delete(id: string, deleteFolder: boolean, folderPath?: string): { folderDeleted: boolean; registryRemoved: boolean } {
    const record = this.byId(id)
    // An orphaned folder (row already gone, folder left behind by an earlier
    // failed delete) can still be cleaned by path, so the user is never stuck
    // with an undeletable project (2026-11-18).
    const path = record?.path ?? folderPath
    if (!record && !(deleteFolder && path)) throw new Error('project not found')
    let folderDeleted = false
    if (deleteFolder && path) {
      const root = this.resolveRoot().toLowerCase()
      const target = path.toLowerCase()
      if (!target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
        throw new Error('Refusing to delete a folder outside the projects root — remove it manually in Explorer.')
      }
      removeProjectFolder(path)
      folderDeleted = true
    }
    if (record) {
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(id)
    }
    return { folderDeleted, registryRemoved: Boolean(record) }
  }

  /** Showrunner stage transition (created → researching → research_done → directing → bible_ready …). */
  setStage(id: string, stage: string): void {
    this.db
      .prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, new Date().toISOString(), id)
  }

  /**
   * Create a project via the Bridge (DWK init_project → portable layout).
   * runtimeSeconds undefined = auto: project.yml omits target_runtime_seconds
   * and the Director decides the film length from the research.
   */
  async create(
    input: { title: string; fps?: number; runtimeSeconds?: number; language?: string; rootDir?: string },
    bridge: ProjectServiceBridge
  ): Promise<ProjectRecord> {
    const title = input.title.trim() || 'Untitled Documentary'
    const fps = input.fps ?? DEFAULT_FPS
    const runtime = input.runtimeSeconds ?? null
    const language = input.language ?? 'en'
    if (![24, 25, 30, 50, 60].includes(fps)) throw new Error('fps must be 24, 25, 30, 50, or 60')
    const slug = slugify(title)
    const rootDir = input.rootDir?.trim() || this.resolveRoot()
    let path = join(rootDir, slug)
    for (let i = 2; existsSync(path); i++) path = `${join(rootDir, slug)}-${i}`
    const { projectPath } = await bridge.initProject({ path, title, fps, runtime, language })
    return this.upsertFromDisk(projectPath, fps, runtime ?? undefined)
  }

  /** Open/refresh: verify the folder looks like a DWK project, register it. */
  open(path: string): ProjectRecord {
    if (!existsSync(join(path, 'project.yml'))) {
      throw new Error('Not a documentary project (no project.yml in folder)')
    }
    return this.upsertFromDisk(path)
    // Validation runs as a separate `project.validate` job (see ipc wiring).
  }

  private upsertFromDisk(path: string, fps?: number, runtime?: number): ProjectRecord {
    const abs = path
    const existing = this.getByPath(abs)
    const now = new Date().toISOString()
    if (existing) {
      this.db
        .prepare('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, existing.id)
      return this.getByPath(abs) ?? existing
    }
    const cfg = this.readProjectYml(abs)
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, slug, created_at, updated_at, last_opened_at, fps, runtime_seconds, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(id, cfg.title, abs, cfg.slug, now, now, now, fps ?? cfg.fps, runtime ?? cfg.runtime)
    return this.getByPath(abs) ?? {
      id,
      name: cfg.title,
      path: abs,
      slug: cfg.slug,
      fps: fps ?? cfg.fps,
      runtimeSeconds: runtime ?? cfg.runtime,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      status: 'active' as const,
      stage: 'created'
    }
  }

  private readProjectYml(path: string): { title: string; slug: string; fps: number | null; runtime: number | null } {
    try {
      const cfg = parse(readFileSync(join(path, 'project.yml'), 'utf-8')) as {
        title?: string
        slug?: string
        fps?: number
        target_runtime_seconds?: number
      }
      return {
        title: cfg.title ?? 'Untitled Documentary',
        slug: cfg.slug ?? slugify(cfg.title ?? 'documentary'),
        fps: typeof cfg.fps === 'number' ? cfg.fps : null,
        runtime: typeof cfg.target_runtime_seconds === 'number' ? cfg.target_runtime_seconds : null
      }
    } catch {
      const fallbackTitle = path.split(/[\\/]/).pop() ?? 'Untitled Documentary'
      return { title: fallbackTitle, slug: slugify(fallbackTitle), fps: null, runtime: null }
    }
  }
}
