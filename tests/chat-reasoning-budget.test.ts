import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ChatClient } from '../src/main/agent/chat'

/**
 * Reasoning-overflow guard (2026-11-18 dogfood): a reasoning model can burn the
 * whole completion budget on hidden reasoning and return finish_reason=length
 * with no content and no tool calls. Retrying at the same budget reproduces it,
 * so ChatClient must escalate max_tokens until the model answers — and must
 * surface reasoning_effort when configured.
 */

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

interface MockCtx {
  server: Server
  url: string
  requests: Array<Record<string, unknown>>
}

function startProvider(
  handler: (body: Record<string, unknown>, callIndex: number) => { message: Record<string, unknown>; finish_reason: string }
): MockCtx {
  const requests: Array<Record<string, unknown>> = []
  const s = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      const { message, finish_reason } = handler(body, requests.length - 1)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
    })
  })
  server = s
  return { server: s, url: '', requests }
}

/** Bind a started provider to a real port and return its base URL. */
async function bind(ctx: MockCtx): Promise<MockCtx> {
  await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', () => resolve()))
  ctx.url = `http://127.0.0.1:${(ctx.server.address() as { port: number }).port}/v1`
  return ctx
}

const messages = [{ role: 'user' as const, content: 'design the film' }]

describe('ChatClient reasoning-overflow guard', () => {
  it('escalates max_tokens when a length-truncated reply comes back empty', async () => {
    // First two calls: reasoning ate the whole budget (length, no content).
    // Third call: the model finally answers.
    const ctx = await bind(
      startProvider((_body, i) =>
        i < 2
          ? { message: { role: 'assistant', content: null, reasoning_content: 'x'.repeat(500) }, finish_reason: 'length' }
          : { message: { role: 'assistant', content: '{"scenes":[]}' }, finish_reason: 'stop' }
      )
    )
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'k', model: 'reasoner', maxTokens: 4096 })
    const result = await chat.complete(messages)
    expect(result.content).toBe('{"scenes":[]}')
    expect(result.finishReason).toBe('stop')
    expect(ctx.requests.map((r) => r.max_tokens)).toEqual([4096, 8192, 16384])
  }, 30_000)

  it('stops escalating at the ceiling and returns the truncated reply', async () => {
    const ctx = await bind(
      startProvider(() => ({
        message: { role: 'assistant', content: null, reasoning_content: 'y'.repeat(500) },
        finish_reason: 'length'
      }))
    )
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'k', model: 'reasoner', maxTokens: 4096 })
    const result = await chat.complete(messages)
    // ceiling = max(4096*4, 32768) = 32768; ladder: 4096 → 8192 → 16384 → 32768
    expect(ctx.requests.map((r) => r.max_tokens)).toEqual([4096, 8192, 16384, 32768])
    expect(result.finishReason).toBe('length')
    expect(result.content).toBeNull()
  }, 30_000)

  it('sends reasoning_effort when configured', async () => {
    const ctx = await bind(
      startProvider(() => ({ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }))
    )
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'k', model: 'reasoner', maxTokens: 16384, reasoningEffort: 'low' })
    await chat.complete(messages)
    expect(ctx.requests[0].reasoning_effort).toBe('low')
  })

  it('omits reasoning_effort when not configured', async () => {
    const ctx = await bind(
      startProvider(() => ({ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }))
    )
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'k', model: 'plain', maxTokens: 4096 })
    await chat.complete(messages)
    expect('reasoning_effort' in ctx.requests[0]).toBe(false)
  })

  it('does not escalate a truncated reply that carried a tool call', async () => {
    const ctx = await bind(
      startProvider(() => ({
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'state_digest', arguments: '{}' } }]
        },
        finish_reason: 'length'
      }))
    )
    const chat = new ChatClient({ baseUrl: ctx.url, apiKey: 'k', model: 'reasoner', maxTokens: 4096 })
    const result = await chat.complete(messages, [
      { type: 'function', function: { name: 'state_digest', description: '', parameters: {} } }
    ])
    expect(result.toolCalls).toHaveLength(1)
    expect(ctx.requests).toHaveLength(1)
  })
})
