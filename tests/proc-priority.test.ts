import { describe, expect, it } from 'vitest'
import { priorityArgs } from '../src/main/proc-priority'

/** Render performance (2026-11-16): background-priority command builder. */

describe('priorityArgs', () => {
  it('win32: constant PowerShell script — the pid rides via env, never interpolated into the command text', () => {
    const spec = priorityArgs(4242, 'win32')
    expect(spec).not.toBeNull()
    expect(spec?.cmd).toBe('powershell')
    expect(spec?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$t=[int]$env:VENDOTUBE_PID; (Get-Process -Id $t).PriorityClass='BelowNormal'"
    ])
    expect(spec?.env?.VENDOTUBE_PID).toBe('4242')
    // Injection hardening invariant: no runtime value appears in the command text.
    for (const arg of spec?.args ?? []) expect(arg).not.toContain('4242')
  })

  it('posix: renice as a plain argument list (no shell string)', () => {
    expect(priorityArgs(99, 'linux')).toEqual({ cmd: 'renice', args: ['-n', '10', '-p', '99'] })
    expect(priorityArgs(123, 'darwin')).toEqual({ cmd: 'renice', args: ['-n', '10', '-p', '123'] })
  })

  it('refuses unusable pids', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(priorityArgs(bad, 'win32')).toBeNull()
      expect(priorityArgs(bad, 'linux')).toBeNull()
    }
  })
})
