/**
 * Live E2E for the Bible cloud-save against the vendoria.ai project.
 *
 * Proves the FULL path the app runs: signed-in user → BibleSyncService →
 * PostgREST tables (vendotube_bibles / _sources / _assets) with RLS →
 * upsert idempotency → cleanup. No real user data is used — a throwaway
 * admin-created probe account owns everything and is deleted at the end
 * (rows cascade).
 *
 * Usage: SUPABASE_SERVICE_KEY=<service_role> node scripts/test-bible-sync-live.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from '../src/main/supabase-config.ts'
// Node type-stripping resolves ../src/main/bibleSync.ts — its @shared import is
// type-only (erased), so no alias plugin is needed here.
import { BibleSyncService, createSupabaseBibleSync } from '../src/main/bibleSync.ts'

// Account-level secret — pass it via env, never commit one:
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/test-bible-sync-live.mjs
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? ''
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required (Supabase personal access token, Management API).')
  process.exit(1)
}
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const REF = 'ercipwxeirrwzpbvlgkn'
const PROBE_EMAIL = `vendotube.sync.${Date.now()}@gmail.com`
const PROBE_PASSWORD = 'probe-secret-1'

const log = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

function sql(query) {
  const out = execFileSync('curl', [
    '-s', '--max-time', '30', '-X', 'POST',
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    '-H', `Authorization: Bearer ${ACCESS_TOKEN}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ query })
  ], { encoding: 'utf8' })
  return JSON.parse(out)
}

if (!supabaseConfigured() || !SERVICE_KEY) {
  console.log('FAIL  prerequisites missing (config or SUPABASE_SERVICE_KEY)')
  process.exit(1)
}
log(true, 'config', supabaseUrl())

// Probe account (admin path — no confirmation email, see connection-script notes).
const admin = createClient(supabaseUrl(), SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const created = await admin.auth.admin.createUser({ email: PROBE_EMAIL, password: PROBE_PASSWORD, email_confirm: true })
const probeId = created.data?.user?.id
log(created.error === null && !!probeId, 'probe user created', created.error?.message ?? probeId)

// The app's client shape (same options as auth.ts createSupabaseClient).
const memStore = new Map()
const storage = {
  getItem: (k) => memStore.get(k) ?? null,
  setItem: (k, v) => memStore.set(k, v),
  removeItem: (k) => memStore.delete(k)
}
const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
  auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
})
const signin = await supabase.auth.signInWithPassword({ email: PROBE_EMAIL, password: PROBE_PASSWORD })
log(signin.error === null, 'probe signed in (session lives in the same client the sync uses)', signin.error?.message ?? '')

const bundle = /** @type {BibleBundle} */ ({
  bible: {
    title: 'The Vanishing Ice',
    thesis: 'Glacier loss is accelerating faster than models predicted',
    targetRuntimeSeconds: 900,
    runtimeDecision: null,
    stylePreset: 'science-explainer',
    emotionalPromise: 'wonder to urgency',
    arc: 'beauty → collapse → agency',
    scenes: [{ id: 's01', label: 'HOOK', title: 'A River Where Ice Was', shows: 'archive', feels: 'unease', motion: 'kenburns', look: null, onScreenText: '1979', durationTargetS: 12, claims: ['c-1'], assetIds: ['a-1'] }]
  },
  beats: [{ id: 'b1', scene: 's01', label: 'hook', startS: 0, durS: 12, curiosity: 8, tension: 5, rehook: false, opensLoop: null, closesLoop: null }],
  workflow: {},
  scriptSections: [{ id: 'sec-1', title: 'Hook', body: 'In 1979 this ice was forty meters thick.' }],
  sceneNotes: { s01: 'use the 1979 still' },
  validation: null,
  stage: 'bible_ready'
})

const sync = new BibleSyncService(createSupabaseBibleSync(supabase))
const input = {
  projectSlug: 'the-vanishing-ice',
  projectTitle: 'The Vanishing Ice',
  bundle,
  sourceRows: [
    { source_id: 'src-1', source_type: 'article', title: 'Glacier mass loss study', creator_or_publisher: 'Nature Climate', published_date: '2024-01-15', url: 'https://www.nature.com/articles/glacier-2024', license: 'fair use' },
    { source_id: 'src-2', source_type: 'website', title: 'NASA Ice Sheets', creator_or_publisher: 'NASA', published_date: '2023-11-02', url: 'https://climate.nasa.gov/ice-sheets' },
    { source_id: 'src-3', source_type: 'article', title: 'no url row', url: '' }
  ],
  assetRows: [
    { assetId: 'a-1', assetPageUrl: 'https://commons.wikimedia.org/wiki/File:Ice_core.jpg', downloadUrl: 'https://upload.wikimedia.org/x.jpg', title: 'Ice core', mediaType: 'image', provider: 'commons', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', creator: 'A. Photographer' },
    { assetId: 'a-2', assetPageUrl: 'https://www.youtube.com/watch?v=abc123', title: 'Glacier calving footage', mediaType: 'video', provider: 'youtube', license: 'Standard YouTube', creator: 'Doc Channel' }
  ]
}

// 1. First save.
const res1 = await sync.sync(input)
log(res1.saved === true && res1.sources === 2 && res1.assets === 2, 'sync saved (2 source links, 2 asset links — links only)', JSON.stringify(res1))

// 2. Database-side verification.
const rows = sql(`select
  (select count(*) from public.vendotube_bibles where user_id = '${probeId}') as bibles,
  (select payload->'bible'->>'title' from public.vendotube_bibles where user_id = '${probeId}' limit 1) as payload_title,
  (select count(*) from public.vendotube_bible_sources) as sources_total,
  (select count(*) from public.vendotube_bible_assets) as assets_total`)
log(rows[0].bibles === 1, 'vendotube_bibles row exists for the probe user')
log(rows[0].payload_title === 'The Vanishing Ice', 'payload carries the bible title', `title='${rows[0].payload_title}'`)
log(rows[0].sources_total === 2, '2 source links in the database (the url-less row was dropped)')
log(rows[0].assets_total === 2, '2 asset links in the database (page URLs, not files)')

// 3. RLS: the owner reads their row with their token; anonymous reads nothing.
const anonRead = await fetch(`${supabaseUrl()}/rest/v1/vendotube_bibles`, { headers: { apikey: supabaseAnonKey(), Authorization: `Bearer ${supabaseAnonKey()}` } })
const anonJson = await anonRead.json()
log(Array.isArray(anonJson) && anonJson.length === 0, 'RLS: anonymous request sees zero bible rows')
const token = signin.data.session?.access_token
const ownRead = await fetch(`${supabaseUrl()}/rest/v1/vendotube_bibles`, { headers: { apikey: supabaseAnonKey(), Authorization: `Bearer ${token}` } })
const ownJson = await ownRead.json()
log(Array.isArray(ownJson) && ownJson.length === 1, 'RLS: the owner sees exactly their own row')

// 4. Upsert idempotency: a re-direct replaces links, no duplicates.
const res2 = await sync.sync({ ...input, sourceRows: [...input.sourceRows, { source_id: 'src-9', title: 'New source', url: 'https://example.org/new' }] })
log(res2.saved === true && res2.sources === 3, 're-save after re-direct (one new source link)', JSON.stringify(res2))
const rows2 = sql(`select
  (select count(*) from public.vendotube_bibles where user_id = '${probeId}') as bibles,
  (select count(*) from public.vendotube_bible_sources where bible_id = (select id from public.vendotube_bibles where user_id = '${probeId}' limit 1)) as sources_now`)
log(rows2[0].bibles === 1 && rows2[0].sources_now === 3, 'still one bible row, links replaced (3 now, no duplicates)')

// 5. Cleanup — probe user deleted; all vendotube rows cascade.
const del = await admin.auth.admin.deleteUser(probeId)
log(del.error === null, 'cleanup: probe user deleted', del.error?.message ?? '')
const after = sql(`select
  (select count(*) from public.vendotube_bibles where user_id = '${probeId}') as b,
  (select count(*) from public.vendotube_bible_sources) as s,
  (select count(*) from public.vendotube_bible_assets) as a`)
log(after[0].b === 0 && after[0].s === 0 && after[0].a === 0, 'cleanup verified: all cloud rows cascaded away')

console.log(`\nDone — exit ${process.exitCode ?? 0}`)
