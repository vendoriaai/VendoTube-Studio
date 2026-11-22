import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatClient } from '../src/main/agent/chat'
import { DirectorRunner } from '../src/main/agent/director'
import { createDirectorHandlers, type DirectorDeps } from '../src/main/agent/directorTools'

/**
 * Director pipeline verified against a mock provider: the scripted run walks
 * state_digest → bible_write → script_write → shots_write → workflow_write →
 * finish, and the test asserts every artifact landed in the DWK-compatible
 * shape (bible front-matter, beats, claim-mapped script, workflow json) and
 * that claim validation rejects unknown ids.
 */

function startMockProvider(
  turns: Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; content?: string; empty?: boolean }>
): Promise<{ server: Server; url: string; bodies: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    let n = 0
    const bodies: Array<Record<string, unknown>> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(body) as Record<string, unknown>)
        } catch {
          bodies.push({})
        }
        const turn = turns[Math.min(n, turns.length - 1)]
        n++
        const message = turn.empty
          ? { role: 'assistant', content: null }
          : turn.toolCalls
          ? {
              role: 'assistant',
              content: null,
              tool_calls: turn.toolCalls.map((t, i) => ({
                id: `c${n}_${i}`,
                type: 'function',
                function: { name: t.name, arguments: JSON.stringify(t.args) }
              }))
            }
          : { role: 'assistant', content: turn.content ?? 'done' }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message }], usage: {} }))
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies })
    )
  })
}

class FakeBridge {
  constructor(private readonly opts: { approved?: boolean } = {}) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>
    const rows = (p.rows ?? []) as Array<Record<string, unknown>>
    switch (method) {
      case 'ledger.digest':
        return { counts: { sources: 3, claims: 2, asset_candidates: 2 }, source_ids: [['WEB-0001', 'Nokia wiki']], claims: [] }
      case 'ledger.list':
        return {
          rows: [
            { claim_id: 'CLM-0001', claim_text: 'Nokia was founded in 1865 as a pulp mill.' },
            { claim_id: 'CLM-0002', claim_text: 'Nokia sold its phone business to Microsoft in 2014.' }
          ]
        }
      case 'assets.list':
        // REAL bridge shape (bridge/server.py → dwk_ledger.list_assets):
        // { candidates: [snake_case ledger rows + downloaded flag], downloaded_count }
        return {
          downloaded_count: 1,
          candidates: [
            {
              asset_id: 'A-0001',
              saved_path: 'media/web/photo.jpg',
              media_type: 'image',
              title: 'Nokia 3310 photo',
              license: 'CC BY 4.0',
              date: '2019-01-01',
              rights_status: this.opts.approved === false ? 'review' : 'approved',
              downloaded: true
            }
          ]
        }
      case 'dwk.write_shot_list':
        return { count: rows.length }
      default:
        return {}
    }
  }
}

describe('Director pipeline (mock provider)', () => {
  let ctx: { server: Server; url: string; bodies: Array<Record<string, unknown>> } | null = null

  beforeAll(async () => {
    ctx = await startMockProvider([
      { toolCalls: [{ name: 'state_digest', args: {} }] },
      {
        toolCalls: [
          {
            name: 'bible_write',
            args: {
              title: 'Nokia: Rise and Fall',
              thesis: 'Dominance breeds blindness.',
              emotional_promise: 'awe → unease → resolve',
              arc: 'A paper mill becomes the world phone king, then misses the screen.',
              scenes: [
                {
                  id: 'S01',
                  label: 'Hook',
                  title: 'The phone that would not break',
                  shows: 'Nokia 3310 imagery (A-0001) (CLM-0001)',
                  feels: 'nostalgia and awe — why they stay: the indestructible legend',
                  motion: 'slow Ken Burns',
                  on_screen_text: '280,000,000 sold',
                  duration_target_s: 12,
                  claims: ['CLM-0001'],
                  asset_ids: ['A-0001'],
                  beat: { id: 'B01', curiosity: 0.9, tension: 0.2, rehook: false, music: 'drone', sfx: [] }
                },
                {
                  id: 'S02',
                  label: 'Payoff',
                  title: 'The fall and the second life',
                  shows: 'Microsoft deal coverage (CLM-0002)',
                  feels: 'unease resolving into respect for the second act',
                  motion: 'crossfade montage',
                  on_screen_text: '€5.4B',
                  duration_target_s: 10,
                  claims: ['CLM-0002'],
                  asset_ids: [],
                  beat: { id: 'B02', curiosity: 0.5, tension: 0.7, rehook: true, music: 'strings', sfx: [] }
                }
              ]
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'script_write',
            args: {
              sections: [
                {
                  id: 'S01',
                  title: 'Hook',
                  // The fixture runs against a 6-minute budget (360s), and
                  // script_write now refuses a transcript that cannot fill it,
                  // so the body carries ~930 words (360s at 155 wpm).
                  body:
                    'In 1865 a pulp mill opened on a river in Finland. A century later its name sold 280 million phones. (CLM-0001) ' +
                    'The mill town grew around timber and the river carried the logs down to the coast each spring, and the company that owned it learned early how to sell a product nobody knew they wanted. '.repeat(20)
                },
                {
                  id: 'S02',
                  title: 'Payoff',
                  body:
                    'In 2014 Microsoft bought the phone business for 5.4 billion euros. (CLM-0002) The brand came back by license. ' +
                    'The lesson of the deal is that a name can outlive the factory that made it, and that the people who buy a business are buying a story as much as a balance sheet. '.repeat(6)
                }
              ]
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'shots_write',
            args: {
              rows: [
                { start_frame: 0, end_frame: 120, asset_path: 'media/web/photo.jpg', asset_type: 'image', source_id: 'WEB-0001', claim_id: 'CLM-0001', visual_label: '3310 hero' }
              ]
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'workflow_write',
            args: {
              quality: 'standard',
              scenes: [
                {
                  id: 'S01',
                  beats: ['B01'],
                  vo_script_section: 'S01',
                  visual: { mood: 'noir', layout: 'full-bleed' },
                  shots: [{ kind: 'asset', asset_path: 'media/web/photo.jpg', motion: 'kenburns', dur_s: 4 }],
                  transition_in: 'fade',
                  transition_out: 'crossfade',
                  sfx: [],
                  claims: ['CLM-0001']
                },
                {
                  id: 'S02',
                  beats: ['B02'],
                  vo_script_section: 'S02',
                  visual: { mood: 'warm', layout: 'centered' },
                  shots: [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The fall', dur_s: 3 }],
                  transition_in: 'dip-to-black',
                  transition_out: 'fade',
                  sfx: [],
                  claims: ['CLM-0002']
                }
              ]
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'style_write',
            args: {
              accent: '#7a1f1f',
              transition_set: 'cinematic',
              look: 'Finnish winter: cold steel blue, heavy grain, hard cuts on reveals'
            }
          }
        ]
      },
      { toolCalls: [{ name: 'finish', args: { summary: 'Two-scene film designed; all artifacts written.' } }] }
    ])
  })

  afterAll(() => {
    ctx?.server.close()
  })

  function makeCtx(): { server: Server; url: string; bodies: Array<Record<string, unknown>> } {
    return (ctx as unknown as { server: Server; url: string; bodies: Array<Record<string, unknown>> })
  }

  it('writes every artifact coherently and journals the run', async () => {
    const { url } = makeCtx()
    const projectPath = mkdtempSync(join(tmpdir(), 'director-test-'))
    // the shot must physically exist (validate-style pre-check in shots_write)
    mkdirSync(join(projectPath, 'media', 'web'), { recursive: true })
    writeFileSync(join(projectPath, 'media', 'web', 'photo.jpg'), 'jpeg-bytes')

    const activities: Array<{ type: string; tool?: string }> = []
    const runner = new DirectorRunner({
      chat: new ChatClient({ baseUrl: url, apiKey: 'mock-key', model: 'mock', timeoutMs: 5000 }),
      dwkRoot: projectPath,
      maxTurns: 10,
      deps: {
        bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
        projectPath,
        voice: 'en-US-AndrewMultilingualNeural',
        revisionNotes: null,
        targetRuntimeSeconds: 360,
        emit: (a) => activities.push({ type: a.type, tool: a.tool })
      } satisfies DirectorDeps
    })
    const result = await runner.run()

    expect(result.stoppedReason).toBe('finish')
    expect(result.toolCalls).toBe(7)

    // The user's runtime budget reaches the Director prompt (it used to be dropped).
    const systemPrompt = String(((makeCtx().bodies[0]?.messages as Array<{ role: string; content: string }>) ?? [])[0]?.content ?? '')
    expect(systemPrompt).toContain('the user set 6 minutes (360s)')
    // The budget must be expressed as a WORD COUNT: the film is as long as its
    // narration, and a prompt that only said "360s" still produced a 2–4 minute
    // film (2026-11-19). 6 min × 155 wpm ≈ 930 words.
    expect(systemPrompt).toContain('write roughly 930–1020 words of script')
    expect(systemPrompt).toContain('script_write REFUSES a transcript that cannot fill the budget')
    expect(systemPrompt).not.toContain('you decide it from the evidence')

    // bible.md: front-matter + scenes
    const bible = readFileSync(join(projectPath, 'production', 'bible.md'), 'utf-8')
    expect(bible).toContain('Nokia: Rise and Fall')
    expect(bible).toContain('### S01 — Hook:')
    expect(bible).toContain('feels:')

    // beats.json
    const beats = JSON.parse(readFileSync(join(projectPath, 'production', 'beats.json'), 'utf-8'))
    expect(beats.beats.length).toBe(2)
    expect(beats.beats[0].startS).toBe(0)
    expect(beats.beats[1].startS).toBe(12)

    // script.md with claim refs + front-matter voice
    const script = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    expect(script).toContain('voice: en-US-AndrewMultilingualNeural')
    expect(script).toContain('(CLM-0001)')

    // shot_list written via bridge (FakeBridge records the call), workflow.json on disk
    expect(existsSync(join(projectPath, 'studio', 'workflow.json'))).toBe(true)
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8'))
    expect(wf.scenes.length).toBe(2)
    expect(wf.scenes[0].vo.script_section).toBe('S01')
    // visual direction: per-scene look rides through the validator
    expect(wf.scenes[0].visual).toEqual({ mood: 'noir', layout: 'full-bleed' })
    expect(wf.scenes[1].visual).toEqual({ mood: 'warm', layout: 'centered' })
    expect(wf.scenes[1].transitions).toEqual({ in: 'dip-to-black', out: 'fade' })

    // style.json authored by the Director (style_write phase)
    const style = JSON.parse(readFileSync(join(projectPath, 'studio', 'style.json'), 'utf-8'))
    expect(style.accent).toBe('#7a1f1f')
    expect(style.transition_set).toBe('cinematic')
    expect(style.look).toContain('Finnish winter')

    expect(activities.at(-1)?.type).toBe('done')
  }, 20_000)

  it('rejects script sections referencing unknown claims', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-bad-'))
    const handlers = (await import('../src/main/agent/directorTools')).createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    await expect(
      handlers['script_write']({ sections: [{ id: 'S01', title: 'x', body: 'bad (CLM-9999) ref' }] })
    ).rejects.toThrow(/unknown claim ids/)
  }, 20_000)

  it('rejects a script too short to fill the user\u2019s Minutes budget', async () => {
    // A 15-minute request (900s) needs ~2,300 spoken words. The Director used
    // to write ~2,300 words only when NO target was set, so a user-set budget
    // still shipped a 2–4 minute film (2026-11-19). script_write must refuse
    // and say how many words are missing.
    const projectPath = mkdtempSync(join(tmpdir(), 'director-budget-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      targetRuntimeSeconds: 900,
      emit: () => undefined
    })
    const short = `A short script citing the evidence (CLM-0001). ${'filler words here '.repeat(80)}`
    // The rejection must carry the per-section math and the append path —
    // "write the WHOLE film" alone left the model rewriting the same draft
    // forever (2026-11-19 dogfood, 15+ identical retries).
    await expect(
      handlers['script_write']({ sections: [{ id: 'S01', title: 'Hook', body: short }] })
    ).rejects.toThrow(/rejected: the script so far is .* words .* but the user set a 15-minute film.*Aim for ~2325 words.*average ~\d+ words.*mode:'append'/s)
  }, 20_000)

  it('accepts a script that fills the budget', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-budget-ok-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      targetRuntimeSeconds: 900,
      emit: () => undefined
    })
    // ~900s at 155 wpm ≈ 2325 words.
    const body = `Opening on the evidence (CLM-0001). ${'word '.repeat(2330)}`
    const res = (await handlers['script_write']({ sections: [{ id: 'S01', title: 'Hook', body }] })) as {
      words: number
      estimated_speak_seconds: number
    }
    expect(res.words).toBeGreaterThan(2300)
    expect(res.estimated_speak_seconds).toBeGreaterThanOrEqual(810)
  }, 20_000)

  it('rejects a script that overruns the budget', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-budget-over-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      targetRuntimeSeconds: 300,
      emit: () => undefined
    })
    const body = `Opening (CLM-0001). ${'word '.repeat(2000)}`
    await expect(
      handlers['script_write']({ sections: [{ id: 'S01', title: 'Hook', body }] })
    ).rejects.toThrow(/over the 5-minute budget/)
  }, 20_000)

  it('append mode merges across calls so a long script can be built incrementally', async () => {
    // 2026-11-19 dogfood: glm-5.3-flash could not fit a 15-minute script into
    // one tool call (it plateaued at ~1,730 words) and burned 15+ turns
    // rewriting the same draft. mode:'append' lets each call merge into the
    // script so far — nothing is lost between calls.
    const projectPath = mkdtempSync(join(tmpdir(), 'director-append-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      targetRuntimeSeconds: 900,
      emit: () => undefined
    })
    const filler = (n: number): string => 'word '.repeat(n)
    // Call 1 (default replace): two thin sections → under budget → rejected.
    await expect(
      handlers['script_write']({
        sections: [
          { id: 'S01', title: 'Hook', body: `Opened on the evidence. (CLM-0001) ${filler(280)}` },
          { id: 'S02', title: 'Turn', body: `The counterpoint lands. (CLM-0002) ${filler(280)}` }
        ]
      })
    ).rejects.toThrow(/rejected: the script so far is/)
    // Call 2 (append): deepen S01 and add S03 — S02 must survive untouched.
    const res = (await handlers['script_write']({
      mode: 'append',
      sections: [
        { id: 'S01', title: 'Hook', body: `Opened on the evidence, deepened. (CLM-0001) ${filler(1200)}` },
        { id: 'S03', title: 'Payoff', body: `The payoff lands. (CLM-0001) ${filler(1000)}` }
      ]
    })) as { sections: number; words: number; estimated_speak_seconds: number }
    expect(res.sections).toBe(3)
    // merged ≈ 1206 + 284 + 1005 = 2495 words ≈ 966s → inside 900s ±10%
    expect(res.estimated_speak_seconds).toBeGreaterThanOrEqual(810)
    const script = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    expect(script).toContain('deepened') // S01 replaced by the new text
    expect(script).toContain('The counterpoint lands.') // S02 kept from call 1
    expect(script).toContain('The payoff lands.') // S03 added by call 2
  }, 20_000)

  it('append mode merges against script.md already on disk from an earlier write', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-append-disk-'))
    const deps = {
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    } satisfies Omit<DirectorDeps, 'targetRuntimeSeconds'>
    // A first run writes a short script (no runtime target → no budget gate).
    const handlers1 = createDirectorHandlers(deps)
    await handlers1['script_write']({ sections: [{ id: 'S01', title: 'Hook', body: 'First part. (CLM-0001)' }] })
    // A later run (fresh handler set, accumulator empty) appends — base = disk.
    const handlers2 = createDirectorHandlers(deps)
    const res = (await handlers2['script_write']({
      mode: 'append',
      sections: [{ id: 'S02', title: 'Payoff', body: 'Second part. (CLM-0002)' }]
    })) as { sections: number }
    expect(res.sections).toBe(2)
    const script = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    expect(script).toContain('First part.')
    expect(script).toContain('Second part.')
  }, 20_000)

  it('breaks the retry loop: after repeated rejections a 75% script is accepted with a warning', async () => {
    // The 2026-11-19 dogfood burned every turn on identical under-budget
    // retries and shipped NOTHING. After three rejections the gate accepts a
    // script that fills ≥75% of the budget — a coherent shorter film beats no
    // film — with a loud warning to the user.
    const projectPath = mkdtempSync(join(tmpdir(), 'director-loop-breaker-'))
    const activities: Array<{ type: string; summary?: string }> = []
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      targetRuntimeSeconds: 900,
      emit: (a) => activities.push({ type: a.type, summary: a.summary })
    })
    const filler = (n: number): string => 'word '.repeat(n)
    const thin = [{ id: 'S01', title: 'Hook', body: `Opened on the evidence. (CLM-0001) ${filler(280)}` }]
    // three under-budget rejections set the loop-breaker counter
    for (let i = 0; i < 3; i++) {
      await expect(handlers['script_write']({ sections: thin })).rejects.toThrow(/rejected: the script so far is/)
    }
    // below the 75% floor (900s → 675s ≈ 1,744 words): still rejected
    await expect(
      handlers['script_write']({ sections: [{ id: 'S01', title: 'Hook', body: `Still thin. (CLM-0001) ${filler(800)}` }] })
    ).rejects.toThrow(/rejected: the script so far is/)
    // ≥75%: accepted with a warning instead of rejecting forever
    const res = (await handlers['script_write']({
      sections: [{ id: 'S01', title: 'Hook', body: `The story as far as the evidence carries it. (CLM-0001) ${filler(1760)}` }]
    })) as { accepted_under_budget: boolean; warning: string; estimated_speak_seconds: number }
    expect(res.accepted_under_budget).toBe(true)
    expect(res.estimated_speak_seconds).toBeGreaterThanOrEqual(675)
    expect(res.warning).toMatch(/shorter than the user asked/)
    expect(activities.some((a) => a.type === 'message' && /accepted under budget/.test(a.summary ?? ''))).toBe(true)
    // script.md is on disk so the run can proceed to shots/workflow
    expect(existsSync(join(projectPath, 'production', 'script.md'))).toBe(true)
  }, 20_000)

  it('tells the model to split the write when the tool-call arguments arrive truncated', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-trunc-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    await expect(handlers['script_write']({ _raw: '{"sections": [{"id": "S01", "body": "trunc' })).rejects.toThrow(
      /could not parse the tool-call arguments.*FEWER sections.*mode:'append'/s
    )
  }, 20_000)

  it('lists valid claim ids in the unknown-claims error so the model can self-correct', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-bad2-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    await expect(
      handlers['script_write']({ sections: [{ id: 'S01', title: 'x', body: 'bad (CLM-9999) ref' }] })
    ).rejects.toThrow(/valid claim ids: CLM-0001, CLM-0002/)
  }, 20_000)

  it('canonicalizes CLM0001-style claim ids across script and workflow', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-clm-'))
    // workflow_write needs beats + a script section on disk
    mkdirSync(join(projectPath, 'production'), { recursive: true })
    writeFileSync(join(projectPath, 'production', 'beats.json'), JSON.stringify({ beats: [{ id: 'B01' }] }))
    writeFileSync(join(projectPath, 'production', 'script.md'), '## [S01] Hook\n\nbody\n')
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    await handlers['script_write']({ sections: [{ id: 'S01', title: 'Hook', body: 'Founded in 1865. (CLM0001)' }] })
    const script = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    expect(script).toContain('(CLM-0001)')

    await handlers['workflow_write']({
      scenes: [{ id: 'S01', beats: ['B01'], vo_script_section: 'S01', shots: [{ kind: 'composition', template: 't', dur_s: 3 }], claims: ['CLM0001'] }]
    })
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8'))
    expect(wf.scenes[0].claims).toEqual(['CLM-0001'])
  }, 20_000)

  it('script_write warns when the rewrite breaks workflow.json section refs (the dogfood incident)', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-stale-wf-'))
    mkdirSync(join(projectPath, 'studio'), { recursive: true })
    // A workflow from the previous direction still maps a scene to section 'S01'…
    writeFileSync(
      join(projectPath, 'studio', 'workflow.json'),
      JSON.stringify({ version: 1, scenes: [{ id: 'S01', vo: { script_section: 'S01' } }, { id: 'S08', vo: { script_section: 'S08' } }] })
    )
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    // …then the script is rewritten with renamed/removed sections (hook, no S08).
    const res = (await handlers['script_write']({
      sections: [
        { id: 'hook', title: 'One Prompt', body: 'Words. (CLM-0001)' },
        { id: 'S02', title: 'Next', body: 'More words. (CLM-0002)' }
      ]
    })) as Record<string, unknown>
    expect(String(res.warning)).toMatch(/S01, S08/)
    expect(String(res.warning)).toMatch(/workflow_write/)

    // No warning when the workflow's sections all still exist.
    const clean = (await handlers['script_write']({
      sections: [
        { id: 'S01', title: 'One Prompt', body: 'Words. (CLM-0001)' },
        { id: 'S08', title: 'Next', body: 'More words. (CLM-0002)' }
      ]
    })) as Record<string, unknown>
    expect(clean.warning).toBeUndefined()
  }, 20_000)

  it('state_digest reads the real bridge shape and flags the empty rights gate', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-digest-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge({ approved: false }) as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    const digest = (await handlers['state_digest']({})) as Record<string, unknown>
    expect(digest.rights_approved_count).toBe(0)
    expect(digest.rights_note).toMatch(/rights-approved/)
    const usable = digest.usable_assets as Array<Record<string, unknown>>
    expect(usable).toHaveLength(1)
    expect(usable[0]).toMatchObject({ asset_id: 'A-0001', saved_path: 'media/web/photo.jpg', rights_status: 'review' })
  }, 20_000)

  it('shots_write with zero approved assets writes an empty shot list instead of dead-locking', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-gate-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge({ approved: false }) as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    const res = (await handlers['shots_write']({ rows: [] })) as { shots: number; note?: string }
    expect(res.shots).toBe(0)
    expect(res.note).toMatch(/rights-approved/)

    // a referenced unapproved asset is still rejected (human gate holds)
    mkdirSync(join(projectPath, 'media', 'web'), { recursive: true })
    writeFileSync(join(projectPath, 'media', 'web', 'photo.jpg'), 'jpeg-bytes')
    await expect(
      handlers['shots_write']({ rows: [{ start_frame: 0, end_frame: 10, asset_path: 'media/web/photo.jpg', asset_type: 'image' }] })
    ).rejects.toThrow(/not rights-approved/)
  }, 20_000)

  it('auto runtime: the prompt tells the Director to decide the length from the evidence', async () => {
    const mock = await startMockProvider([
      { toolCalls: [{ name: 'state_digest', args: {} }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'ok' } }] }
    ])
    const projectPath = mkdtempSync(join(tmpdir(), 'director-auto-'))
    const runner = new DirectorRunner({
      chat: new ChatClient({ baseUrl: mock.url, apiKey: 'mock-key', model: 'mock', timeoutMs: 5000 }),
      dwkRoot: projectPath,
      maxTurns: 10,
      deps: {
        bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
        projectPath,
        voice: 'v',
        revisionNotes: null,
        emit: () => undefined
      } satisfies DirectorDeps
    })
    try {
      await runner.run()
      const systemPrompt = String(((mock.bodies[0]?.messages as Array<{ role: string; content: string }>) ?? [])[0]?.content ?? '')
      // No user target: the Director defaults to a 15-minute film.
      expect(systemPrompt).toContain('15-minute')
      expect(systemPrompt).toContain('runtime_decision')
      expect(systemPrompt).not.toContain('the user set')
    } finally {
      mock.server.close()
    }
  }, 20_000)

  it('bible_write records a Director-decided runtime (runtime_decision) in the bible front-matter', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-runtime-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    const res = (await handlers['bible_write']({
      title: 'Auto Film',
      thesis: 't',
      emotional_promise: 'e',
      arc: 'a',
      runtime_decision: '4 minutes because the evidence is thin',
      scenes: [
        {
          id: 'S01',
          label: 'Hook',
          title: 'H',
          shows: 'x',
          feels: 'y',
          motion: 'm',
          on_screen_text: '',
          duration_target_s: 30,
          claims: ['CLM-0001'],
          asset_ids: [],
          beat: { id: 'B01', curiosity: 0.9, tension: 0.2 }
        },
        {
          id: 'S02',
          label: 'Turn',
          title: 'T',
          shows: 'x',
          feels: 'y',
          motion: 'm',
          on_screen_text: '',
          duration_target_s: 30,
          claims: ['CLM-0002'],
          asset_ids: [],
          beat: { id: 'B02', curiosity: 0.5, tension: 0.5 }
        }
      ]
    })) as Record<string, unknown>
    expect(res.total_runtime_s).toBe(60)
    const bible = readFileSync(join(projectPath, 'production', 'bible.md'), 'utf-8')
    expect(bible).toContain('runtime_decision: 4 minutes because the evidence is thin')
  }, 20_000)
})

describe('retention_review self-check (M4)', () => {
  const makeHandlers = (): { handlers: ReturnType<typeof createDirectorHandlers>; projectPath: string } => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-retention-'))
    const handlers = createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })
    return { handlers, projectPath }
  }

  const writeFixture = (projectPath: string, bible: string, beats: unknown[], script: string): void => {
    mkdirSync(join(projectPath, 'production'), { recursive: true })
    mkdirSync(join(projectPath, 'studio'), { recursive: true })
    writeFileSync(join(projectPath, 'production', 'bible.md'), bible)
    writeFileSync(join(projectPath, 'production', 'beats.json'), JSON.stringify({ beats }))
    writeFileSync(join(projectPath, 'production', 'script.md'), script)
    writeFileSync(
      join(projectPath, 'studio', 'workflow.json'),
      JSON.stringify({
        version: 1,
        render: { resolution: [1920, 1080], fps: 30, quality: 'standard' },
        scenes: [{ id: 'S01', beats: ['B01'], vo: { script_section: 'S01', voice: 'v' }, shots: [{ kind: 'composition', template: 't', dur_s: 4 }] }]
      })
    )
  }

  it('blocks a long thin film: no rehooks and an estimated dead zone', async () => {
    const { handlers, projectPath } = makeHandlers()
    const bible = ['---', 'title: T', '---', '## Arc', '', 'x', '', '## Scenes', '', '### S01 — Hook: The deep dive', '- shows: archive photo', '- feels: curiosity', '- motion: kenburns', '- on-screen text: none', '- duration_target_s: 150', ''].join('\n')
    writeFixture(
      projectPath,
      bible,
      [{ id: 'B01', scene: 'S01', label: 'Hook', startS: 0, rehook: false }],
      '## [S01] Hook\n\nOne short sentence.\n'
    )
    const res = (await handlers['retention_review']({})) as { verdict: string; findings: Array<{ severity: string; note: string }> }
    expect(res.verdict).toBe('fix')
    expect(res.findings.some((f) => /no beat is marked rehook/.test(f.note))).toBe(true)
    expect(res.findings.some((f) => /estimated dead zone/.test(f.note))).toBe(true)
    // craft pass: hook target (≤15s) + open-loop bookkeeping advisories
    expect(res.findings.some((f) => /target ≤15s/.test(f.note))).toBe(true)
    expect(res.findings.some((f) => /no beat documents an open loop/.test(f.note))).toBe(true)
  }, 20_000)

  it('advises when the hook opens on a title card (craft pass)', async () => {
    const { handlers, projectPath } = makeHandlers()
    const words = Array(60).fill('narration').join(' ')
    const bible = ['---', 'title: T', '---', '## Arc', '', 'x', '', '## Scenes', '', '### S01 — Hook: Carded', '- shows: archive photo', '- feels: curiosity', '- motion: kenburns', '- on-screen text: none', '- duration_target_s: 20', ''].join('\n')
    mkdirSync(join(projectPath, 'production'), { recursive: true })
    mkdirSync(join(projectPath, 'studio'), { recursive: true })
    writeFileSync(join(projectPath, 'production', 'bible.md'), bible)
    writeFileSync(join(projectPath, 'production', 'beats.json'), JSON.stringify({ beats: [{ id: 'B01', scene: 'S01', label: 'Hook', startS: 0, rehook: true }] }))
    writeFileSync(join(projectPath, 'production', 'script.md'), `## [S01] Hook\n\n${words}.\n`)
    writeFileSync(
      join(projectPath, 'studio', 'workflow.json'),
      JSON.stringify({
        version: 1,
        render: { resolution: [1920, 1080], fps: 30, quality: 'standard' },
        scenes: [{ id: 'S01', beats: ['B01'], vo: { script_section: 'S01', voice: 'v' }, shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }] }]
      })
    )
    const res = (await handlers['retention_review']({})) as { verdict: string; findings: Array<{ severity: string; note: string }> }
    expect(res.verdict).toBe('pass') // advisory only
    expect(res.findings.some((f) => /hook opens on a title card/.test(f.note))).toBe(true)
  }, 20_000)

  it('advises when the loop ledger goes dead (craft pass)', async () => {
    const { handlers, projectPath } = makeHandlers()
    const words = Array(60).fill('narration').join(' ')
    const bible = [
      '---', 'title: T', '---', '## Arc', '', 'x', '', '## Scenes', '',
      '### S01 — Hook: Open', '- shows: archive photo', '- feels: curiosity', '- motion: kenburns', '- on-screen text: none', '- duration_target_s: 20', '',
      '### S02 — Payoff: Closed', '- shows: archive photo', '- feels: resolve', '- motion: kenburns', '- on-screen text: none', '- duration_target_s: 20', ''
    ].join('\n')
    mkdirSync(join(projectPath, 'production'), { recursive: true })
    mkdirSync(join(projectPath, 'studio'), { recursive: true })
    writeFileSync(join(projectPath, 'production', 'bible.md'), bible)
    writeFileSync(
      join(projectPath, 'production', 'beats.json'),
      JSON.stringify({
        beats: [
          { id: 'B01', scene: 'S01', label: 'Hook', startS: 0, rehook: true, opensLoop: 'who signed it?', closesLoop: null },
          { id: 'B02', scene: 'S02', label: 'Payoff', startS: 20, rehook: false, opensLoop: null, closesLoop: 'who signed it?' }
        ]
      })
    )
    writeFileSync(join(projectPath, 'production', 'script.md'), `## [S01] Hook\n\n${words}.\n\n## [S02] Payoff\n\n${words}.\n`)
    writeFileSync(
      join(projectPath, 'studio', 'workflow.json'),
      JSON.stringify({
        version: 1,
        render: { resolution: [1920, 1080], fps: 30, quality: 'standard' },
        scenes: [
          { id: 'S01', beats: ['B01'], vo: { script_section: 'S01', voice: 'v' }, shots: [{ kind: 'asset', asset: 'media/images/a.jpg', dur_s: 4 }] },
          { id: 'S02', beats: ['B02'], vo: { script_section: 'S02', voice: 'v' }, shots: [{ kind: 'asset', asset: 'media/images/b.jpg', dur_s: 4 }] }
        ]
      })
    )
    const res = (await handlers['retention_review']({})) as { verdict: string; findings: Array<{ severity: string; note: string }> }
    expect(res.verdict).toBe('pass')
    expect(res.findings.some((f) => /loop ledger goes dead after beat B02/.test(f.note))).toBe(true)
  }, 20_000)

  it('records open-loop bookkeeping on beats (craft pass)', async () => {
    const { handlers, projectPath } = makeHandlers()
    await handlers['bible_write']({
      title: 'T',
      thesis: 'x',
      emotional_promise: 'e',
      arc: 'a',
      style_preset: 'true-crime',
      scenes: [
        {
          id: 'S01', label: 'Hook', title: 'A', shows: 'evidence', feels: 'curiosity', motion: 'kenburns', on_screen_text: '', duration_target_s: 20, claims: [],
          beat: { id: 'B01', curiosity: 0.9, tension: 0.3, opens_loop: 'who signed it?' }
        },
        {
          id: 'S02', label: 'Payoff', title: 'B', shows: 'evidence', feels: 'resolve', motion: 'kenburns', on_screen_text: '', duration_target_s: 20, claims: [],
          beat: { id: 'B02', curiosity: 0.4, tension: 0.4, closes_loop: 'who signed it?' }
        }
      ]
    })
    const beats = JSON.parse(readFileSync(join(projectPath, 'production', 'beats.json'), 'utf-8')) as {
      beats: Array<{ opensLoop?: string | null; closesLoop?: string | null }>
    }
    expect(beats.beats[0].opensLoop).toBe('who signed it?')
    expect(beats.beats[1].closesLoop).toBe('who signed it?')
  }, 20_000)

  it('passes a tight film within the rubric', async () => {
    const { handlers, projectPath } = makeHandlers()
    // ~78 words ≈ 30s spoken in a 35s scene; rehook at 0 covers the sub-120s rule.
    const words = Array(78).fill('narration').join(' ')
    const bible = ['---', 'title: T', '---', '## Arc', '', 'x', '', '## Scenes', '', '### S01 — Hook: Tight film', '- shows: archive photo', '- feels: curiosity', '- motion: kenburns', '- on-screen text: none', '- duration_target_s: 35', ''].join('\n')
    writeFixture(
      projectPath,
      bible,
      [{ id: 'B01', scene: 'S01', label: 'Hook', startS: 0, rehook: true }],
      `## [S01] Hook\n\n${words}.\n`
    )
    const res = (await handlers['retention_review']({})) as { verdict: string; findings: Array<{ severity: string }> }
    expect(res.verdict).toBe('pass')
  }, 20_000)
})

describe('Director weak-model insurance (grok-company 2026-11-14: runs died before workflow_write)', () => {
  const bibleArgs = {
    title: 'Nokia: Rise and Fall',
    thesis: 'Dominance breeds blindness.',
    emotional_promise: 'awe → unease → resolve',
    arc: 'A paper mill becomes the world phone king, then misses the screen.',
    scenes: [
      {
        id: 'S01',
        label: 'Hook',
        title: 'The phone that would not break',
        shows: 'Nokia 3310 imagery (A-0001) (CLM-0001)',
        feels: 'nostalgia and awe',
        motion: 'slow Ken Burns',
        on_screen_text: '280,000,000 sold',
        duration_target_s: 12,
        claims: ['CLM-0001'],
        asset_ids: ['A-0001'],
        beat: { id: 'B01', curiosity: 0.9, tension: 0.2, rehook: false, music: 'drone', sfx: [] }
      },
      {
        id: 'S02',
        label: 'Payoff',
        title: 'The fall and the second life',
        shows: 'Microsoft deal coverage (CLM-0002)',
        feels: 'unease resolving into respect',
        motion: 'crossfade montage',
        on_screen_text: '€5.4B',
        duration_target_s: 10,
        claims: ['CLM-0002'],
        asset_ids: [],
        beat: { id: 'B02', curiosity: 0.5, tension: 0.7, rehook: true, music: 'strings', sfx: [] }
      }
    ]
  }
  const scriptArgs = {
    sections: [
      { id: 'S01', title: 'Hook', body: 'In 1865 a pulp mill opened on a river in Finland. (CLM-0001)' },
      { id: 'S02', title: 'Payoff', body: 'In 2014 Microsoft bought the phone business. (CLM-0002)' }
    ]
  }
  const shotsArgs = {
    rows: [
      { start_frame: 0, end_frame: 120, asset_path: 'media/web/photo.jpg', asset_type: 'image', source_id: 'WEB-0001', claim_id: 'CLM-0001', visual_label: '3310 hero' }
    ]
  }
  const workflowArgs = {
    quality: 'standard',
    scenes: [
      {
        id: 'S01',
        beats: ['B01'],
        vo_script_section: 'S01',
        shots: [{ kind: 'asset', asset_path: 'media/web/photo.jpg', motion: 'kenburns', dur_s: 4 }],
        transition_in: 'fade',
        transition_out: 'crossfade',
        sfx: [],
        claims: ['CLM-0001']
      },
      {
        id: 'S02',
        beats: ['B02'],
        vo_script_section: 'S02',
        shots: [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The fall', dur_s: 3 }],
        transition_in: 'fade',
        transition_out: 'fade',
        sfx: [],
        claims: ['CLM-0002']
      }
    ]
  }

  function makeProject(): string {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-insurance-'))
    mkdirSync(join(projectPath, 'media', 'web'), { recursive: true })
    writeFileSync(join(projectPath, 'media', 'web', 'photo.jpg'), 'jpeg-bytes')
    return projectPath
  }

  function makeRunner(url: string, projectPath: string, maxTurns?: number): DirectorRunner {
    return new DirectorRunner({
      chat: new ChatClient({ baseUrl: url, apiKey: 'mock-key', model: 'mock', timeoutMs: 5000 }),
      dwkRoot: projectPath,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      deps: {
        bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
        projectPath,
        voice: 'en-US-AndrewMultilingualNeural',
        revisionNotes: null,
        emit: () => undefined
      } satisfies DirectorDeps
    })
  }

  function readJournal(projectPath: string): Array<Record<string, unknown>> {
    return readFileSync(join(projectPath, 'research', 'director_sessions.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('a mid-pipeline empty completion aborts honestly (not mislabeled as the turn limit) and skips the extension', async () => {
    const srv = await startMockProvider([
      { toolCalls: [{ name: 'state_digest', args: {} }] },
      { toolCalls: [{ name: 'bible_write', args: bibleArgs }] },
      { toolCalls: [{ name: 'script_write', args: scriptArgs }] },
      { toolCalls: [{ name: 'shots_write', args: shotsArgs }] },
      { empty: true },
      { empty: true },
      { empty: true }
    ])
    try {
      const projectPath = makeProject()
      const result = await makeRunner(srv.url, projectPath).run()
      expect(result.stoppedReason).toBe('message')
      expect(result.summary).toMatch(/three empty completions/)
      expect(existsSync(join(projectPath, 'studio', 'workflow.json'))).toBe(false)

      const journal = readJournal(projectPath)
      expect(journal.filter((e) => e.action === 'empty_completion')).toHaveLength(3)
      expect(journal.some((e) => e.action === 'workflow_missing_extension')).toBe(false)
      expect(journal.some((e) => e.action === 'done')).toBe(true)
    } finally {
      srv.server.close()
    }
  }, 20_000)

  it('a text-only stall still gets the workflow written by the extension', async () => {
    const srv = await startMockProvider([
      { toolCalls: [{ name: 'state_digest', args: {} }] },
      { toolCalls: [{ name: 'bible_write', args: bibleArgs }] },
      { toolCalls: [{ name: 'script_write', args: scriptArgs }] },
      { toolCalls: [{ name: 'shots_write', args: shotsArgs }] },
      { content: 'The design is complete and every artifact is on disk.' },
      { toolCalls: [{ name: 'workflow_write', args: workflowArgs }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] }
    ])
    try {
      const projectPath = makeProject()
      const result = await makeRunner(srv.url, projectPath).run()
      expect(result.stoppedReason).toBe('message')
      expect(existsSync(join(projectPath, 'studio', 'workflow.json'))).toBe(true)
      expect(result.summary).toContain('workflow.json written')

      const journal = readJournal(projectPath)
      expect(journal.some((e) => e.action === 'workflow_missing_extension')).toBe(true)
    } finally {
      srv.server.close()
    }
  }, 20_000)

  it('the turn limit triggers the nudges and, if the workflow is still missing, the extension runs and the summary says what to do', async () => {
    const srv = await startMockProvider([{ toolCalls: [{ name: 'state_digest', args: {} }] }])
    try {
      const projectPath = makeProject()
      const result = await makeRunner(srv.url, projectPath, 8).run()
      expect(result.turns).toBe(12) // 8 main turns + 4 extension turns
      expect(result.summary).toMatch(/workflow\.json was never written/)
      expect(result.summary).toMatch(/re-run \/direct/)
      expect(existsSync(join(projectPath, 'studio', 'workflow.json'))).toBe(false)

      const journal = readJournal(projectPath)
      expect(journal.some((e) => e.action === 'workflow_missing_extension')).toBe(true)
    } finally {
      srv.server.close()
    }
  }, 20_000)
})

// ------------------------------------------------- visual direction (2026-11-16)

describe('Director visual direction (validation + style_write)', () => {
  const makeHandlers = (projectPath: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> =>
    createDirectorHandlers({
      bridge: new FakeBridge() as unknown as import('../src/main/bridge').BridgeClient,
      projectPath,
      voice: 'v',
      revisionNotes: null,
      emit: () => undefined
    })

  const primeWorkflowInputs = (projectPath: string): void => {
    mkdirSync(join(projectPath, 'production'), { recursive: true })
    writeFileSync(join(projectPath, 'production', 'beats.json'), JSON.stringify({ beats: [{ id: 'B01' }, { id: 'B02' }] }))
    writeFileSync(join(projectPath, 'production', 'script.md'), '## [S01] Hook\n\nbody (CLM-0001)\n')
  }

  it('style_write writes style.json and merges over existing keys', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-style-'))
    const handlers = makeHandlers(projectPath)
    const res = (await handlers['style_write']({
      accent: '#7A1F1F',
      transition_set: 'cinematic',
      look: 'Finnish winter: cold steel blue, heavy grain'
    })) as Record<string, unknown>
    expect(res.written).toBeTruthy()
    const style = JSON.parse(readFileSync(join(projectPath, 'studio', 'style.json'), 'utf-8'))
    expect(style.accent).toBe('#7a1f1f') // normalized lowercase
    expect(style.transition_set).toBe('cinematic')
    expect(style.look).toContain('Finnish winter')

    // a second call without accent keeps the first accent (merge, not replace)
    await handlers['style_write']({ transition_set: 'hard-cuts' })
    const merged = JSON.parse(readFileSync(join(projectPath, 'studio', 'style.json'), 'utf-8'))
    expect(merged.accent).toBe('#7a1f1f')
    expect(merged.transition_set).toBe('hard-cuts')
  }, 20_000)

  it('style_write rejects a bad accent and an unknown transition_set with valid values', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-style2-'))
    const handlers = makeHandlers(projectPath)
    await expect(handlers['style_write']({ accent: 'oxblood' })).rejects.toThrow(/accent must be #rrggbb/)
    await expect(handlers['style_write']({ transition_set: 'whip-pans' })).rejects.toThrow(/smooth, hard-cuts, cinematic, broadcast/)
    await expect(handlers['style_write']({ caption_style: 'neon' })).rejects.toThrow(/kinetic\|boxed\|off/)
  }, 20_000)

  it('workflow_write validates shot motion against the grammar', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-motion-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    await expect(
      handlers['workflow_write']({
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo_script_section: 'S01',
            shots: [{ kind: 'asset', asset_path: 'media/web/photo.jpg', motion: 'whip-pan', dur_s: 4 }],
            claims: ['CLM-0001']
          }
        ]
      })
    ).rejects.toThrow(/valid motions: kenburns, push-in, pull-out, pan-left, pan-right, still/)
  }, 20_000)

  it('workflow_write infers data.kind from the payload when the model omits it (2026-11-18 marvel)', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-kindless-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    // data with items[] but no `kind` — the model's formatting slip; infer bars.
    const res = (await handlers['workflow_write']({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: 'S01',
          shots: [
            {
              kind: 'composition',
              template: 'data-bars',
              data: { title: 'take', items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
              dur_s: 5
            }
          ],
          claims: ['CLM-0001']
        }
      ]
    })) as { scenes: number }
    expect(res.scenes).toBe(1)
  }, 20_000)

  it('workflow_write infers vo_script_section from the scene id when the model sends it empty', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-vosection-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    const res = (await handlers['workflow_write']({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: '',
          shots: [{ kind: 'composition', template: 'title-card', text: 'x', dur_s: 3 }],
          claims: ['CLM-0001']
        }
      ]
    })) as { scenes: number }
    expect(res.scenes).toBe(1)
  }, 20_000)

  it('workflow_write accepts a duo (two boxes) with an approved asset and a text panel', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-duo-'))
    primeWorkflowInputs(projectPath)
    mkdirSync(join(projectPath, 'media', 'web'), { recursive: true })
    writeFileSync(join(projectPath, 'media', 'web', 'photo.jpg'), Buffer.from('fakejpg'))
    const handlers = makeHandlers(projectPath)
    const res = (await handlers['workflow_write']({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: 'S01',
          shots: [
            {
              kind: 'composition',
              template: 'duo',
              panels: [
                { asset_path: 'media/web/photo.jpg', kicker: 'The poster', title: 'A record of Eskimo life' },
                { title: 'The set', note: 'a family cast for the camera' }
              ],
              dur_s: 8
            }
          ],
          claims: ['CLM-0001']
        }
      ]
    })) as { scenes: number }
    expect(res.scenes).toBe(1)
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8'))
    expect(wf.scenes[0].shots[0].template).toBe('duo')
    expect(wf.scenes[0].shots[0].panels).toHaveLength(2)
    expect(wf.scenes[0].shots[0].panels[0].asset).toBe('media/web/photo.jpg')
    expect(wf.scenes[0].shots[0].panels[1].title).toBe('The set')
  }, 20_000)

  it('workflow_write rejects a duo without two panels and panels on a non-duo shot', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-duo-bad-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    const base = (shots: unknown[]): Record<string, unknown> => ({
      scenes: [{ id: 'S01', beats: ['B01'], vo_script_section: 'S01', shots, claims: ['CLM-0001'] }]
    })
    await expect(
      handlers['workflow_write'](base([{ kind: 'composition', template: 'duo', panels: [{ title: 'Only one' }], dur_s: 6 }]))
    ).rejects.toThrow(/exactly TWO panels/)
    await expect(
      handlers['workflow_write'](
        base([{ kind: 'composition', template: 'title-card', panels: [{ title: 'A' }, { title: 'B' }], dur_s: 6 }])
      )
    ).rejects.toThrow(/panels are only valid on template 'duo'/)
  }, 20_000)

  it('workflow_write accepts line, timeline, map and article motion-graphics payloads', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-graphics-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    const res = (await handlers['workflow_write']({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: 'S01',
          shots: [
            {
              kind: 'composition',
              template: 'data-line',
              narration_cue: 'documentary output grows',
              data: { kind: 'line', labels: ['1895', '1905', '1925'], series: [{ label: 'Films', values: [1, 2, 3] }] },
              dur_s: 6
            },
            {
              kind: 'composition',
              template: 'data-timeline',
              data: { kind: 'timeline', events: [{ label: 'First screening', year: 1895 }, { label: 'Nanook', year: 1922 }] },
              dur_s: 6
            },
            {
              kind: 'composition',
              template: 'data-map',
              data: { kind: 'map', route: true, markers: [{ label: 'Paris' }, { label: 'New York', highlight: true }] },
              dur_s: 6
            },
            {
              kind: 'composition',
              template: 'article',
              data: { kind: 'article', publication: 'The New York Sun', headline: 'Actuality', quote: 'Creative treatment' },
              dur_s: 6
            }
          ],
          claims: ['CLM-0001']
        }
      ]
    })) as { scenes: number }
    expect(res.scenes).toBe(1)
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8'))
    expect(wf.scenes[0].shots[0].data.kind).toBe('line')
    expect(wf.scenes[0].shots[0].cue).toBe('documentary output grows')
    expect(wf.scenes[0].shots[1].data.kind).toBe('timeline')
    expect(wf.scenes[0].shots[2].data.markers[1].highlight).toBe(true)
    expect(wf.scenes[0].shots[3].data.quote).toBe('Creative treatment')
  }, 20_000)

  it('workflow_write rejects malformed motion-graphics payloads', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-graphics-bad-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    const base = (template: string, data: Record<string, unknown>): Record<string, unknown> => ({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: 'S01',
          shots: [{ kind: 'composition', template, data, dur_s: 6 }],
          claims: ['CLM-0001']
        }
      ]
    })
    await expect(
      handlers['workflow_write'](base('data-line', { kind: 'line', labels: ['a', 'b'], series: [{ values: [1] }] }))
    ).rejects.toThrow(/values but labels has/)
    await expect(
      handlers['workflow_write'](base('data-timeline', { kind: 'timeline', events: [{ label: 'Only one' }] }))
    ).rejects.toThrow(/events\[2..10\]/)
    await expect(
      handlers['workflow_write'](base('data-map', { kind: 'map', markers: [{ label: 'Paris', lat: 48.8 }] }))
    ).rejects.toThrow(/both lat and lon/)
    await expect(handlers['workflow_write'](base('article', { kind: 'article' }))).rejects.toThrow(/headline and\/or quote/)
  }, 20_000)

  it('workflow_write validates the per-scene visual vocabulary', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-visual-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    await expect(
      handlers['workflow_write']({
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo_script_section: 'S01',
            visual: { mood: 'neon' },
            shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
            claims: ['CLM-0001']
          }
        ]
      })
    ).rejects.toThrow(/valid moods: neutral, warm, cool, sepia, noir, vivid/)
    await expect(
      handlers['workflow_write']({
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo_script_section: 'S01',
            visual: { layout: 'diagonal' },
            shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
            claims: ['CLM-0001']
          }
        ]
      })
    ).rejects.toThrow(/valid layouts: standard, full-bleed, split, centered, minimal/)
    await expect(
      handlers['workflow_write']({
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo_script_section: 'S01',
            visual: { accent: 'red' },
            shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
            claims: ['CLM-0001']
          }
        ]
      })
    ).rejects.toThrow(/accent 'red' must be #rrggbb/)
    await expect(
      handlers['workflow_write']({
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo_script_section: 'S01',
            transition_in: 'whip',
            shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
            claims: ['CLM-0001']
          }
        ]
      })
    ).rejects.toThrow(/valid transitions: cut, fade, crossfade, dip-to-black/)
  }, 20_000)

  it('an authored visual passes through to workflow.json; unauthored transitions are omitted', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-vis-ok-'))
    primeWorkflowInputs(projectPath)
    const handlers = makeHandlers(projectPath)
    await handlers['workflow_write']({
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo_script_section: 'S01',
          visual: { mood: 'sepia', layout: 'split', accent: '#B3542F' },
          shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
          claims: ['CLM-0001']
        },
        {
          id: 'S02',
          beats: ['B02'],
          vo_script_section: 'S01',
          shots: [{ kind: 'composition', template: 'title-card', dur_s: 4 }],
          transition_out: 'dip-to-black',
          claims: []
        }
      ]
    })
    const wf = JSON.parse(readFileSync(join(projectPath, 'studio', 'workflow.json'), 'utf-8'))
    expect(wf.scenes[0].visual).toEqual({ mood: 'sepia', layout: 'split', accent: '#b3542f' })
    expect(wf.scenes[0].transitions).toBeUndefined() // transition_set will seed it
    expect(wf.scenes[1].transitions).toEqual({ in: 'fade', out: 'dip-to-black' }) // authored side + historical default
  }, 20_000)

  it('retention_review warns on visual monotony (every scene one look)', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'director-monotony-'))
    primeWorkflowInputs(projectPath)
    // 4 scenes × 20s ≈ 15s spoken each — long enough for the check, short
    // enough to avoid the re-hook blocks; every scene the SAME look.
    const words = 'word '.repeat(38)
    let script = ''
    const scenes = []
    for (let i = 1; i <= 4; i++) {
      const id = `S0${i}`
      script += `## [${id}] Part ${i}\n\n${words}(CLM-0001)\n`
      scenes.push({
        id,
        beats: [`B0${i}`],
        vo_script_section: id,
        visual: { mood: 'warm', layout: 'centered' },
        shots: [{ kind: 'composition', template: 'title-card', dur_s: 10 }],
        claims: ['CLM-0001']
      })
    }
    writeFileSync(join(projectPath, 'production', 'script.md'), script)
    const handlers = makeHandlers(projectPath)
    await handlers['bible_write']({
      title: 'Monotony',
      thesis: 'Same look everywhere.',
      emotional_promise: 'flat',
      arc: 'Four identical scenes.',
      scenes: scenes.map((s, i) => ({
        id: s.id,
        label: `Part ${i + 1}`,
        title: `Part ${i + 1}`,
        shows: 'a card',
        feels: 'bored',
        motion: 'none',
        duration_target_s: 20,
        claims: ['CLM-0001'],
        beat: { id: `B0${i + 1}`, curiosity: 0.5, tension: 0.3, rehook: false, music: '', sfx: [] }
      }))
    })
    await handlers['workflow_write']({ scenes })
    const review = (await handlers['retention_review']({})) as { findings: Array<{ note: string }> }
    expect(review.findings.some((f) => /visual (arc|monotony)|one look|shift mood/.test(f.note))).toBe(true)
  }, 20_000)
})
