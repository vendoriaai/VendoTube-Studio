/**
 * Live Supabase connection test for the vendoria.ai project.
 *
 * Standalone script (never runs under vitest — filename doesn't match the
 * include pattern). Mirrors EXACTLY the client options auth.ts
 * createSupabaseAuthClient builds, minus electron-specific persistence
 * (in-memory stand-in for the secrets-backed storage adapter).
 *
 * Flow: status (no session) → signUp a throwaway probe user (no session is
 * expected — the project has email confirmation ON) → verify auth.users +
 * the auto-created profiles row via the Management API → admin-confirm the
 * probe → sign IN with the password (real session) → getUser → signOut.
 * Cleanup deletes the probe user via the auth admin API (profile cascades).
 *
 * Usage: node scripts/test-supabase-connection.mjs
 * Env:   SUPABASE_ACCESS_TOKEN (personal access token, for the Management API
 *        verification steps) — required.
 */

import { createClient } from '@supabase/supabase-js'
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from '../src/main/supabase-config.ts'
import { execFileSync } from 'node:child_process'

// Account-level secret — pass it via env, never commit one:
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/test-supabase-connection.mjs
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? ''
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required (Supabase personal access token, Management API).')
  process.exit(1)
}
const REF = 'ercipwxeirrwzpbvlgkn'
// NOTE: this project runs GoTrue ≥2.198 with deliverability validation —
// non-deliverable domains (example.com, .invalid) are REJECTED at signup.
// A deliverable domain is required for the probe; the mailbox is a made-up
// address that simply never confirms.
const PROBE_EMAIL = `vendotube.probe.${Date.now()}@gmail.com`
const PROBE_PASSWORD = 'probe-secret-1'

const log = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/** Management API SQL — static strings only (no user input is interpolated). */
function sql(query) {
  const out = execFileSync(
    'curl',
    [
      '-s', '--max-time', '30', '-X', 'POST',
      `https://api.supabase.com/v1/projects/${REF}/database/query`,
      '-H', `Authorization: Bearer ${ACCESS_TOKEN}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ query })
    ],
    { encoding: 'utf8' }
  )
  return JSON.parse(out)
}

// Same options as auth.ts createSupabaseAuthClient (persistence in-memory here —
// the app wires this same shape to the safeStorage-encrypted secrets table).
const memStore = new Map()
const storage = {
  getItem: (key) => memStore.get(key) ?? null,
  setItem: (key, value) => {
    memStore.set(key, value)
  },
  removeItem: (key) => {
    memStore.delete(key)
  }
}
const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
  auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
})

// 1. Config sanity (the app's own gate function).
log(supabaseConfigured(), 'supabaseConfigured() accepts the baked URL + anon key', supabaseUrl())

// 2. Auth service reachable.
const health = await fetch(`${supabaseUrl()}/auth/v1/health`, { headers: { apikey: supabaseAnonKey() } })
log(health.ok, 'auth /health reachable', `HTTP ${health.status}`)

// 3. Boot-time status: configured, no session yet.
const status0 = await supabase.auth.getSession()
log(status0.data.session === null && !status0.error, 'status: no stored session at boot')

// 4. Probe user. With the service key we use the ADMIN path — it writes the
//    auth.users row directly and sends NO email (this project's email rate
//    limit is 2/hour and is shared with the other app using the project, so
//    the anonymous signup's confirmation email is usually exhausted). Without
//    a service key, fall back to the anonymous signUp path.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const admin = SERVICE_KEY
  ? createClient(supabaseUrl(), SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

let probeId = null
if (admin) {
  const created = await admin.auth.admin.createUser({
    email: PROBE_EMAIL,
    password: PROBE_PASSWORD,
    email_confirm: true
  })
  probeId = created.data?.user?.id ?? null
  log(created.error === null && probeId !== null, 'admin: probe user created (no email sent)', created.error?.message ?? `user ${probeId}`)
} else {
  const signup = await supabase.auth.signUp({ email: PROBE_EMAIL, password: PROBE_PASSWORD })
  probeId = signup.data?.user?.id ?? null
  if (signup.error === null) {
    log(true, 'signUp accepted', `user ${probeId}`)
    log(signup.data.session === null, 'needsEmailConfirmation=true (project has "Confirm email" ON — expected)')
  } else if (/rate limit/i.test(signup.error.message)) {
    console.log(`SKIP  anonymous signUp — ${signup.error.message} (project emails 2/hour; rerun later or use SUPABASE_SERVICE_KEY)`)
  } else {
    log(false, 'signUp accepted', signup.error.message)
  }
}

// 5. Database-side assertions (auth.users row + auto-created profile row).
if (probeId) {
  try {
    const rows = sql(
      `select (select count(*) from auth.users where id = '${probeId}') as user_rows,
              (select display_name from public.profiles where id = '${probeId}') as profile_display_name`
    )
    log(rows[0].user_rows === 1, 'auth.users row written to the database')
    log(typeof rows[0].profile_display_name === 'string', 'profiles row auto-created by on_auth_user_created', `display_name='${rows[0].profile_display_name}'`)
  } catch (err) {
    log(false, 'management-API database assertions', String(err.message ?? err))
  }
} else {
  log(false, 'database assertions skipped — no probe user was created')
}

// 6. Session round-trip on the real (anon) client: sign in with the probe's
//    password, verify against the server, sign out. Admin-created probes are
//    already email-confirmed, so no update step is needed.
if (probeId && admin) {
  const signin = await supabase.auth.signInWithPassword({ email: PROBE_EMAIL, password: PROBE_PASSWORD })
  log(signin.error === null && signin.data.session !== null, 'signInWithPassword returns a live session', signin.error?.message ?? `user ${signin.data.user?.id}`)
  const me = signin.error === null ? await supabase.auth.getUser() : null
  log(me !== null && me.error === null && me.data.user?.id === probeId, 'getUser verifies the session against the server')
  const signedOut = await supabase.auth.signOut()
  log(signedOut.error === null, 'signOut clears the session')
  // 7. Cleanup: delete the probe user via the admin API (profile cascades).
  const del = await admin.auth.admin.deleteUser(probeId)
  log(del.error === null, 'cleanup: probe user deleted via admin API', del.error?.message ?? '')
  const after = sql(
    `select (select count(*) from auth.users where id = '${probeId}') as u, (select count(*) from public.profiles where id = '${probeId}') as p`
  )
  log(after[0].u === 0 && after[0].p === 0, 'cleanup verified: no user/profile rows left')
} else if (!probeId) {
  console.log('SKIP  session round-trip + cleanup — no probe user was created this run')
}

console.log(`\nDone — exit ${process.exitCode ?? 0}`)
