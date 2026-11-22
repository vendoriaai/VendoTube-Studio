import type { Db } from './db'

/** Key/value settings store (SQLite-backed, JSON-serializable values). */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  private stmtGet = () => this.db.prepare<[string], { value: string | null }>('SELECT value FROM settings WHERE key = ?')

  get<T = unknown>(key: string, fallback: T): T {
    const row = this.stmtGet().get(key)
    if (!row || row.value === null || row.value === undefined) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value ?? null), new Date().toISOString())
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare<[], { key: string; value: string | null }>('SELECT key, value FROM settings').all()
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        out[row.key] = row.value === null ? null : JSON.parse(row.value)
      } catch {
        out[row.key] = row.value
      }
    }
    return out
  }
}
