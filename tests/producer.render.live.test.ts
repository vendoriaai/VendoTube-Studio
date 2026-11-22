import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCompositions, type WorkflowJson, type CompositionScene } from '../src/main/producer/compositions'

/**
 * M3 render spike (live, gated): builds a small composition project, lints
 * it with the HyperFrames CLI, and renders a draft picture master. Skipped
 * unless VENDOTUBE_RENDER_SPIKE=1 — it launches Chrome and takes minutes.
 * This is the ROADMAP M3 risk check: "HyperFrames render perf at 1080p60".
 */

const GATED = process.env.VENDOTUBE_RENDER_SPIKE === '1'
const d = it

describe.skipIf(!GATED)('render spike (VENDOTUBE_RENDER_SPIKE=1)', () => {
  d('9:16 evaluation probe (TAD §15.2): vertical render via the same templates', () => {
    const projectPath = join(tmpdir(), `vf-916-${Date.now()}`)
    mkdirSync(join(projectPath, 'media', 'images'), { recursive: true })
    const img = join(projectPath, 'media', 'images', 'still.jpg')
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:duration=1:rate=30', '-frames:v', '1', img])

    const scene = (id: string, section: string, shots: CompositionScene['shots'], transitions = { in: 'fade', out: 'crossfade' }): CompositionScene => ({
      id,
      vo: { script_section: section, voice: 'en-US-AndrewMultilingualNeural' },
      shots,
      transitions,
      claims: []
    })
    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1080, 1920], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'Vertical Probe', dur_s: 3 }]),
        scene('S02', 's01', [{ kind: 'asset', asset: 'media/images/still.jpg', motion: 'kenburns', zoom: 1.08, dur_s: 3 }], { in: 'crossfade', out: 'crossfade' }),
        scene('S03', 's02', [{ kind: 'composition', template: 'end-card', text: '9:16 works', dur_s: 3 }], { in: 'fade', out: 'fade' })
      ]
    }
    const built = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 3.0, s01: 3.0, s02: 3.0 },
      stylePreset: 'vox-explainer',
      projectTitle: '9:16 probe'
    })
    const out = join(projectPath, 'delivery', 'picture-916.mp4')
    mkdirSync(join(projectPath, 'delivery'), { recursive: true })
    execFileSync('npx', ['hyperframes', 'render', built.dir, '--quality', 'draft', '--fps', '30', '--format', 'mp4', '--output', out], {
      encoding: 'utf-8',
      timeout: 540_000,
      shell: true
    })
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', out], { encoding: 'utf-8' })
    )
    const v = probe.streams?.[0] ?? {}
    console.log('[916-probe]', JSON.stringify({ w: v.width, h: v.height }))
    expect(Number(v.width)).toBe(1080)
    expect(Number(v.height)).toBe(1920)
    // frame snapshot for the visual verdict
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', out, '-ss', '1.5', '-frames:v', '1', `${projectPath}/frame916.png`])
    console.log('[916-probe] frame at', `${projectPath}/frame916.png`)
  }, 600_000)

  d('lints and renders a 3-scene composition to a picture master', () => {
    const projectPath = join(tmpdir(), `vf-spike-${Date.now()}`)
    mkdirSync(join(projectPath, 'media', 'images'), { recursive: true })

    // Synthetic still: 1920x1080 SMPTE-ish gradient card with text.
    const img = join(projectPath, 'media', 'images', 'still.jpg')
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=1:rate=30',
      '-frames:v', '1', img
    ])
    expect(existsSync(img)).toBe(true)

    const scene = (id: string, section: string, shots: CompositionScene['shots'], transitions = { in: 'fade', out: 'crossfade' }): CompositionScene => ({
      id,
      vo: { script_section: section, voice: 'en-US-AndrewMultilingualNeural' },
      shots,
      transitions,
      claims: []
    })

    const workflow: WorkflowJson = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        scene('S01', 'hook', [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The Render Spike', dur_s: 4 }]),
        scene('S02', 's01', [
          { kind: 'asset', asset: 'media/images/still.jpg', motion: 'kenburns', zoom: 1.08, dur_s: 3 },
          { kind: 'composition', template: 'lower-third', text: 'Spike Scene', dur_s: 1.5 }
        ], { in: 'crossfade', out: 'crossfade' }),
        scene('S03', 's02', [{ kind: 'composition', template: 'end-card', text: 'Rendered by VendoTube Studio', dur_s: 4 }], { in: 'fade', out: 'fade' })
      ]
    }
    const built = buildCompositions({
      projectPath,
      workflow,
      voDurations: { hook: 4.0, s01: 4.5, s02: 4.0 },
      stylePreset: 'vox-explainer',
      projectTitle: 'Render Spike'
    })
    expect(built.sceneTimings).toHaveLength(3)

    // Lint first (HyperFrames discipline: lint before render).
    const lint = execFileSync('npx', ['hyperframes', 'lint', built.dir], { encoding: 'utf-8', timeout: 120_000, shell: true })
    console.log('[spike] lint:', lint.split('\n').slice(-6).join('\n'))
    expect(lint).not.toMatch(/\berror\b:/i)

    const out = join(projectPath, 'delivery', 'picture.mp4')
    mkdirSync(join(projectPath, 'delivery'), { recursive: true })
    const render = execFileSync(
      'npx',
      ['hyperframes', 'render', built.dir, '--quality', 'draft', '--fps', '30', '--format', 'mp4', '--output', out],
      { encoding: 'utf-8', timeout: 540_000, shell: true }
    )
    console.log('[spike] render tail:', render.split('\n').slice(-8).join('\n'))

    expect(existsSync(out)).toBe(true)
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', out], { encoding: 'utf-8' })
    )
    const v = probe.streams?.[0] ?? {}
    console.log('[spike] picture master:', JSON.stringify({ duration: probe.format?.duration, size: probe.format?.size, w: v.width, h: v.height, fps: v.avg_frame_rate }))
    expect(Number(probe.format?.duration ?? 0)).toBeGreaterThan(built.totalDurationS - 1.5)
    expect(Number(probe.format?.duration ?? 0)).toBeLessThan(built.totalDurationS + 1.5)
    expect(statSync(out).size).toBeGreaterThan(100_000)
  }, 600_000)
})
