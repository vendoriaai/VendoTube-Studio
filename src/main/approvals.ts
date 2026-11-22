import { randomUUID } from 'node:crypto'
import type { Db } from './db'

/**
 * Pending approvals (AGENT-SPEC §6): restart-safe records for side-effect
 * gates. The producer pipeline checks the latest row for its gate key before
 * parking; the user's decision is persisted and the parked job is resumed
 * (or cancelled) through the JobManager.
 */

export interface ApprovalRow {
  id: string
  project_id: string | null
  tool_name: string
  tool_args: string | null
  status: 'pending' | 'approved' | 'declined'
  created_at: string
  resolved_at: string | null
}

const GATE_PREFIX = 'producer.gate:'

export function gateKey(gate: string): string {
  return `${GATE_PREFIX}${gate}`
}

export function isGateTool(name: string): boolean {
  return name.startsWith(GATE_PREFIX)
}

export function gateFromTool(name: string): string | null {
  if (!isGateTool(name)) return null
  return name.slice(GATE_PREFIX.length)
}

export function insertApproval(db: Db, projectId: string | null, toolName: string, args: unknown): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO pending_approvals (id, project_id, tool_name, tool_args, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(id, projectId, toolName, JSON.stringify(args ?? null), new Date().toISOString())
  return id
}

export function latestApprovalStatus(db: Db, projectId: string | null, toolName: string): 'pending' | 'approved' | 'declined' | null {
  const row = db
    .prepare<[string | null, string], { status: string }>(
      `SELECT status FROM pending_approvals
       WHERE project_id IS ? AND tool_name = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId ?? null, toolName)
  if (!row) return null
  return (row.status as 'pending' | 'approved' | 'declined') ?? null
}

export function setApprovalStatus(db: Db, id: string, status: 'approved' | 'declined'): boolean {
  const res = db
    .prepare(`UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
    .run(status, new Date().toISOString(), id)
  return res.changes > 0
}

export function latestPendingApproval(
  db: Db,
  projectId: string | null,
  toolName: string
): { id: string; toolArgs: unknown } | null {
  const row = db
    .prepare<[string | null, string], { id: string; tool_args: string | null }>(
      `SELECT id, tool_args FROM pending_approvals
       WHERE project_id IS ? AND tool_name = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId ?? null, toolName)
  if (!row) return null
  let args: unknown = null
  try {
    args = row.tool_args ? JSON.parse(row.tool_args) : null
  } catch {
    args = null
  }
  return { id: row.id, toolArgs: args }
}

/** Content-scoped gates: `producer.gate:G-E:<stamp>` — LIKE-prefix lookup for the UI. */
export function latestPendingApprovalByGate(
  db: Db,
  projectId: string | null,
  gate: string
): { id: string; toolName: string; toolArgs: unknown } | null {
  const row = db
    .prepare<[string | null, string], { id: string; tool_name: string; tool_args: string | null }>(
      `SELECT id, tool_name, tool_args FROM pending_approvals
       WHERE project_id IS ? AND tool_name LIKE ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId ?? null, `${GATE_PREFIX}${gate}:%`)
  if (!row) return null
  let args: unknown = null
  try {
    args = row.tool_args ? JSON.parse(row.tool_args) : null
  } catch {
    args = null
  }
  return { id: row.id, toolName: row.tool_name, toolArgs: args }
}

export function setGateApprovalByKey(db: Db, projectId: string | null, toolName: string, status: 'approved' | 'declined'): boolean {
  const row = db
    .prepare<[string | null, string], { id: string }>(
      `SELECT id FROM pending_approvals WHERE project_id IS ? AND tool_name = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId ?? null, toolName)
  if (!row) return false
  return setApprovalStatus(db, row.id, status)
}

/** UI-facing resolve: approve/decline the newest pending row for a gate prefix. */
export function setGateApprovalByGate(db: Db, projectId: string | null, gate: string, status: 'approved' | 'declined'): boolean {
  const row = db
    .prepare<[string | null, string], { id: string }>(
      `SELECT id FROM pending_approvals WHERE project_id IS ? AND tool_name LIKE ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectId ?? null, `${GATE_PREFIX}${gate}:%`)
  if (!row) return false
  return setApprovalStatus(db, row.id, status)
}
