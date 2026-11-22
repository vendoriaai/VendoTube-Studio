// Diagnostic: does the Director's failure come from the completion budget?
// Replays the Director's first turn shape against the configured provider at
// 8192 (harness) vs 16384 (app) max_tokens and reports finish_reason.
// Reads the key from the app's own DB; prints nothing secret.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const appDb = join(process.env.APPDATA ?? homedir(), 'VendoTube Studio', 'app.db')
const db = new DatabaseSync(appDb, { readOnly: true })
const get = (k) => {
  const row = db.prepare('select value from settings where key = ?').get(k)
  return row ? JSON.parse(row.value) : null
}
const baseUrl = get('provider.base_url')
const model = get('provider.model')
const secret = db.prepare("select value from secrets where name = 'provider.apiKey'").get()
const key = secret ? secret.value : null
if (!baseUrl || !model || !key) {
  console.error('probe: provider settings or key missing — set them in Settings first')
  process.exit(2)
}

const system = [
  'You are the Director of a documentary studio. You design a film from an evidence ledger.',
  'You work by calling tools. Available tools: state_digest, write_bible, write_workflow, style_write, finish.',
  'Reply with exactly one tool call per turn.'
].join('\n')
const user = [
  'Evidence digest: sources=7, claims=26, asset_candidates=35.',
  'Topic: the history of the Concorde supersonic airliner. Target runtime: 600s.',
  'Begin: call state_digest to study the evidence.'
].join('\n')

const call = async (maxTokens) => {
  const t0 = Date.now()
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      tools: [
        {
          type: 'function',
          function: { name: 'state_digest', description: 'Study the evidence ledger', parameters: { type: 'object', properties: {} } }
        }
      ],
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    signal: AbortSignal.timeout(300_000)
  })
  const json = await res.json()
  const choice = json.choices?.[0]
  const content = choice?.message?.content ?? ''
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? ''
  const toolCalls = choice?.message?.tool_calls ?? []
  return {
    maxTokens,
    http: res.status,
    finish: choice?.finish_reason ?? null,
    contentChars: content.length,
    reasoningChars: reasoning.length,
    toolCalls: toolCalls.length,
    secs: Math.round((Date.now() - t0) / 1000),
    error: json.error ? JSON.stringify(json.error).slice(0, 200) : null
  }
}

console.log(`probe: ${model} @ ${baseUrl}`)
for (const mt of [8192, 16384]) {
  try {
    console.log(JSON.stringify(await call(mt)))
  } catch (e) {
    console.log(JSON.stringify({ maxTokens: mt, failed: e.message }))
  }
}
