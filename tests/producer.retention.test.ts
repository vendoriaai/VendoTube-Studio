import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRetentionConfig } from '../src/main/producer/pipeline'

/**
 * Retention config (craft pass): hook_seconds was documented in DATA-SCHEMA
 * §2.1 but never read — it now feeds the producer report's hook entry and the
 * Director-side hook advisory. Everything else keeps its M3 defaults.
 */

describe('readRetentionConfig', () => {
  it('defaults to the documented M3 targets plus a 15s hook window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-retention-'))
    expect(readRetentionConfig(dir)).toEqual({ cpsMax: 17, maxDeadZoneS: 8, lufsTarget: -14, varianceMax: 0.6, hookSeconds: 15 })
  })

  it('reads hook_seconds from project.yml retention block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-retention-'))
    writeFileSync(
      join(dir, 'project.yml'),
      ['title: X', 'retention:', '  cps_max: 15', '  hook_seconds: 12', '  lufs: -16', ''].join('\n'),
      'utf-8'
    )
    const cfg = readRetentionConfig(dir)
    expect(cfg.hookSeconds).toBe(12)
    expect(cfg.cpsMax).toBe(15)
    expect(cfg.lufsTarget).toBe(-16)
    expect(cfg.maxDeadZoneS).toBe(8) // unset → default
  })
})
