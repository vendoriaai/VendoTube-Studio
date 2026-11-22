import { describe, expect, it } from 'vitest'
import { changedNarrationSections, narrationStamps } from '../src/main/producer/pipeline'

/**
 * Script-content guard (the dogfood incident): a re-direct rewrote script.md
 * under the SAME section ids — tts:<id> done-markers keyed by id alone would
 * have silently narrated the old words. Stamps catch the change; the diff
 * names exactly which sections re-narrate.
 */

const secs = (id: string, body: string) => ({ id, title: 't', body })

describe('narration script-content guard', () => {
  it('stamps are stable for identical content and distinct for any narratable change', () => {
    const a = narrationStamps([secs('S01', 'One prompt. Three worlds.')], 'v', { S01: 1.0 })
    const b = narrationStamps([secs('S01', 'One prompt. Three worlds.')], 'v', { S01: 1.0 })
    expect(a.S01).toBe(b.S01)

    const editBody = narrationStamps([secs('S01', 'One prompt. Three universes.')], 'v', { S01: 1.0 })
    const editPace = narrationStamps([secs('S01', 'One prompt. Three worlds.')], 'v', { S01: 1.1 })
    const editVoice = narrationStamps([secs('S01', 'One prompt. Three worlds.')], 'v2', { S01: 1.0 })
    expect(editBody.S01).not.toBe(a.S01)
    expect(editPace.S01).not.toBe(a.S01)
    expect(editVoice.S01).not.toBe(a.S01)
  })

  it('flags only sections whose done tts marker has a changed (or missing) stamp', () => {
    const stamps = narrationStamps([secs('S01', 'old words'), secs('S02', 'also old')], 'v', {})
    const done = new Set(['tts:S01', 'tts:S02', 'subtitles'])
    expect(changedNarrationSections(stamps, stamps, ['S01', 'S02'], done)).toEqual([])

    const rewritten = narrationStamps([secs('S01', 'old words'), secs('S02', 'NEW words')], 'v', {})
    expect(changedNarrationSections(stamps, rewritten, ['S01', 'S02'], done)).toEqual(['S02'])
  })

  it('a pre-stamp ledger (state written before the guard existed) re-narrates once, honestly', () => {
    const stamps = narrationStamps([secs('hook', 'whatever the script says now')], 'v', {})
    const done = new Set(['tts:hook'])
    // prev undefined — cannot prove the audio matches the script → re-narrate
    expect(changedNarrationSections(undefined, stamps, ['hook'], done)).toEqual(['hook'])
  })

  it('sections with no tts marker yet are left out (first run needs no invalidation)', () => {
    const stamps = narrationStamps([secs('hook', 'fresh script')], 'v', {})
    expect(changedNarrationSections({}, stamps, ['hook'], new Set())).toEqual([])
  })

  it('stamps use the raw section body — non-spoken edits re-narrate too (cheap: content-hash TTS cache)', () => {
    const body = '> cut to: data card\nOne prompt. Three worlds. (CLM-0001)'
    const withExtras = narrationStamps([secs('S01', body)], 'v', {})
    const spokenOnly = narrationStamps([secs('S01', 'One prompt. Three worlds.')], 'v', {})
    expect(withExtras.S01).not.toBe(spokenOnly.S01)
  })
})
