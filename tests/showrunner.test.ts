import { describe, expect, it } from 'vitest'
import {
  ProduceOutcome,
  ShowrunnerRunner,
  routePlainMessage,
  showrunnerPhases,
  type ShowrunnerDeps
} from '../src/main/showrunner'

/**
 * Showrunner autopilot (M6): the stage machine that lets one job chain
 * research → direction → draft produce (and survive gate-park → resume
 * re-entries), the chat plain-text router, and the orchestrator's park
 * semantics — driven with injected fakes, no Electron/db.
 */

describe('showrunnerPhases stage machine', () => {
  it('a fresh project runs the full crew: research → direct → produce', () => {
    expect(showrunnerPhases('created', false)).toEqual(['research', 'direct', 'produce'])
    expect(showrunnerPhases('researching', false)).toEqual(['research', 'direct', 'produce'])
  })

  it('finished phases are skipped on re-entry (gate-park → resume)', () => {
    expect(showrunnerPhases('research_done', false)).toEqual(['direct', 'produce'])
    expect(showrunnerPhases('bible_ready', true)).toEqual(['produce'])
    expect(showrunnerPhases('producing', true)).toEqual(['produce'])
    expect(showrunnerPhases('delivered', true)).toEqual(['produce'])
  })

  it('bible_ready without workflow.json on disk re-runs direction', () => {
    // crash between workflow_write and the stage update
    expect(showrunnerPhases('bible_ready', false)).toEqual(['direct', 'produce'])
  })

  it('direction_needs_fixes retries direction', () => {
    expect(showrunnerPhases('direction_needs_fixes', true)).toEqual(['direct', 'produce'])
  })
})

describe('routePlainMessage (chat plain-text routing)', () => {
  it('routes by project/workflow state', () => {
    expect(routePlainMessage(false, false)).toBe('ack')
    expect(routePlainMessage(true, false)).toBe('make')
    expect(routePlainMessage(true, true)).toBe('refine')
  })
})

describe('ShowrunnerRunner', () => {
  const paused: ProduceOutcome = {
    status: 'paused_at_gate',
    pausedAtGate: 'G-M',
    gateSummary: 'use N research images/videos?',
    summary: 'paused at G-M'
  }
  const done: ProduceOutcome = { status: 'done', summary: 'Film produced' }

  function makeDeps(over: Partial<ShowrunnerDeps> & { produceResult?: ProduceOutcome } = {}): ShowrunnerDeps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      research: async () => {
        calls.push('research')
      },
      direct: async (notes) => {
        calls.push(`direct:${notes ?? ''}`)
      },
      produce: async () => {
        calls.push('produce')
        return over.produceResult ?? done
      },
      onAwaitingApproval: () => {
        calls.push('park')
      },
      ...over
    }
  }

  it('make() runs the planned phases in order and summarizes', async () => {
    const deps = makeDeps()
    const result = await new ShowrunnerRunner({ phases: ['research', 'direct', 'produce'], deps }).run()
    expect(deps.calls).toEqual(['research', 'direct:', 'produce'])
    expect(result.phases).toEqual(['research', 'direct', 'produce'])
    expect(result.summary).toMatch(/draft is ready/)
    expect(result.outcome).toBeUndefined()
  })

  it('make() parks honestly when the producer hits a gate (no summary lie)', async () => {
    const deps = makeDeps({ produceResult: paused })
    const result = await new ShowrunnerRunner({ phases: ['direct', 'produce'], deps }).run()
    expect(deps.calls).toEqual(['direct:', 'produce', 'park'])
    expect(result.outcome?.status).toBe('paused_at_gate')
    expect(result.summary).toMatch(/G-M/)
    expect(result.phases).toEqual(['direct'])
  })

  it('failures propagate so the job fails honestly', async () => {
    const deps = makeDeps()
    deps.research = async () => {
      deps.calls.push('research')
      throw new Error('provider error')
    }
    await expect(new ShowrunnerRunner({ phases: ['research', 'produce'], deps }).run()).rejects.toThrow(/provider error/)
    expect(deps.calls).toEqual(['research'])
  })

  it('refine() passes the note to the Director and always re-produces a draft', async () => {
    const deps = makeDeps()
    const result = await new ShowrunnerRunner({ phases: ['direct', 'produce'], deps }).refine('make the hook punchier')
    expect(deps.calls).toEqual(['direct:make the hook punchier', 'produce'])
    expect(result.phases).toEqual(['direct', 'produce'])
    expect(result.summary).toMatch(/fresh draft/)
  })

  it('refine() parks at a new media-rights gate without rendering', async () => {
    const deps = makeDeps({ produceResult: paused })
    const result = await new ShowrunnerRunner({ phases: ['direct', 'produce'], deps }).refine('use the new images')
    expect(deps.calls).toEqual(['direct:use the new images', 'produce', 'park'])
    expect(result.outcome?.pausedAtGate).toBe('G-M')
  })

  it('stops before producing when the Director run fails DWK validation (R8 guard)', async () => {
    // Regression (2026-11-15, stock-market project): the autopilot produced an
    // evidence-free film over an empty ledger because "produce always" ran
    // even after direction_needs_fixes. The Bible panel's warnings were true.
    const deps = makeDeps({
      direct: async (notes) => {
        deps.calls.push(`direct:${notes ?? ''}`)
        return { validation: { valid: false, errors: ['No evidence-ledger claims are registered yet.'] } }
      }
    })
    const result = await new ShowrunnerRunner({ phases: ['research', 'direct', 'produce'], deps }).run()
    expect(deps.calls).toEqual(['research', 'direct:']) // produce must NOT run
    expect(result.phases).toEqual(['research', 'direct'])
    expect(result.summary).toMatch(/validation flagged/)
    expect(result.summary).toMatch(/NOT produced/)
  })

  it('refine() also refuses to produce an invalid design', async () => {
    const deps = makeDeps({
      direct: async (notes) => {
        deps.calls.push(`direct:${notes ?? ''}`)
        return { validation: { valid: false, errors: ['No shot list is registered yet.'] } }
      }
    })
    const result = await new ShowrunnerRunner({ phases: ['direct', 'produce'], deps }).refine('tighten scene 3')
    expect(deps.calls).toEqual(['direct:tighten scene 3']) // produce must NOT run
    expect(result.summary).toMatch(/failed validation/)
  })
})
