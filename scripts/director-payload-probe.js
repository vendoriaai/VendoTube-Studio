/**
 * Diagnostic: send the Director's REAL first-turn payload (system prompt +
 * state_digest) to the configured model and report finish_reason / sizes.
 * Run through live-key-bridge.js with LIVE_TEST=probe2 (VT_* env injected).
 * Read-only: talks to the bridge, never writes project files.
 */
const { spawn } = require('node:child_process')
const { readFileSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const baseUrl = process.env.VT_BASE_URL
const model = process.env.VT_MODEL
const key = process.env.VT_KEY
const projectPath = process.env.VT_PROJECT
if (!baseUrl || !model || !key || !projectPath) {
  console.error('[probe2] missing VT_BASE_URL/VT_MODEL/VT_KEY/VT_PROJECT')
  process.exit(2)
}

class LiveBridge {
  constructor() {
    this.proc = spawn('python', ['bridge/server.py'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = ''
    this.nextId = 0
    this.pending = new Map()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk
      let idx
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
          }
        } catch {
          /* noise */
        }
      }
    })
  }
  request(method, params, timeoutMs = 120000) {
    const id = ++this.nextId
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); res(v) }, reject: (e) => { clearTimeout(t); rej(e) } })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
    })
  }
  close() { try { this.proc.stdin.end() } catch {} }
}

;(async () => {
  const bridge = new LiveBridge()
  try {
    const digest = await bridge.request('ledger.digest', { project_path: projectPath })
    const assets = await bridge.request('assets.list', { project_path: projectPath })
    const rows = Array.isArray(assets.candidates) ? assets.candidates : []
    const usable = rows
      .filter((a) => a.downloaded === true && typeof a.saved_path === 'string' && a.saved_path)
      .map((a) => ({
        asset_id: a.asset_id,
        saved_path: a.saved_path,
        media_type: a.media_type,
        title: a.title,
        license: a.license,
        date: a.date,
        rights_status: a.rights_status
      }))
    const stateDigest = {
      ...(digest && typeof digest === 'object' ? digest : {}),
      downloaded_count: rows.filter((a) => a.downloaded === true).length,
      rights_approved_count: rows.filter((a) => String(a.rights_status) === 'approved').length,
      usable_assets: usable
    }

    // Approximate the Director system prompt: reuse the real file's text blocks.
    const directorTs = readFileSync(resolve(process.cwd(), 'src/main/agent/director.ts'), 'utf8')
    const guidePath = resolve(process.cwd(), '..', 'documentary_workflow_kit', 'documentary_workflow_kit', 'AGENT_GUIDE.md')
    const guide = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : ''
    const systemPrompt = [
      'You are Director, the scenario agent of a documentary studio crew.',
      'You study the evidence ledger and the asset library and design the film.',
      '(craft rules omitted here — this probe measures payload size, not prompt text)',
      guide.slice(0, 6356)
    ].join('\n')

    const digestJson = JSON.stringify(stateDigest)
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Evidence and assets digest (JSON):\n' + digestJson + '\n\nBegin: design the film.' }
    ]
    const approxTokens = Math.round((systemPrompt.length + digestJson.length) / 3.6)
    console.log(`[probe2] system prompt chars: ${systemPrompt.length}`)
    console.log(`[probe2] digest JSON chars: ${digestJson.length}`)
    console.log(`[probe2] usable_assets: ${usable.length}`)
    console.log(`[probe2] approx input tokens: ${approxTokens}`)
    console.log(`[probe2] director.ts chars: ${directorTs.length}`)

    for (const maxTokens of [8192, 16384]) {
      const t0 = Date.now()
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(300000)
      })
      const j = await r.json()
      const c = j.choices && j.choices[0]
      const content = (c && c.message && c.message.content) || ''
      const reasoning = (c && c.message && (c.message.reasoning_content || c.message.reasoning)) || ''
      console.log(`[probe2] max_tokens=${maxTokens} http=${r.status} finish=${c && c.finish_reason} contentChars=${content.length} reasoningChars=${reasoning.length} secs=${Math.round((Date.now() - t0) / 1000)}`)
      if (j.usage) console.log(`[probe2]   usage: ${JSON.stringify(j.usage)}`)
      if (j.error) console.log(`[probe2]   error: ${JSON.stringify(j.error).slice(0, 300)}`)
    }
  } finally {
    bridge.close()
  }
})().catch((e) => {
  console.error('[probe2] fatal:', e.message)
  process.exit(1)
})
