/**
 * LIVE research key bridge — runs under the app's own Electron binary so
 * Electron safeStorage can decrypt the provider key (DPAPI from outside the
 * runtime is not enough on Electron 33). It spawns the vitest live harness
 * with VT_* env vars and exits with the child's code. The key is never
 * printed or written anywhere — it exists only in the child's environment.
 *
 * Usage: npx electron scripts/live-key-bridge.js
 */
const { app, safeStorage } = require('electron')
const Database = require('better-sqlite3')
const { spawn } = require('node:child_process')
const path = require('node:path')

// safeStorage on Electron 33 (Windows) uses Chromium os_crypt, whose wrapping
// key lives in the app profile's "Local State" — point userData at the real
// app profile BEFORE ready so the ciphertext is decryptable here.
app.setPath('userData', path.join(app.getPath('appData'), 'VendoTube Studio'))

app.whenReady().then(() => {
  try {
    const dbPath = path.join(app.getPath('appData'), 'VendoTube Studio', 'app.db')
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT ciphertext FROM secrets WHERE key='provider.api_key'").get()
    const setting = (k) => {
      const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k)
      if (!r) return null
      try {
        return JSON.parse(r.value) // settings values are stored JSON-encoded
      } catch {
        return r.value
      }
    }
    const baseUrl = setting('provider.base_url')
    const model = setting('provider.model')
    db.close()
    const key = row && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(row.ciphertext, 'base64'))
      : null
    if (!key) {
      console.error('[live-key] provider key unreadable — nothing to run')
      app.exit(1)
      return
    }
    const env = {
      ...process.env,
      VT_BASE_URL: baseUrl || 'https://openrouter.ai/api/v1',
      VT_MODEL: model || 'gpt-4o-mini',
      VT_KEY: key
    }
    console.error(`[live-key] provider: ${env.VT_MODEL} @ ${env.VT_BASE_URL} (key …${key.slice(-4)}) — launching live run`)
    // Node ≥18.20 refuses .cmd spawns without a shell — run through cmd.exe
    // with a fixed, code-authored command string (no user input involved).
    // LIVE_TEST=dogfood selects the M5 dogfood harness; probe = provider probe;
    // default = Scout research.
    const mode = process.env.LIVE_TEST
    const cmd =
      mode === 'probe'
        ? 'node scripts/token-probe.js'
        : mode === 'probe2'
          ? 'node scripts/director-payload-probe.js'
          : mode === 'probe3'
            ? 'node scripts/reasoning-probe.js'
            : `npx vitest run ${mode === 'dogfood' ? 'tests/live-dogfood.live.test.ts' : 'tests/live-research.live.test.ts'}`
    console.error(`[live-key] command: ${cmd}`)
    const child = spawn('cmd.exe', ['/c', cmd], {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: 'inherit'
    })
    child.on('exit', (code) => app.exit(code ?? 0))
    child.on('error', (err) => {
      console.error(`[live-key] spawn failed: ${err.message}`)
      app.exit(1)
    })
  } catch (err) {
    console.error(`[live-key] fatal: ${err.message}`)
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  /* harness owns lifetime */
})
