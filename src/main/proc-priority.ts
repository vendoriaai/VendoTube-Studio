import { spawn } from 'node:child_process'

/**
 * Background priority for render-side child process trees (2026-11-16):
 * hyperframes' built-in ffmpeg encodes with `-threads` = every logical core
 * and the bridge runs full-decode ffmpeg passes — both at Normal priority,
 * which starves the user's own apps while a film renders. Windows children
 * inherit the parent's priority class when the parent is BELOW_NORMAL
 * (documented CreateProcess behavior), so lowering the one spawned root
 * (python bridge / the `cmd /c npx` shell) covers the whole tree without
 * touching DWK or the hyperframes package.
 */

export type RenderPriority = 'low' | 'normal'

/** PowerShell script is a CONSTANT — the target pid rides in via env var
 * and is `[int]`-cast before use (defense-in-depth: no runtime value is ever
 * interpolated into the command text). `$pid` is a reserved automatic
 * variable in PowerShell, hence the `$t` name. */
const BELOW_NORMAL_SCRIPT = "$t=[int]$env:VENDOTUBE_PID; (Get-Process -Id $t).PriorityClass='BelowNormal'"

/**
 * Pure command builder (unit-tested): how to drop a pid to background
 * priority. Returns null when the pid is unusable. `platform` is injectable
 * so tests can pin both branches. Every command is spawned as an argv list
 * with shell:false; no shell string is ever assembled.
 */
export function priorityArgs(
  pid: number,
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[]; env?: Record<string, string> } | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', BELOW_NORMAL_SCRIPT],
      env: { VENDOTUBE_PID: String(pid) }
    }
  }
  return { cmd: 'renice', args: ['-n', '10', '-p', String(pid)] }
}

/**
 * Fire-and-forget priority drop. All failures are swallowed — if PowerShell is
 * missing or the process already exited, the render simply continues at Normal
 * priority. Never awaited: this one-shot must not stall the render pipeline.
 */
export function lowerProcessPriority(pid: number | undefined): void {
  if (pid === undefined) return
  const spec = priorityArgs(pid)
  if (!spec) return
  try {
    const child = spawn(spec.cmd, spec.args, {
      // Keep the parent env (PowerShell needs SystemRoot etc. to start) and
      // add the pid channel for the constant script above.
      env: { ...process.env, ...spec.env },
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', () => undefined)
  } catch {
    // best-effort — priority is an optimization, never a render blocker
  }
}
