import { randomUUID } from 'node:crypto'
import type { Db } from './db'

/**
 * agent_runs audit journal (DATA-SCHEMA §8, PRD metric "agent actions
 * visible/auditable: 100%"): one row per crew-run, written at start and
 * finalized at end — the replay/audit trail TAD §12 requires.
 */

import type { AgentRunRow } from '@shared/ipc'

export type { AgentRunRow }

export function startAgentRun(db: Db, input: { projectId: string | null; agent: string; stage?: string; model?: string | null }): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO agent_runs (id, project_id, agent, stage, model, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`
  ).run(id, input.projectId, input.agent, input.stage ?? null, input.model ?? null, new Date().toISOString())
  return id
}

export function endAgentRun(
  db: Db,
  id: string,
  status: 'done' | 'failed' | 'cancelled',
  counts: { tokensIn?: number; tokensOut?: number; costEst?: number } = {}
): void {
  db.prepare(
    `UPDATE agent_runs
     SET status = ?, tokens_in = ?, tokens_out = ?, cost_est = ?, ended_at = ?
     WHERE id = ?`
  ).run(
    status,
    counts.tokensIn ?? null,
    counts.tokensOut ?? null,
    counts.costEst ?? null,
    new Date().toISOString(),
    id
  )
}

export function listAgentRuns(db: Db, projectId: string | null, limit = 50): AgentRunRow[] {
  const rows = db
    .prepare<[string | null, number], Record<string, unknown>>(
      `SELECT * FROM agent_runs WHERE project_id IS ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(projectId, limit)
  return rows.map((r) => ({
    id: String(r.id),
    projectId: r.project_id === null ? null : String(r.project_id),
    agent: String(r.agent),
    stage: r.stage === null ? null : String(r.stage),
    model: r.model === null ? null : String(r.model),
    tokensIn: r.tokens_in === null ? null : Number(r.tokens_in),
    tokensOut: r.tokens_out === null ? null : Number(r.tokens_out),
    costEst: r.cost_est === null ? null : Number(r.cost_est),
    status: String(r.status),
    startedAt: r.started_at === null ? null : String(r.started_at),
    endedAt: r.ended_at === null ? null : String(r.ended_at)
  }))
}
