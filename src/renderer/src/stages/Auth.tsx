import { useState } from 'react'
import { api } from '../lib/api'
import { useStudio } from '../state/store'
import { Button, Card, Field, Input, Spinner, cn } from '../components/ui'
import logoMark from '../assets/logo-mark.png'

/**
 * Sign-in gate (Supabase, vendoria.ai project). App.tsx renders this instead
 * of the whole shell until a session exists (smoke runs bypass it via
 * AppInfo.smoke). Three states:
 *   1. not configured    — instructions to paste the URL/anon key
 *   2. offline w/ session — "can't verify your session" + retry
 *   3. otherwise          — sign in / create account form
 */

type Mode = 'signin' | 'signup'

export function Auth() {
  const { authConfigured, authOffline, authUser, setAuthUser, setAuthOffline } = useStudio()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmNote, setConfirmNote] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signup') {
        const res = await api.authSignUp(email.trim(), password)
        if (res.needsEmailConfirmation) {
          setConfirmNote(`Account created — check ${email.trim()} for a confirmation link, then sign in here.`)
          setMode('signin')
        } else if (res.user) {
          setAuthUser(res.user)
        } else {
          setConfirmNote('Account created — sign in to continue.')
          setMode('signin')
        }
      } else {
        const user = await api.authSignIn(email.trim(), password)
        setAuthUser(user)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const retryStatus = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const status = await api.authStatus()
      setAuthUser(status.user)
      setAuthOffline(status.offline)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // ---- 1. not configured -------------------------------------------------
  if (authConfigured === false) {
    return (
      <GateFrame>
        <Card className="w-full max-w-md p-6">
          <h1 className="mb-2 font-display text-[17px] font-semibold">Account service not configured</h1>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            VendoTube Studio needs the Supabase project details for <span className="text-ink">vendoria.ai</span> before
            sign-in is available.
          </p>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-muted">
            <li>Open the Supabase Dashboard → Project Settings → API.</li>
            <li>
              Paste the <span className="text-ink">Project URL</span> and <span className="text-ink">anon key</span> into{' '}
              <code className="font-mono text-[11.5px] text-accent">src/main/supabase-config.ts</code>.
            </li>
            <li>Restart the app.</li>
          </ol>
          <p className="text-[11px] text-ink-muted/70">
            The anon key is the publishable client key — never paste the service_role key into the app.
          </p>
        </Card>
      </GateFrame>
    )
  }

  // ---- 2. offline with a stored session ----------------------------------
  if (authOffline && authUser) {
    return (
      <GateFrame>
        <Card className="w-full max-w-md p-6 text-center">
          <img src={logoMark} alt="" className="mx-auto mb-3 h-12 w-12 opacity-80" draggable={false} />
          <h1 className="mb-1 font-display text-[17px] font-semibold">Can't verify your session</h1>
          <p className="mb-4 text-[13px] text-ink-muted">
            You're signed in as <span className="text-ink">{authUser.email}</span>, but the account service isn't
            reachable right now.
          </p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => void retryStatus()} disabled={busy}>
              {busy ? <Spinner /> : null} Retry
            </Button>
            <Button variant="ghost" onClick={() => setAuthUser(null)}>
              Use another account
            </Button>
          </div>
          {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}
        </Card>
      </GateFrame>
    )
  }

  // ---- 3. the form --------------------------------------------------------
  const signup = mode === 'signup'
  return (
    <GateFrame>
      <Card className="w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-2">
          <img src={logoMark} alt="" className="h-12 w-12 opacity-90" draggable={false} />
          <h1 className="font-display text-[17px] font-semibold tracking-wide">VENDOTUBE STUDIO</h1>
          <p className="text-[12px] text-ink-muted">
            {signup ? 'Create your account' : 'Sign in to your account'}
          </p>
        </div>

        <div className="mb-4 grid grid-cols-2 rounded-input border border-line bg-surface-2 p-0.5">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              className={cn(
                'rounded-[calc(var(--radius-input)-2px)] py-1.5 text-[12.5px] font-medium transition-colors',
                mode === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'
              )}
              onClick={() => {
                setMode(m)
                setError(null)
                setConfirmNote(null)
              }}
            >
              {m === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Email">
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 6 characters"
              required
              minLength={6}
            />
          </Field>
          {error ? <p className="text-[12px] text-danger">{error}</p> : null}
          {confirmNote ? <p className="text-[12px] text-signal">{confirmNote}</p> : null}
          <Button type="submit" className="w-full" disabled={busy || !email.trim() || password.length < 6}>
            {busy ? <Spinner /> : null} {signup ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        {authOffline && !authUser ? (
          <p className="mt-3 text-[11px] text-warm">
            The account service was unreachable at startup — sign-in will retry against it now.
          </p>
        ) : null}
        <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-muted/70">
          Accounts are managed by Supabase for the vendoria.ai project. Your films stay on this machine.
        </p>
      </Card>
    </GateFrame>
  )
}

/** Shared full-screen backdrop for every gate state. */
function GateFrame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6">{children}</div>
}
