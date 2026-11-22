import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ChatClient, type AgentMessage, type AgentToolCall } from './chat'
import { createDirectorHandlers, directorToolSchemas, type DirectorActivity, type DirectorDeps } from './directorTools'

/**
 * Director agent loop (AGENT-SPEC §2.3): evidence-led film design in four
 * deterministic artifact writes — bible → beats → script (claim-mapped) →
 * shot list → workflow — each authored as structured JSON tool calls and
 * serialized by artifacts.ts. Weak-model insurance: empty completions are
 * retried with a nudge (a single silent provider reply used to kill the run
 * mid-pipeline, mislabeled as the turn limit — grok-company 2026-11-14),
 * budget guardrails force workflow_write as turns run low, and a bounded
 * extension asks the model to write the missing workflow before the run ends.
 */

export interface DirectorRunResult {
  summary: string
  turns: number
  toolCalls: number
  stoppedReason: 'finish' | 'message' | 'max_turns' | 'cancelled'
}

export interface DirectorRunnerOptions {
  chat: ChatClient
  deps: DirectorDeps
  dwkRoot: string
  maxTurns?: number
  throwIfCancelled?: () => void
}

const TOOL_RESULT_LIMIT = 6000

function systemPrompt(dwkRoot: string, projectPath: string, brief: string, revisionNotes: string | null, targetRuntimeSeconds: number | null): string {
  const guidePath = join(dwkRoot, 'AGENT_GUIDE.md')
  let guide = ''
  try {
    guide = readFileSync(guidePath, 'utf-8')
  } catch {
    guide = ''
  }
  const revision = revisionNotes
    ? `\n=== REVISION REQUEST ===\nThis is a revision. Existing bible/script/workflow exist on disk and your state_digest context reflects the CURRENT files. Incorporate these user notes coherently across ALL artifacts (bible, script, shots, workflow):\n${revisionNotes}\n`
    : ''
  return [
    'You are Director, the scenario agent of a documentary studio crew.',
    'You study the evidence ledger and the asset library and design the film: a complete Documentary Bible with a thesis, narrative arc (hook → context → evidence & counterpoint → turn → payoff), scene-by-scene structure, visual language, music/sound direction, and on-screen text plan. For every scene you state what must be shown and what the viewer must feel, and why they keep watching.',
    'You then write the evidence-mapped spoken script (every factual claim carries its (CLM-0001) ledger id inline, exactly as listed in state_digest), the frame-contiguous shot list referencing ONLY downloaded, rights-approved assets (saved_path from state_digest), and the executable workflow.',
    'You design for retention honestly: strong hook, re-hooks, pattern interrupts — without fabricating, sensationalizing beyond evidence, or misrepresenting sources. Generated cards/graphics are design elements, never fake archival evidence.',
    'Rights gate: discovery is not clearance. If state_digest reports no rights-approved assets, build scene visuals from compositions (cards/graphics) and write the shot list empty (rows: []) — never reference unapproved assets; tell the user to approve assets in the Asset Library. When rights-approved assets DO exist, put them on screen: reference saved_path values in workflow shots (images and video clips both render with Ken Burns motion).',
    'Visual rules: numbers from the evidence ledger become data cards, not prose — comparisons (scores, money, percentages) use template data-bars with a data payload ({kind, title, items:[{label,value,note?}]}), one standout figure uses data-stat, top-N lists and enumerations use data-list. Card text max ~70 characters; never cram a ranking or a list into one text string (split into sequential cards or items). The produce step also enriches visuals deterministically, but authored data cards take precedence.',
    'Craft rules (research-backed, docs/research/DOCUMENTARY-CRAFT-RESEARCH.md): (1) HOOK — scene S01 opens on visual evidence or a proven claim within ~15s and states the promise by ~30s; never open on a title card, the hook earns the title. (2) STRUCTURE — beats connect with "but"/"therefore", never "and then"; choose the reveal order deliberately (chronological is rarely the best); escalate to a midpoint reversal, then an irreversible decision. (3) OPEN LOOPS — every scene raises a question before resolving the prior one; open a smaller loop BEFORE closing one; document this per beat with opens_loop/closes_loop. (4) NARRATION — never narrate what the viewer can already see on screen; short active sentences; present tense for immediacy, past tense for hindsight; the climax may play with no narration at all. (5) ENDING — the payoff lands in the final scene and the last line points forward honestly (what question remains). (6) STYLE — pick style_preset from the niche: true crime → true-crime (case file), history/archival → archival-history (newsprint), science/tech → science-explainer (vivid navy), investigative/OSINT → investigative-cinema (noir letterbox), business/finance → business-clean (clean data), general essay → vox-explainer (Swiss editorial grid), premium brand → kallaway (premium glass); each preset is a distinct LAYOUT LANGUAGE — panel geometry, typography, media treatment and furniture — not a recolour, so do not pick two presets for the same structural reason. State in one bible line why it fits this film.',
    '(7) VISUAL DIRECTION — no two films should cut together the same way. After workflow_write, call style_write ONCE to author the film identity: an accent derived from the subject/period (never the preset stock color), caption treatment, grain/vignette, and a transition_set signature (smooth | hard-cuts | cinematic | broadcast) — and name the identity in one look line (e.g. "1930s newsprint: oxblood accent, heavy grain, hard cuts on reveals"). In workflow_write give EVERY scene a visual {mood, layout, accent?}: mood grades the footage to the beat (neutral | warm | cool | sepia | noir | vivid), layout composes the scene (standard | full-bleed | split | centered | minimal), and an optional accent shift marks act breaks — time the palette shift to the turn (research §3.2). Choose shot motion by meaning: push-in on a reveal, pull-out to release tension, pan to travel across a subject, still on solemn evidence. Vary layouts across the film — one repeated look reads as a slideshow, and a same-niche film must not look like the last one. Use split only when the scene actually has media to fill the other side; with no media, centered reads better than a half-empty frame.',
    '(8) LAYOUT MUST FIT — every card is a composed frame, not an infinite slide. One idea per card: headline ≤ 60 characters (hard max ~80), a data-stat figure ≤ 10 characters, labels ≤ 40. A prose sentence is NEVER a stat figure: use template quote-card, or put it in data.items[0].note (the engine renders it as a fitted pull-quote, not a giant number). Never repeat the figure in the card title ("1,000+" above "1000") and never cram a ranking or list into one text string. The engine auto-fits type, but short copy at a confident size always reads better than long copy shrunk to fit.',
    '(9) TWO BOXES (duo) — when a beat COMPARES two things (before/after, claim vs counterclaim, two people, two eras), author ONE shot with template "duo" and exactly two panels: panels: [{asset_path, kicker, title, note}, {asset_path, kicker, title, note}]. An image and its text sit together on one screen; both assets must be rights-approved and distinct, and each panel needs a short title (≤ 50 chars) and/or note. Use duo when the comparison is the point — not two consecutive full-frame cards that force the viewer to remember the first.',
    '(10) MOTION GRAPHICS THAT CARRY MEANING — use the chart vocabulary where it answers a question: data-timeline for the subject chronology (4–8 milestones, years spread out), data-map for where it happened (2–6 real places; supply lat/lon when known — common city names resolve from an offline gazetteer; route:true for a journey), data-line for a measurable trend (3–8 points taken from the evidence, never invented), and article for a key source quote (publication/date/headline/body/quote — it recreates the clipping and sweeps a highlighter across the quote, labeled as a reconstruction). Use each where the narration asks where/when/how much; one or two per film, never a slideshow of charts. Geography and chronology must be evidence-true — no decorative pins or made-up years.',
    '(11) TIMING — for EVERY shot set narration_cue to the exact phrase from your script that the shot illustrates (3–15 words). The Producer generates the voice-over first and cuts each visual to those spoken words; a shot without a cue is only matched by its card text and can drift away from the narration. One visual idea per cue; if a passage has two ideas, write two shots.',
    'STRICT PHASE ORDER — one tool per phase, in this order: state_digest → bible_write → script_write → shots_write → workflow_write → style_write → retention_review → finish. Do not skip a phase or reorder. If retention_review verdicts "fix", revise the named scenes (rewrite the failing artifact) and run retention_review again before finish.',
    targetRuntimeSeconds != null
      ? `Runtime budget: the user set ${Math.round(targetRuntimeSeconds / 60)} minutes (${targetRuntimeSeconds}s). This is a HARD requirement, and the film is exactly as long as its narration: write roughly ${Math.round((targetRuntimeSeconds / 60) * 155)}–${Math.round((targetRuntimeSeconds / 60) * 170)} words of script (≈${Math.round((targetRuntimeSeconds / 60) * 155)} words at ~155 wpm), split across enough sections that each carries a real part of the story (a 15-minute film needs ~9–12 sections). script_write REFUSES a transcript that cannot fill the budget, so do not stop early — deepen each section with evidence from the ledger rather than padding with filler. Scene durations (duration_target_s) must then sum to ≈${targetRuntimeSeconds}s (within ±10%). Script sections map 1:1 to scenes (same ids: hook, s01…); shot rows must reference saved_path values verbatim from state_digest.usable_assets.`
      : 'Runtime: the user did NOT set a length — default to a 15-minute film (900s) and treat that as the target unless the evidence genuinely cannot support it. A standard documentary is 12–18 minutes: write a script long enough to fill it (roughly 2,300–2,800 words of narration at ~155 wpm), with enough scenes (typically 8–12) and enough evidence beats per scene to carry that length. Only go shorter (down to ~6 minutes) when the ledger is thin (fewer than ~10 claims or a single source), and say why in runtime_decision. Never pad with filler — instead find more of the story in the evidence. State the runtime you chose and the one-line reason in bible_write.runtime_decision, then budget scene durations (duration_target_s) to sum to it. Script sections map 1:1 to scenes (same ids: hook, s01…); shot rows must reference saved_path values verbatim from state_digest.usable_assets.',
    'If a tool validation fails, fix the specific problem it names and call that same phase again — do not restart from the bible unless it is the failing phase.',
    "SCRIPT SIZE — a whole film's narration (~2,300+ words for 15 minutes) may not fit one script_write call. Author it incrementally: call script_write with the sections that fit, then call it again with mode:'append' sending ONLY the sections to deepen or add (full new text per section; same id overwrites, the rest are kept) until the script fills the runtime budget. The budget check runs on the merged whole, so no work is ever lost between calls.",
    revision,
    '',
    '=== DWK operating procedure (AGENT_GUIDE.md, binding) ===',
    guide.slice(0, 5000),
    '',
    '=== Task ===',
    `Project folder: ${projectPath}`,
    `Direction brief: ${brief}`
  ].join('\n')
}

export class DirectorRunner {
  constructor(private readonly opts: DirectorRunnerOptions) {}

  private emit(activity: DirectorActivity): void {
    this.opts.deps.emit(activity)
  }

  async run(): Promise<DirectorRunResult> {
    const { chat, deps } = this.opts
    const handlers = createDirectorHandlers(deps)
    const journalPath = join(deps.projectPath, 'research', 'director_sessions.jsonl')
    mkdirSync(dirname(journalPath), { recursive: true })
    const journal = (entry: Record<string, unknown>): void => {
      try {
        appendFileSync(journalPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8')
      } catch {
        // journaling must never break direction
      }
    }

    const messages: AgentMessage[] = [
      {
        role: 'system',
        content: systemPrompt(this.opts.dwkRoot, deps.projectPath, deps.revisionNotes ? 'revise the film per the revision request' : 'design the full film', deps.revisionNotes, deps.targetRuntimeSeconds ?? null)
      },
      {
        role: 'user',
        content: deps.revisionNotes
          ? `Revise the film design now, incorporating the revision notes. Re-write every artifact coherently (bible → script → shots → workflow → style), then finish.`
          : `Design the complete documentary now: state_digest → bible_write → script_write → shots_write → workflow_write → style_write → retention_review → finish. Target the evidence you actually have; reference only usable (downloaded, approved) assets in shots.`
      }
    ]

    let turns = 0
    let toolCallCount = 0
    let summary = ''
    let stoppedReason: DirectorRunResult['stoppedReason'] = 'max_turns'
    const maxTurns = this.opts.maxTurns ?? 24
    let workflowWritten = false
    let emptyCompletions = 0
    let skipExtension = false
    const workflowPath = join(deps.projectPath, 'studio', 'workflow.json')

    while (turns < maxTurns) {
      this.opts.throwIfCancelled?.()
      // Budget guardrails (the Scout pattern): the most common failure mode is
      // exhausting turns one phase before workflow_write — produce cannot run
      // without studio/workflow.json.
      const remaining = maxTurns - turns
      if (remaining === 6) {
        messages.push({
          role: 'system',
          content:
            'URGENT — 6 turns left. Complete the remaining phases NOW in order. workflow_write is MANDATORY before finish — the film cannot be produced without it. Skip further polish if needed.'
        })
      }
      if (remaining === 3) {
        messages.push({
          role: 'system',
          content:
            'FINAL WARNING — 3 turns left. Immediately: workflow_write (scenes matching the script sections you wrote) → finish(summary). Do not call any other tool.'
        })
      }
      turns++
      let completion
      try {
        completion = await chat.complete(messages, directorToolSchemas, { temperature: 0.4 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.emit({ type: 'error', summary: `provider error: ${msg}`, at: new Date().toISOString() })
        summary = `Director stopped: provider error — ${msg}`
        stoppedReason = 'message'
        skipExtension = true
        break
      }

      // Empty-completion resilience (mirrors scout.ts): some providers return a
      // 200 with no content and no tool calls; the loop used to quit there,
      // mislabeled as the turn limit while bible/script/shots were already on
      // disk and workflow.json was never written (grok-company 2026-11-14).
      if (completion.toolCalls.length === 0 && !(completion.content ?? '').trim()) {
        emptyCompletions++
        const why = [
          completion.finishReason ? `finish_reason=${completion.finishReason}` : null,
          completion.reasoningChars ? `${completion.reasoningChars} chars came back as reasoning-only (no answer)` : null
        ]
          .filter(Boolean)
          .join(', ')
        journal({ action: 'empty_completion', attempt: emptyCompletions, finish_reason: completion.finishReason ?? null, reasoning_chars: completion.reasoningChars ?? 0 })
        if (emptyCompletions > 2) {
          const msg = `provider returned three empty completions in a row${why ? ` (${why})` : ''} — the model is not answering; switch model/provider in Settings`
          this.emit({ type: 'error', summary: msg, at: new Date().toISOString() })
          summary = `Director stopped: ${msg}`
          stoppedReason = 'message'
          skipExtension = true
          break
        }
        messages.push({
          role: 'system',
          content:
            'Your last reply was empty. Continue directing the film: call the next phase tool in order (state_digest → bible_write → script_write → shots_write → workflow_write → style_write → retention_review → finish).'
        })
        continue
      }
      emptyCompletions = 0

      if (completion.toolCalls.length === 0) {
        // Text-only reply: the model wrapped up (or stalled) in prose instead
        // of calling tools. End the run as before — the workflow extension
        // below catches the case where the design was left incomplete.
        summary = completion.content ?? ''
        this.emit({ type: 'message', summary, at: new Date().toISOString() })
        stoppedReason = 'message'
        break
      }

      const executed = await this.executeCompletion(completion, messages, handlers, journal, (count) => {
        toolCallCount += count
      })
      if (executed.wroteWorkflow) workflowWritten = true
      if (executed.finishSummary !== undefined) summary = executed.finishSummary
      if (executed.finishNow) {
        stoppedReason = 'finish'
        break
      }
    }

    // Weak-model insurance: a run that ends without workflow.json cannot be
    // produced. Give the model a bounded, single-purpose extension — except
    // when the provider itself is the problem (errors / silent empties).
    if (!skipExtension && !workflowWritten && !existsSync(workflowPath)) {
      this.emit({ type: 'message', summary: 'workflow.json missing — extending the run to write it', at: new Date().toISOString() })
      journal({ action: 'workflow_missing_extension', turns })
      messages.push({
        role: 'system',
        content:
          'The run ended without workflow.json — the film cannot be produced without it. Call workflow_write NOW with scenes matching the script sections already written (vo_script_section = section ids from script.md, beats from bible.md, shots per the rules), then finish. No other tools.'
      })
      const extensionCap = turns + 4
      let extensionEmpties = 0
      while (turns < extensionCap) {
        this.opts.throwIfCancelled?.()
        turns++
        let completion
        try {
          completion = await chat.complete(messages, directorToolSchemas, { temperature: 0.2 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          summary = `${summary} — extension stopped: provider error (${msg})`
          break
        }
        if (completion.toolCalls.length === 0 && !(completion.content ?? '').trim()) {
          extensionEmpties++
          journal({ action: 'empty_completion', attempt: extensionEmpties, phase: 'extension', finish_reason: completion.finishReason ?? null, reasoning_chars: completion.reasoningChars ?? 0 })
          if (extensionEmpties > 1) {
            summary = `${summary} — the provider went silent while the workflow was still missing`.trim()
            break
          }
          messages.push({ role: 'system', content: 'Your last reply was empty. Call workflow_write now, then finish.' })
          continue
        }
        const executed = await this.executeCompletion(completion, messages, handlers, journal, (count) => {
          toolCallCount += count
        })
        if (executed.wroteWorkflow) workflowWritten = true
        if (executed.finishSummary !== undefined) summary = executed.finishSummary
        if (workflowWritten || executed.finishNow) break
      }
      if (workflowWritten) summary = `${summary} — workflow.json written.`.trim()
    }

    if (!workflowWritten && !existsSync(workflowPath)) {
      const note = 'workflow.json was never written — the film cannot be produced; re-run /direct.'
      summary = summary ? `${summary} — ${note}` : `Director stopped incomplete: ${note}`
    } else if (stoppedReason === 'max_turns') {
      summary = summary || `Director hit the ${maxTurns}-turn limit; artifacts written so far are on disk.`
    }
    this.emit({ type: 'done', summary, at: new Date().toISOString() })
    journal({ action: 'done', turns, toolCallCount, stoppedReason, summary, workflow_written: workflowWritten || existsSync(workflowPath) })
    return { summary, turns, toolCalls: toolCallCount, stoppedReason }
  }

  /**
   * Dispatch one completion's tool calls (assistant + tool messages, emits,
   * journal). Returns whether a workflow_write succeeded, the finish summary,
   * and whether the model called finish.
   */
  private async executeCompletion(
    completion: { content: string | null; toolCalls: AgentToolCall[] },
    messages: AgentMessage[],
    handlers: ReturnType<typeof createDirectorHandlers>,
    journal: (entry: Record<string, unknown>) => void,
    addToolCalls: (count: number) => void
  ): Promise<{ wroteWorkflow: boolean; finishNow: boolean; finishSummary?: string }> {
    const out: { wroteWorkflow: boolean; finishNow: boolean; finishSummary?: string } = {
      wroteWorkflow: false,
      finishNow: false
    }
    messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls })
    for (const call of completion.toolCalls as AgentToolCall[]) {
      this.opts.throwIfCancelled?.()
      addToolCalls(1)
      const args = safeParseArgs(call.function.arguments)
      this.emit({ type: 'tool_call', tool: call.function.name, summary: phaseLabel(call.function.name), at: new Date().toISOString() })
      journal({ action: 'tool_call', tool: call.function.name, args })
      let result: unknown
      try {
        const handler = handlers[call.function.name]
        if (!handler) throw new Error(`unknown tool: ${call.function.name}`)
        result = await handler(args)
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
        this.emit({
          type: 'error',
          tool: call.function.name,
          summary: (result as { error: string }).error,
          at: new Date().toISOString()
        })
      }
      this.emit({
        type: 'tool_result',
        tool: call.function.name,
        summary: summarizeDirectorResult(call.function.name, result),
        at: new Date().toISOString()
      })
      journal({ action: 'tool_result', tool: call.function.name, result: result })
      if (call.function.name === 'workflow_write' && result && typeof result === 'object' && !(result as { error?: string }).error) {
        out.wroteWorkflow = true
      }
      if (call.function.name === 'finish') {
        out.finishSummary = (result as { summary?: string }).summary ?? ''
        out.finishNow = true
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, TOOL_RESULT_LIMIT)
      })
    }
    return out
  }
}

function phaseLabel(tool: string): string {
  switch (tool) {
    case 'state_digest':
      return 'studying the evidence'
    case 'bible_write':
      return 'designing the Documentary Bible'
    case 'script_write':
      return 'writing the narration script'
    case 'shots_write':
      return 'building the shot list'
    case 'workflow_write':
      return 'writing the executable workflow'
    case 'style_write':
      return 'directing the visual identity'
    case 'retention_review':
      return 'self-checking retention'
    case 'finish':
      return 'finishing'
    default:
      return tool
  }
}

function summarizeDirectorResult(tool: string, result: unknown): string {
  const r = result as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return String(result).slice(0, 120)
  if (typeof r.error === 'string') return `error: ${r.error.slice(0, 150)}`
  switch (tool) {
    case 'state_digest':
      return `evidence: ${JSON.stringify(r.counts ?? {})}`
    case 'bible_write':
      return `${r.scenes ?? 0} scenes, runtime ${r.total_runtime_s ?? 0}s`
    case 'script_write':
      return `${r.sections ?? 0} sections, ${r.words ?? 0} words ≈ ${r.estimated_speak_seconds ?? 0}s spoken`
    case 'shots_write':
      return `${r.shots ?? 0} shots, timeline to frame ${r.frames_end ?? 0}`
    case 'workflow_write':
      return `${r.scenes ?? 0} scenes in workflow`
    case 'style_write':
      return `visual identity: ${String(r.look ?? 'authored').slice(0, 80)}`
    case 'retention_review':
      return String(r.summary ?? 'reviewed').slice(0, 120)
    case 'finish':
      return 'finished'
    default:
      return JSON.stringify(result).slice(0, 120)
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { _raw: raw.slice(0, 200) }
  }
}
