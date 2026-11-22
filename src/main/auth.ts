import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthStatus, AuthSignUpResult, AuthUserView } from '@shared/ipc'

/**
 * Supabase email/password auth for the vendoria.ai project.
 *
 * Runs in the main process only (all app networking lives in main — the
 * renderer's CSP connect-src stays self/localhost). The supabase-js client is
 * created with a storage adapter backed by the safeStorage-encrypted secrets
 * table, so the session refresh token is DPAPI-encrypted at rest and
 * autoRefreshToken keeps it fresh across app restarts.
 *
 * This module must stay importable under vitest (no `electron` import), so the
 * client is injected as a small structural interface and the persistence
 * adapter is built by the caller (index.ts wires it to secrets.ts).
 */

/** Minimal persistence surface (supabase-js `SupportedStorage` subset). */
export interface SessionPersist {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// ------------------------------------------------------------ structural client

/** Shape of a Supabase user/session we care about (kept loose for stubbing). */
export interface MinimalAuthUser {
  id: string
  email?: string | null
}

export interface MinimalAuthSession {
  user: MinimalAuthUser | null
}

export interface MinimalAuthResponse {
  data: { user: MinimalAuthUser | null; session: MinimalAuthSession | null }
  error: { message: string } | null
}

/** The five GoTrue methods the service uses — the real client satisfies this. */
export interface MinimalAuthClient {
  getSession(): Promise<{ data: { session: MinimalAuthSession | null }; error: { message: string } | null }>
  getUser(): Promise<{ data: { user: MinimalAuthUser | null }; error: { message: string } | null }>
  signUp(credentials: { email: string; password: string }): Promise<MinimalAuthResponse>
  signInWithPassword(credentials: { email: string; password: string }): Promise<MinimalAuthResponse>
  signOut(): Promise<{ error: { message: string } | null }>
}

/** Build the real supabase-js client (one instance serves auth AND the
 *  bible-sync PostgREST calls — a single session, shared refresh).
 *  Lazy import: keeps the whole client stack (and its Node-20 deprecation
 *  notice) out of processes that never configure Supabase.
 *
 *  Realtime: supabase-js ALWAYS constructs a RealtimeClient, and realtime-js
 *  hard-throws at construction when it detects Node without a native
 *  WebSocket (Electron 33 main = Node 20 — the whole whenReady boot chain
 *  silently died on this). This app never opens realtime channels (auth +
 *  PostgREST only), so we hand it the `ws` implementation (native WebSocket
 *  when the runtime has one) purely to satisfy construction. */
export async function createSupabaseClient(url: string, anonKey: string, storage: SessionPersist): Promise<SupabaseClient> {
  const [{ createClient }, ws] = await Promise.all([import('@supabase/supabase-js'), import('ws')])
  const nativeWs = (globalThis as Record<string, unknown>).WebSocket
  const client: SupabaseClient = createClient(url, anonKey, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      // No URL bar in the main process — never try to parse a magic link.
      detectSessionInUrl: false
    },
    realtime: { transport: (nativeWs ?? ws.WebSocket) as never }
  })
  return client
}

// ------------------------------------------------------------------- service

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function assertValidCredentials(email: string, password: string): void {
  if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address')
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
  if (password.length > 72) throw new Error('Password must be at most 72 characters')
}

function toView(user: MinimalAuthUser | null | undefined): AuthUserView | null {
  if (!user?.id) return null
  return { id: user.id, email: user.email ?? null }
}

/** Non-AuthError throws from supabase-js are transport failures (fetch, DNS). */
function friendlyNetworkError(err: unknown, what: string): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${what}: could not reach Supabase — check your connection (${detail})`)
}

export class AuthService {
  /** null = project URL/anon key not configured yet (gate explains this). */
  constructor(private readonly client: MinimalAuthClient | null) {}

  get configured(): boolean {
    return this.client !== null
  }

  /**
   * Boot-time status. Session restore reads the encrypted local cache
   * (getSession), then verifies against the server (getUser). A stored session
   * with unreachable server reports offline:true — the renderer shows a retry
   * instead of silently locking the user out.
   */
  async status(): Promise<AuthStatus> {
    if (!this.client) return { configured: false, user: null, offline: false }
    let session: MinimalAuthSession | null = null
    try {
      const res = await this.client.getSession()
      if (res.error) session = null
      else session = res.data.session ?? null
    } catch (err) {
      // Storage unreadable → treat as signed out; surface why if it's network.
      return { configured: true, user: null, offline: false }
    }
    if (!session) return { configured: true, user: null, offline: false }
    try {
      const res = await this.client.getUser()
      // AuthError (expired/revoked) → real sign-out state, not offline.
      if (res.error) return { configured: true, user: null, offline: false }
      return { configured: true, user: toView(res.data.user), offline: false }
    } catch (err) {
      // Server unreachable: keep the cached identity; renderer offers retry.
      return { configured: true, user: toView(session.user), offline: true }
    }
  }

  async signUp(email: string, password: string): Promise<AuthSignUpResult> {
    if (!this.client) throw new Error('Supabase is not configured')
    // Normalize before validating so stray whitespace can't fail the regex.
    const normalized = email.trim().toLowerCase()
    assertValidCredentials(normalized, password)
    let res
    try {
      res = await this.client.signUp({ email: normalized, password })
    } catch (err) {
      throw friendlyNetworkError(err, 'Sign-up failed')
    }
    if (res.error) throw new Error(res.error.message)
    // session null ⇔ the project still requires email confirmation.
    return { user: toView(res.data.user), needsEmailConfirmation: !res.data.session }
  }

  async signIn(email: string, password: string): Promise<AuthUserView> {
    if (!this.client) throw new Error('Supabase is not configured')
    const normalized = email.trim().toLowerCase()
    assertValidCredentials(normalized, password)
    let res
    try {
      res = await this.client.signInWithPassword({ email: normalized, password })
    } catch (err) {
      throw friendlyNetworkError(err, 'Sign-in failed')
    }
    if (res.error) throw new Error(res.error.message)
    const user = toView(res.data.user)
    if (!user) throw new Error('Sign-in succeeded but no user was returned')
    return user
  }

  /** Always clears local state, even when the server call fails. */
  async signOut(): Promise<void> {
    if (!this.client) return
    try {
      await this.client.signOut()
    } catch (err) {
      // Network failure during sign-out must not leave the UI signed in.
    }
  }
}
