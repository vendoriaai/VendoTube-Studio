import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCompositions, type WorkflowJson } from '../src/main/producer/compositions'

/**
 * The composition emitter must produce lint-clean HyperFrames HTML — the
 * pipeline hard-fails produce on `hyperframes lint` exit != 0. Regression
 * (dogfood 2026-11-14): the beat zoom punch tweened scale on .kb-i (a SECOND
 * writer overlapping the Ken Burns tween, with a RELATIVE += value — seek
 * paths diverge) and <video> b-roll shipped without data-start/id.
 *
 * Fixed: punch targets the shot layer (single writer for its scale) and video
 * layers carry id + data-start="0" + data-duration=<shot>. Skips when ffmpeg
 * or hyperframes are unavailable (they are PATH/dev dependencies here).
 */

const workflow: WorkflowJson = {
  version: 1,
  render: { resolution: [1920, 1080], fps: 24, quality: 'standard' },
  scenes: [
    {
      id: 'S1',
      vo: { script_section: 'sec1', voice: 'en-US-AndrewMultilingualNeural' },
      shots: [
        { kind: 'composition', template: 'title-card', text: 'Opening', dur_s: 5 },
        { kind: 'asset', asset: 'media/video/clip.mp4', motion: 'kenburns', zoom: 1.08, dur_s: 5 }
      ],
      transitions: { in: 'fade', out: 'crossfade' },
      claims: []
    },
    {
      id: 'S2',
      vo: { script_section: 'sec2', voice: 'en-US-AndrewMultilingualNeural' },
      shots: [
        { kind: 'asset', asset: 'media/video/clip.mp4', motion: 'kenburns', zoom: 1.08, dur_s: 5 },
        {
          kind: 'composition',
          template: 'data-bars',
          text: 'Stats',
          dur_s: 5,
          data: { kind: 'bars', title: 'Stats', items: [{ label: 'Alpha', value: 8 }, { label: 'Beta', value: 4 }] }
        }
      ],
      transitions: { in: 'crossfade', out: 'fade' },
      claims: []
    }
  ]
}

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { shell: true, encoding: 'utf-8' }).status === 0
const hyperframesAvailable = spawnSync('npx', ['hyperframes', '--version'], { shell: true, encoding: 'utf-8' }).status === 0

describe.skipIf(!ffmpegAvailable || !hyperframesAvailable)('composition emitter → hyperframes lint', () => {
  it(
    'lint exits 0 with beat zoom punch + timed video layer',
    { timeout: 180_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vt-lint-probe-'))
      try {
        mkdirSync(join(dir, 'media', 'video'), { recursive: true })
        const ff = spawnSync(
          'ffmpeg',
          ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12', '-pix_fmt', 'yuv420p', 'clip.mp4'],
          { shell: true, encoding: 'utf-8', cwd: join(dir, 'media', 'video') }
        )
        expect(ff.status, `ffmpeg probe clip failed: ${ff.stderr?.slice(-300)}`).toBe(0)

        const beats = [
          { id: 'b1', scene: 'S1', label: 'pivot', startS: 2, rehook: true, patternInterrupt: 'hold this thought' },
          { id: 'b2', scene: 'S2', label: 'hook', startS: 12, rehook: false, patternInterrupt: 'interrupt' }
        ]
        const built = buildCompositions({
          projectPath: dir,
          workflow,
          voDurations: { sec1: 10, sec2: 10 },
          stylePreset: 'aurora',
          projectTitle: 'Lint Probe',
          beats
        })

        const s2 = readFileSync(join(built.dir, 'compositions', 'scene-S2.html'), 'utf-8')
        // footage is baked into a frame sequence, stepped by the shot's other timeline
        expect(s2).not.toContain('<video')
        expect(s2).toContain('class="kvf kvf-0"')
        expect(s2).toMatch(/tl\.set\('\.shot-0 \.kvf-0', \{ display: 'block' \}/)
        // punch moved to the single-writer shot layer (gsap_relative_value_second_writer)
        expect(s2).toMatch(/tl\.to\('\.shot-0', \{ scale: '\+=0\.05'/)
        expect(s2).not.toMatch(/tl\.to\('\.kb-\d+', \{ scale/)

        const lint = spawnSync('npx', ['hyperframes', 'lint', built.dir], {
          shell: true,
          encoding: 'utf-8',
          cwd: process.cwd()
        })
        if (lint.status !== 0) {
          console.error('LINT FAIL OUTPUT:\n' + ((lint.stdout ?? '') + (lint.stderr ?? '')).slice(-3000))
        }
        expect(lint.status).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
