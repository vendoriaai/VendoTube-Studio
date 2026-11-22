/**
 * Supabase project config (vendoria.ai).
 *
 * Paste the values from Supabase Dashboard → Project Settings → API:
 *   - Project URL  — `https://<project-ref>.supabase.co`
 *   - anon key     — the *publishable* client key (safe to ship in a desktop
 *                    app). NEVER paste the service_role key here.
 *
 * The env vars SUPABASE_URL / SUPABASE_ANON_KEY override the constants, which
 * is handy for pointing a dev build at a staging project without recompiling.
 */

const CONFIG_URL = 'https://ercipwxeirrwzpbvlgkn.supabase.co'
const CONFIG_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyY2lwd3hlaXJyd3pwYnZsZ2tuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3Njk1MDAsImV4cCI6MjEwNzM0NTUwMH0.j_AVdR2hWSkRV0upxcFGqYR4EKqnXuSZxSOhVYa6KWs'

/** Project URL without a trailing slash ('' when unconfigured). */
export function supabaseUrl(): string {
  const url = (process.env.SUPABASE_URL || CONFIG_URL).trim()
  return url.replace(/\/+$/, '')
}

/** anon publishable key ('' when unconfigured). */
export function supabaseAnonKey(): string {
  return (process.env.SUPABASE_ANON_KEY || CONFIG_ANON_KEY).trim()
}

/** Both values present and shape-checked — gates client creation in index.ts. */
export function supabaseConfigured(): boolean {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(supabaseUrl()) && supabaseAnonKey().length > 20
}
