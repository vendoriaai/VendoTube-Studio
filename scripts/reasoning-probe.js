/**
 * Diagnostic: does capping reasoning (reasoning_effort / reasoning.max_tokens)
 * keep the model answering on a large Director-sized payload?
 * Run through live-key-bridge.js with LIVE_TEST=probe3.
 */
const baseUrl = process.env.VT_BASE_URL
const model = process.env.VT_MODEL
const key = process.env.VT_KEY
const projectPath = process.env.VT_PROJECT
if (!baseUrl || !model || !key) {
  console.error('[probe3] missing VT_* env')
  process.exit(2)
}

const { spawn } = require('node:child_process')
class LiveBridge {
  constructor() {
    this.proc = spawn('python', ['bridge/server.py'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = ''
    this.id = 0
    this.pending = new Map()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (c) => {
      this.buf += c
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line)
          const p = this.pending.get(m.id)
          if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
        } catch {}
      }
    })
  }
  request(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 120000)
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); res(v) }, reject: (e) => { clearTimeout(t); rej(e) } })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
    })
  }
  close() { try { this.proc.stdin.end() } catch {} }
}

;(async () => {
  const bridge = new LiveBridge()
  const digest = await bridge.request('ledger.digest', { project_path: projectPath })
  const assets = await bridge.request('assets.list', { project_path: projectPath })
  bridge.close()
  const rows = Array.isArray(assets.candidates) ? assets.candidates : []
  const usable = rows.filter((a) => a.downloaded && a.saved_path).map((a) => ({ asset_id: a.asset_id, saved_path: a.saved_path, media_type: a.media_type, title: a.title, license: a.license, rights_status: a.rights_status }))
  const payload = JSON.stringify({ ...digest, usable_assets: usable })
  const messages = [
    { role: 'system', content: 'You are Director of a documentary studio. Study the evidence and design the film. Reason briefly, then answer.' },
    { role: 'user', content: 'Evidence digest (JSON):\n' + payload + '\n\nDesign the film: state your thesis and scene list as JSON.' }
  ]
  console.log(`[probe3] payload chars: ${payload.length} ≈ ${Math.round(payload.length / 3.6)} tokens`)

  const variants = [
    { name: 'baseline 16384', body: { max_tokens: 16384 } },
    { name: 'reasoning_effort=low', body: { max_tokens: 16384, reasoning_effort: 'low' } },
    { name: 'reasoning.max_tokens=1024', body: { max_tokens: 16384, reasoning: { max_tokens: 1024 } } },
    { name: 'reasoning.exclude=true', body: { max_tokens: 16384, reasoning: { exclude: true } } }
  ]
  for (const v of variants) {
    const t0 = Date.now()
    try {
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, ...v.body }),
        signal: AbortSignal.timeout(300000)
      })
      const j = await r.json()
      const c = j.choices && j.choices[0]
      const content = (c && c.message && c.message.content) || ''
      const reasoning = (c && c.message && (c.message.reasoning_content || c.message.reasoning)) || ''
      const rt = j.usage && j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens
      console.log(`[probe3] ${v.name}: http=${r.status} finish=${c && c.finish_reason} contentChars=${content.length} reasoningChars=${reasoning.length} reasoningTokens=${rt} secs=${Math.round((Date.now() - t0) / 1000)}`)
      if (j.error) console.log(`[probe3]   error: ${JSON.stringify(j.error).slice(0, 240)}`)
    } catch (e) {
      console.log(`[probe3] ${v.name}: FAILED ${e.message}`)
    }
  }
})().catch((e) => { console.error('[probe3] fatal:', e.message); process.exit(1) })
