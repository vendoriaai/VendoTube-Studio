import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bakeVideoFrames, frameSequenceHtml, frameSequenceTweens } from '../src/main/producer/video-frames'

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8', windowsHide: true }).status === 0

function testClip(dir: string): string {
  const file = join(dir, 'clip.mp4')
  spawnSync(
    'ffmpeg',
    ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12', '-pix_fmt', 'yuv420p', file],
    { encoding: 'utf-8', windowsHide: true }
  )
  return file
}

describe('bakeVideoFrames', () => {
  // Footage must survive the capture path as still frames: a live <video>
  // renders black when HyperFrames falls back to screenshot capture, so the
  // master showed empty plates where downloaded clips belonged (2026-11-18).
  it.skipIf(!ffmpegAvailable)('extracts a numbered JPEG sequence for the played window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-bake-'))
    const clip = testClip(dir)
    const seqDir = join(dir, 'assets', 'seq_clip')
    const frames = bakeVideoFrames(clip, seqDir, 0, 1.5)

    expect(frames).not.toBeNull()
    expect(frames!.length).toBeGreaterThan(1)
    expect(frames![0]).toMatch(/^f\d+\.jpg$/)
    expect(existsSync(join(seqDir, frames![0]))).toBe(true)
    // frames are real pixels, not zero-byte placeholders
    expect(frames!.every((f) => existsSync(join(seqDir, f)))).toBe(true)
  })

  it.skipIf(!ffmpegAvailable)('reuses the cached sequence for an unchanged window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-bake-cache-'))
    const clip = testClip(dir)
    const seqDir = join(dir, 'seq')
    const first = bakeVideoFrames(clip, seqDir, 0, 1)
    const second = bakeVideoFrames(clip, seqDir, 0, 1)
    expect(second).toEqual(first)
  })

  it('returns null for an unreadable source instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-bake-bad-'))
    expect(bakeVideoFrames(join(dir, 'missing.mp4'), join(dir, 'seq'), 0, 1)).toBeNull()
  })
})

describe('frame sequences in the composition', () => {
  it('stacks frames with only the first visible', () => {
    const html = frameSequenceHtml(
      { dir: 'seq_S01_clip', frames: ['f0001.jpg', 'f0002.jpg'], offsetS: 0, windowS: 2 },
      'position:absolute;inset:0'
    )
    expect(html).toContain('class="kvf kvf-0" src="assets/seq_S01_clip/f0001.jpg"')
    expect(html).toContain('display:block')
    expect(html).toContain('class="kvf kvf-1"')
    expect(html).toContain('display:none')
    // never a live <video> — that is the element that captured black
    expect(html).not.toContain('<video')
  })

  it('steps every frame once across the shot window', () => {
    const tweens = frameSequenceTweens({ dir: 'd', frames: ['f0001.jpg', 'f0002.jpg', 'f0003.jpg'], offsetS: 0, windowS: 3 }, '.shot-4', 10, 13)
    for (let i = 0; i < 3; i++) {
      expect(tweens).toContain(`tl.set('.shot-4 .kvf-${i}', { display: 'block' }, ${(10 + i).toFixed(4)});`)
    }
    expect(tweens).toContain(`tl.set('.shot-4 .kvf-0, .shot-4 .kvf-1', { display: 'none' }, 12.0000);`)
  })

  it('emits nothing for an empty sequence', () => {
    expect(frameSequenceTweens({ dir: 'd', frames: [], offsetS: 0, windowS: 1 }, '.shot-0', 0, 1)).toBe('')
    expect(frameSequenceHtml({ dir: 'd', frames: [], offsetS: 0, windowS: 1 }, '')).toBe('')
  })
})
