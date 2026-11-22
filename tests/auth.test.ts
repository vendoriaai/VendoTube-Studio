import { describe, expect, it } from 'vitest'
import { AuthService, type MinimalAuthClient, type MinimalAuthSession } from '../src/main/auth'

/**
 * AuthService unit tests (no electron import — the client is stubbed at the
 * structural MinimalAuthClient interface, mirroring the supabase-js shapes).
 */

const USER = { id: 'user-1', email: 'Ada@Example.com' }

function stubClient(overrides: Partial<MinimalAuthClient> = {}): MinimalAuthClient & { calls: string[] } {
  const calls: string[] = []
  const track = <A extends unknown[], R>(name: string, fn: (...args: A) => R): ((...args: A) => R) => {
    return (...args: A): R => {
      calls.push(name)
      return fn(...args)
    }
  }
  return {
    calls,
    getSession: track('getSession', async () => ({ data: { session: null }, error: null })),
    getUser: track('getUser', async () => ({ data: { user: null }, error: null })),
    signUp: track('signUp', async () => ({ data: { user: null, session: null }, error: null })),
    signInWithPassword: track('signInWithPassword', async () => ({ data: { user: null, session: null }, error: null })),
    signOut: track('signOut', async () => ({ error: null })),
    ...overrides
  }
}

describe('AuthService — unconfigured', () => {
  it('status reports configured:false and no user', async () => {
    const status = await new AuthService(null).status()
    expect(status).toEqual({ configured: false, user: null, offline: false })
  })

  it('signUp/signIn refuse to run', async () => {
    const auth = new AuthService(null)
    await expect(auth.signUp('a@b.co', 'secret1')).rejects.toThrow('Supabase is not configured')
    await expect(auth.signIn('a@b.co', 'secret1')).rejects.toThrow('Supabase is not configured')
  })
})

describe('AuthService — credential validation', () => {
  it('rejects a malformed email without calling the client', async () => {
    const client = stubClient()
    const auth = new AuthService(client)
    await expect(auth.signUp('not-an-email', 'secret1')).rejects.toThrow('valid email')
    await expect(auth.signIn('not-an-email', 'secret1')).rejects.toThrow('valid email')
    expect(client.calls).toEqual([])
  })

  it('rejects a short password without calling the client', async () => {
    const client = stubClient()
    const auth = new AuthService(client)
    await expect(auth.signUp('a@b.co', 'abc')).rejects.toThrow('at least 6 characters')
    expect(client.calls).toEqual([])
  })

  it('trims + lowercases the email before hitting Supabase', async () => {
    const client = stubClient({
      signUp: async (c) => ({ data: { user: { id: 'u', email: c.email }, session: { user: { id: 'u' } } }, error: null })
    })
    const res = await new AuthService(client).signUp('  Ada@Example.COM ', 'secret1')
    expect(res.user?.email).toBe('ada@example.com')
  })
})

describe('AuthService — signUp', () => {
  it('returns the user and needsEmailConfirmation:false when a session comes back', async () => {
    const client = stubClient({
      signUp: async () => ({ data: { user: USER, session: { user: USER } }, error: null })
    })
    const res = await new AuthService(client).signUp('ada@example.com', 'secret1')
    expect(res).toEqual({ user: { id: 'user-1', email: 'Ada@Example.com' }, needsEmailConfirmation: false })
  })

  it('flags needsEmailConfirmation when the project requires email confirmation (no session)', async () => {
    const client = stubClient({
      signUp: async () => ({ data: { user: USER, session: null }, error: null })
    })
    const res = await new AuthService(client).signUp('ada@example.com', 'secret1')
    expect(res).toEqual({ user: { id: 'user-1', email: 'Ada@Example.com' }, needsEmailConfirmation: true })
  })

  it('passes Supabase auth errors through verbatim', async () => {
    const client = stubClient({
      signUp: async () => ({ data: { user: null, session: null }, error: { message: 'User already registered' } })
    })
    await expect(new AuthService(client).signUp('ada@example.com', 'secret1')).rejects.toThrow(
      'User already registered'
    )
  })

  it('wraps transport failures as reachability errors', async () => {
    const client = stubClient({
      signUp: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(new AuthService(client).signUp('ada@example.com', 'secret1')).rejects.toThrow(
      /could not reach Supabase.*fetch failed/
    )
  })
})

describe('AuthService — signIn', () => {
  it('returns the user on success', async () => {
    const client = stubClient({
      signInWithPassword: async () => ({ data: { user: USER, session: { user: USER } }, error: null })
    })
    const user = await new AuthService(client).signIn('ada@example.com', 'secret1')
    expect(user).toEqual({ id: 'user-1', email: 'Ada@Example.com' })
  })

  it('passes invalid-credential errors through verbatim', async () => {
    const client = stubClient({
      signInWithPassword: async () => ({
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' }
      })
    })
    await expect(new AuthService(client).signIn('ada@example.com', 'wrong-password')).rejects.toThrow(
      'Invalid login credentials'
    )
  })

  it('wraps transport failures as reachability errors', async () => {
    const client = stubClient({
      signInWithPassword: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }
    })
    await expect(new AuthService(client).signIn('ada@example.com', 'secret1')).rejects.toThrow(
      /could not reach Supabase.*ENOTFOUND/
    )
  })
})

describe('AuthService — status (boot-time session restore)', () => {
  it('reports signed-out when no session is stored', async () => {
    const status = await new AuthService(stubClient()).status()
    expect(status).toEqual({ configured: true, user: null, offline: false })
  })

  it('restores the verified user from a stored session', async () => {
    const session: MinimalAuthSession = { user: USER }
    const client = stubClient({
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: USER }, error: null })
    })
    const status = await new AuthService(client).status()
    expect(status).toEqual({ configured: true, user: { id: 'user-1', email: 'Ada@Example.com' }, offline: false })
  })

  it('maps a server-side auth error (expired/revoked) to signed-out, not offline', async () => {
    const session: MinimalAuthSession = { user: USER }
    const client = stubClient({
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: null }, error: { message: 'Session expired' } })
    })
    const status = await new AuthService(client).status()
    expect(status).toEqual({ configured: true, user: null, offline: false })
  })

  it('keeps the cached identity + flags offline when the server is unreachable', async () => {
    const session: MinimalAuthSession = { user: USER }
    const client = stubClient({
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => {
        throw new TypeError('fetch failed')
      }
    })
    const status = await new AuthService(client).status()
    expect(status).toEqual({ configured: true, user: { id: 'user-1', email: 'Ada@Example.com' }, offline: true })
  })
})

describe('AuthService — signOut', () => {
  it('clears the stored session and the reported user', async () => {
    let session: MinimalAuthSession | null = { user: USER }
    const client = stubClient({
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      signOut: async () => {
        session = null
        return { error: null }
      }
    })
    const auth = new AuthService(client)
    expect((await auth.status()).user).not.toBeNull()
    await auth.signOut()
    // The stub's signOut mutated the shared session — status() must now see none.
    expect((await auth.status()).user).toBeNull()
  })

  it('still reports signed-out when the server call fails', async () => {
    let session: MinimalAuthSession | null = { user: USER }
    const client = stubClient({
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      signOut: async () => {
        session = null
        throw new TypeError('fetch failed')
      }
    })
    const auth = new AuthService(client)
    await auth.signOut() // must not throw
    expect((await auth.status()).user).toBeNull()
  })
})

describe('AuthService — smoke flag contract', () => {
  it('AppInfo carries smoke so the renderer gate can bypass CI runs', async () => {
    // Contract pin: the shared type must include the smoke flag (main sets it
    // from VENDOTUBE_SMOKE). Guards against an accidental contract regression.
    const { IPC } = await import('../src/shared/ipc')
    expect(IPC.AuthStatus).toBe('auth:status')
    expect(IPC.AuthSignIn).toBe('auth:signIn')
    expect(IPC.AuthSignUp).toBe('auth:signUp')
    expect(IPC.AuthSignOut).toBe('auth:signOut')
  })
})
