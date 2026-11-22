import type { Db } from './db'
import type { ChatMessageRecord } from '@shared/ipc'

/** Chat transcript helpers (SQLite-backed, per project or global). */

interface ChatRow {
  id: number
  project_id: string | null
  role: string
  content: string
  created_at: string
}

function mapRow(r: ChatRow): ChatMessageRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role as ChatMessageRecord['role'],
    content: r.content,
    createdAt: r.created_at
  }
}

export function listChat(db: Db, projectId: string | null): ChatMessageRecord[] {
  const rows = projectId
    ? db.prepare<[string], ChatRow>('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id').all(projectId)
    : db.prepare<[], ChatRow>('SELECT * FROM chat_messages WHERE project_id IS NULL ORDER BY id').all()
  return rows.map(mapRow)
}

export function insertChat(
  db: Db,
  projectId: string | null,
  role: ChatMessageRecord['role'],
  content: string
): ChatMessageRecord {
  const res = db
    .prepare<[string | null, string, string, string]>(
      'INSERT INTO chat_messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(projectId, role, content, new Date().toISOString())
  return {
    id: Number(res.lastInsertRowid),
    projectId,
    role,
    content,
    createdAt: new Date().toISOString()
  }
}
