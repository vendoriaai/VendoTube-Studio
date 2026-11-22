/**
 * Diagnostic: same model + prompt, 8192 vs 16384 max_tokens.
 * Run through live-key-bridge.js with LIVE_TEST=probe so VT_* provider env
 * (incl. the decrypted key) is present. Writes nothing to the project.
 */
const baseUrl = process.env.VT_BASE_URL
const model = process.env.VT_MODEL
const key = process.env.VT_KEY

const body = {
  model,
  messages: [
    { role: 'system', content: 'You are a documentary director. Reply with a JSON object only.' },
    { role: 'user', content: 'Design a 3-scene film about the Concorde. Return {"scenes":[{"title":"..."}]}' }
  ]
}

async function once(maxTokens) {
  const t0 = Date.now()
  const r = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ ...body, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(300000)
  })
  const j = await r.json()
  const c = j.choices?.[0]
  const content = c?.message?.content ?? ''
  const reasoning = c?.message?.reasoning_content ?? c?.message?.reasoning ?? ''
  console.log(`[probe] max_tokens=${maxTokens} http=${r.status} finish=${c?.finish_reason} contentChars=${content.length} reasoningChars=${reasoning.length} secs=${Math.round((Date.now() - t0) / 1000)}`)
  console.log(`[probe]   content head: ${JSON.stringify(content.slice(0, 140))}`)
  if (j.error) console.log(`[probe]   error: ${JSON.stringify(j.error).slice(0, 300)}`)
  if (j.usage) console.log(`[probe]   usage: ${JSON.stringify(j.usage)}`)
}

;(async () => {
  console.log(`[probe] provider=${model} @ ${baseUrl}`)
  for (const mt of [8192, 16384]) {
    try {
      await once(mt)
    } catch (e) {
      console.log(`[probe] max_tokens=${mt} FAILED: ${e.message}`)
    }
  }
})()
