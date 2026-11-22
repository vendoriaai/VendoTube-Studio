import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

/** Aurora Studio primitives (UI-UX-SPEC §2.3, §8). Classname joiner first. */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ------------------------------------------------------------------ Button

type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger'

export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-input px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed'
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-white hover:opacity-90',
    ghost: 'text-ink hover:bg-surface-2',
    subtle: 'bg-surface-2 text-ink hover:bg-accent-soft',
    danger: 'bg-danger text-white hover:opacity-90'
  }
  return (
    <button className={cn(base, styles[variant], className)} {...rest}>
      {children}
    </button>
  )
}

// -------------------------------------------------------------------- Card

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-surface shadow-[0_2px_12px_rgb(4_8_16/0.35)]',
        className
      )}
    >
      {children}
    </div>
  )
}

// -------------------------------------------------------------------- Chip

export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted', className)}>
      {children}
    </span>
  )
}

// ------------------------------------------------------------------- Badge

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const TONE_STYLES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-signal/10 text-signal',
  warn: 'bg-warm/10 text-warm',
  danger: 'bg-danger/10 text-danger'
}

export function Badge({
  tone = 'neutral',
  className,
  children,
  title
}: {
  tone?: Tone
  className?: string
  children: ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', TONE_STYLES[tone], className)}
    >
      {children}
    </span>
  )
}

// --------------------------------------------------------------- StatusDot

export function StatusDot({
  tone = 'idle',
  pulse = false,
  className
}: {
  tone?: 'ok' | 'warn' | 'err' | 'idle' | 'muted'
  pulse?: boolean
  className?: string
}) {
  const colors: Record<string, string> = {
    ok: 'bg-signal',
    warn: 'bg-warm',
    err: 'bg-danger',
    idle: 'bg-accent',
    muted: 'bg-ink-muted/40'
  }
  return (
    <span className={cn('relative inline-flex h-2 w-2', className)}>
      <span className={cn('absolute inset-0 rounded-full', colors[tone], pulse && 'animate-pulse')} />
    </span>
  )
}

// ------------------------------------------------------------- ProgressBar

export function ProgressBar({ pct, indeterminate = false }: { pct?: number; indeterminate?: boolean }) {
  const value = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : undefined
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={value}>
      <div
        className={cn('h-full rounded-full bg-accent transition-all duration-200', indeterminate && 'animate-pulse w-1/3')}
        style={indeterminate ? undefined : { width: `${value ?? 0}%` }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ inputs

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span> : null}
    </label>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-input border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted/60 focus:border-accent focus:outline-none',
        className
      )}
      {...rest}
    />
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-none',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

// -------------------------------------------------------------------- misc

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent', className)}
      aria-label="loading"
    />
  )
}

export function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('font-mono text-[12px]', className)}>{children}</span>
}
