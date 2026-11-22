import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Showrunner (PRD §5): the orchestrator that turns ONE user idea into a
 * finished film by chaining the existing crew jobs — Scout research →
 * Director design → Producer draft render — instead of asking the user to
 * type /research, /direct, /produce by hand.
 *
 * Design constraints honored here:
 * - The stage machine makes gate-park → resume cheap: `resumeAwaiting`
 *   re-runs the orchestrator from the top and completed phases are skipped
 *   by project stage (research sets `research_done`, direction sets
 *   `bible_ready`, the Producer resumes from studio/producer_state.json).
 * - Autopilot gate policy (user decision 2026-11-15): G-D/G-E/G-F are
 *   pre-authorized by the kickoff click but STILL recorded as approved
 *   rows in pending_approvals (100% auditable); G-M (research media
 *   rights) is never auto-approved — the film pauses once to ask.
 * - This module stays free of Electron/db imports so vitest can drive it:
 *   the runner only sees injected callbacks.
 */

export type ShowrunnerPhase = 'research' | 'direct' | 'produce'

/**
 * Which phases still need to run for a project in `stage`.
 * - research: fresh projects only (`created`/`researching`).
 * - direct: everything except stages that already carry an approved design;
 *   `bible_ready` without a workflow.json on disk (crash between the write
 *   and the stage update) re-runs direction.
 * - produce: always — the Producer phase ledger makes re-entries cheap.
 */
export function showrunnerPhases(stage: string, hasWorkflow = false): ShowrunnerPhase[] {
  const phases: ShowrunnerPhase[] = []
  if (stage === 'created' || stage === 'researching') phases.push('research')
  const directionDoneStages = ['bible_ready', 'producing', 'delivered']
  if (!directionDoneStages.includes(stage) || (stage === 'bible_ready' && !hasWorkflow)) phases.push('direct')
  phases.push('produce')
  return phases
}

export type PlainRoute = 'make' | 'refine' | 'ack'

/** Chat plain-text routing (UI-UX-SPEC §4.2): with a film designed, plain
 * text is a revision note; without one it starts/continues the film; with no
 * project open there is nothing to route — honest ack. */
export function routePlainMessage(hasProject: boolean, hasWorkflow: boolean): PlainRoute {
  if (!hasProject) return 'ack'
  return hasWorkflow ? 'refine' : 'make'
}

export function workflowExists(projectPath: string): boolean {
  return existsSync(join(projectPath, 'studio', 'workflow.json'))
}

/** Structural subset of the Producer's ProduceResult (keeps this module
 * import-light for tests). */
export interface ProduceOutcome {
  status: 'done' | 'paused_at_gate'
  pausedAtGate?: string
  gateSummary?: string
  summary: string
  master?: string | null
}

export interface ShowrunnerDeps {
  research: () => Promise<void>
  /** Resolves with the crew-job handler's return — the runner inspects
   * `validation` to refuse producing an invalid design (R8 guard). */
  direct: (notes: string | null) => Promise<unknown>
  produce: (quality: 'draft' | 'standard' | 'high') => Promise<ProduceOutcome>
  /** Park the job while a gate waits for the user (jobs.setAwaitingApproval). */
  onAwaitingApproval: () => void
  throwIfCancelled?: () => void
}

export interface ShowrunnerResult {
  summary: string
  phases: ShowrunnerPhase[]
  outcome?: ProduceOutcome
}

export class ShowrunnerRunner {
  constructor(private readonly opts: { phases: ShowrunnerPhase[]; deps: ShowrunnerDeps }) {}

  /** Idea → film: run the planned phases in order, parking honestly at G-M. */
  async run(): Promise<ShowrunnerResult> {
    const ran: ShowrunnerPhase[] = []
    for (const phase of this.opts.phases) {
      this.opts.deps.throwIfCancelled?.()
      if (phase === 'research') {
        await this.opts.deps.research()
        ran.push(phase)
        continue
      }
      if (phase === 'direct') {
        const direct = await this.opts.deps.direct(null)
        ran.push(phase)
        // Autopilot integrity (2026-11-15): a design that failed DWK
        // validation (e.g. an evidence-free film over an empty ledger) must
        // NEVER reach the producer — the Bible panel's warnings were true
        // while the pipeline shipped it. Stop honestly with the remedy.
        const invalid = (direct as { validation?: { valid?: boolean; errors?: string[] } } | undefined)?.validation
        if (invalid && invalid.valid === false) {
          return {
            summary: `Director finished but validation flagged ${invalid.errors?.length ?? 0} issue(s): ${(invalid.errors ?? [])
              .slice(0, 2)
              .join('; ')} — the film was NOT produced. Fix the design (re-run Make my film or /direct) and check that research registered claims.`,
            phases: ran
          }
        }
        continue
      }
      const outcome = await this.opts.deps.produce('draft')
      if (outcome.status === 'paused_at_gate') {
        this.opts.deps.onAwaitingApproval()
        return {
          summary: `Paused at approval gate ${outcome.pausedAtGate ?? '?'} — approve it to continue the run.`,
          phases: ran,
          outcome
        }
      }
      ran.push(phase)
    }
    return { summary: 'Crew finished — the draft is ready for review.', phases: ran }
  }

  /** Prompt → revised film: re-direct with the user's notes, then a fresh draft. */
  async refine(notes: string): Promise<ShowrunnerResult> {
    this.opts.deps.throwIfCancelled?.()
    const direct = await this.opts.deps.direct(notes)
    const invalid = (direct as { validation?: { valid?: boolean; errors?: string[] } } | undefined)?.validation
    if (invalid && invalid.valid === false) {
      return {
        summary: `Revision failed validation (${invalid.errors?.length ?? 0} issue(s): ${(invalid.errors ?? [])
          .slice(0, 2)
          .join('; ')}) — the previous draft is untouched. Re-run the refine prompt or /direct.`,
        phases: ['direct']
      }
    }
    const outcome = await this.opts.deps.produce('draft')
    if (outcome.status === 'paused_at_gate') {
      this.opts.deps.onAwaitingApproval()
      return {
        summary: `Revision designed — paused at approval gate ${outcome.pausedAtGate ?? '?'} before rendering.`,
        phases: ['direct'],
        outcome
      }
    }
    return { summary: 'Revision rendered into a fresh draft.', phases: ['direct', 'produce'] }
  }
}
