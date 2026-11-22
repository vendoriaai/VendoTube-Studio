/**
 * OpenAI-compatible chat-completions client with tool calling (TAD §6).
 * Works against OpenRouter, Z.ai, Ollama (/v1), or any compatible endpoint —
 * configured via `provider.base_url` + `provider.model` settings and the
 * `provider.api_key` secret. Unit-tested against a local mock server
 * (tests/agent-loop.test.ts), so no provider account is needed to verify.
 */

export interface AgentToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: AgentToolCall[]
  tool_call_id?: string
  name?: string
  /** Vision (M7 Layer 1): when present, the request serializes this message's
   * content as typed parts (text + image_url) per the OpenAI-compatible
   * multimodal contract. Text-only messages are untouched. */
  images?: Array<{ type: 'image_url'; image_url: { url: string } }>
}

export interface AgentTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface FetchEngine {
  name: string
  fetch: typeof fetch
}

export interface ChatClientConfig {
  baseUrl: string
  apiKey: string | null
  model: string
  /** Primary fetch engine; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Full engine ladder — retries ALTERNATE engines, so one broken transport
   * (e.g. HTTP/2 resets on lossy links) no longer kills a run. Overrides
   * fetchImpl when present. */
  engines?: Array<FetchEngine>
  timeoutMs?: number
  /** Completion budget sent to the provider. Without it some providers default
   * to a tiny output budget — reasoning models burn it all and return empty
   * content with finish_reason=length. */
  maxTokens?: number
  /** Cap on hidden reasoning effort for reasoning models (OpenRouter/Z.ai
   * accept `low|medium|high`). Reasoning tokens count against max_tokens, so a
   * model that reasons freely can consume the whole budget and answer with
   * nothing (finish_reason=length, empty content). `low` reserves room for the
   * answer on long Director/Scout turns; omit for providers that reject it. */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface CompletionResult {
  content: string | null
  toolCalls: AgentToolCall[]
  usage: { promptTokens?: number; completionTokens?: number }
  /** Why the provider ended the completion ('stop' | 'length' | 'tool_calls' | …). */
  finishReason?: string | null
  /** Length of reasoning-only text when the model put everything into
   * reasoning tokens and left content empty (GLM/DeepSeek-style models). */
  reasoningChars?: number
}

interface ApiChoiceMessage {
  role: string
  content: string | null
  tool_calls?: AgentToolCall[]
  reasoning_content?: string | null
  reasoning?: string | null
}

export class ChatClient {
  constructor(private readonly cfg: ChatClientConfig) {}

  private endpoint(): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  private engines(): Array<FetchEngine> {
    if (this.cfg.engines && this.cfg.engines.length > 0) return this.cfg.engines
    return [{ name: 'fetch', fetch: this.cfg.fetchImpl ?? fetch }]
  }

  async complete(
    messages: AgentMessage[],
    tools: AgentTool[] = [],
    opts: { temperature?: number; signal?: AbortSignal } = {}
  ): Promise<CompletionResult> {
    // Retry ladder tuned for lossy networks: DNS blips get the longest ladder
    // (they often clear within seconds), HTTP 4xx fails fast, 429/5xx retries.
    // With multiple engines, retries ALTERNATE engines — an HTTP/2 reset on
    // one transport is answered by HTTP/1.1 on the next attempt.
    const engines = this.engines()
    let lastErr: unknown = null
    let budget = this.cfg.maxTokens ?? 4096
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, [0, 2000, 4000, 8000][attempt]))
      const engine = engines[attempt % engines.length]
      try {
        const result = await this.attemptOnce(messages, tools, opts, engine, budget)
        // Reasoning-overflow guard: a reasoning model can burn the whole
        // completion budget on hidden reasoning and return finish_reason=length
        // with no content and no tool calls. Retrying at the same budget just
        // reproduces it, so escalate the budget on this and the next attempt.
        if (
          result.finishReason === 'length' &&
          result.toolCalls.length === 0 &&
          !(result.content ?? '').trim() &&
          budget < this.budgetCeiling()
        ) {
          budget = Math.min(budget * 2, this.budgetCeiling())
          continue
        }
        return result
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        const statusMatch = msg.match(/^provider (4\d\d|5\d\d)/)
        const dnsError = /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(msg)
        if (statusMatch && !statusMatch[1].startsWith('5') && !msg.includes('429')) break // 4xx: fail fast
        if (!statusMatch && !dnsError && attempt >= 2 && engines.length === 1) break // generic network: 3 tries
        // multi-engine: use the full ladder; engine alternation may rescue it
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /** Ceiling for budget escalation when a reasoning model truncates an
   * otherwise-empty reply (base ×4, at least 32k). */
  private budgetCeiling(): number {
    const base = this.cfg.maxTokens ?? 4096
    return Math.max(base * 4, 32768)
  }

  private async attemptOnce(
    messages: AgentMessage[],
    tools: AgentTool[],
    opts: { temperature?: number; signal?: AbortSignal },
    engine: FetchEngine,
    maxTokens: number
  ): Promise<CompletionResult> {
    const doFetch = engine.fetch
    let res: Response
    try {
      res = await doFetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: messages.map((m) =>
            m.images?.length
              ? {
                  ...m,
                  content: [{ type: 'text', text: m.content ?? '' }, ...m.images]
                }
              : m
          ),
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
          max_tokens: maxTokens,
          // Reasoning models count hidden reasoning against max_tokens; capping
          // the effort reserves room for the actual answer/tool call.
          ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
          temperature: opts.temperature ?? 0.3
        }),
        signal: opts.signal ?? AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000)
      })
    } catch (err) {
      // undici hides the real reason in `cause` — surface it plus host + engine
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined
      const host = new URL(this.endpoint()).host
      throw new Error(
        `cannot reach provider ${host} via ${engine.name} (check Base URL in Settings; if this host is blocked on your network, switch to a reachable OpenAI-compatible endpoint)${cause ? ` — ${cause}` : ` — ${String(err)}`}`
      )
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`provider ${res.status}: ${body.slice(0, 300)}`)
    }
    // Lossy networks can truncate response bodies — parse defensively so the
    // error names the failure instead of "Unterminated string at position N".
    const rawBody = await res.text()
    let json: {
      choices?: Array<{ message?: ApiChoiceMessage; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      json = JSON.parse(rawBody)
    } catch {
      throw new Error(
        `provider returned a malformed/truncated response body (${rawBody.length} chars, starts: ${rawBody.slice(0, 120).replace(/\s+/g, ' ')}) — likely a network cut; retry the run`
      )
    }
    const choice = json.choices?.[0]
    const message = choice?.message
    if (!message) throw new Error('provider returned no message')
    const reasoning = message.reasoning_content ?? message.reasoning ?? null
    return {
      content: message.content ?? null,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens
      },
      finishReason: choice?.finish_reason ?? null,
      reasoningChars: reasoning ? reasoning.length : 0
    }
  }
}
