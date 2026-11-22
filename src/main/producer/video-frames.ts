import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Video footage baked into still frames (2026-11-18).
 *
 * The HyperFrames capture falls back to "screenshot" mode on this machine
 * (`HeadlessExperimental.beginFrame` probe fails), and a live <video> paints
 * black in that mode — downloaded clips reached the master as empty black
 * plates. A plain <img> does capture, so every video asset is extracted once
 * into a numbered JPEG sequence and played back by a GSAP frame driver; the
 * frames are real pixels at capture time on every render path.
 */

/** Playback cadence of a baked sequence (independent of the film fps). */
export const VIDEO_FRAME_FPS = 12

/** Longest edge of an extracted frame — the plate is at most ~1100 px wide. */
const FRAME_LONG_EDGE = 1280

/** A baked clip: a numbered JPEG sequence plus the window it plays. */
export interface BakedVideo {
  /** Directory name under `assets/` holding the frames. */
  dir: string
  /** Frame file names in playback order (relative to `assets/<dir>/`). */
  frames: string[]
  /** Seconds into the source clip where the played window starts. */
  offsetS: number
  /** Length of the played window in seconds (clamped to the source). */
  windowS: number
}

/** Probe a clip's duration in seconds; null when ffprobe cannot read it. */
export function videoDuration(file: string): number | null {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
      { encoding: 'utf-8', timeout: 60_000, windowsHide: true }
    )
    const d = Number(JSON.parse(out)?.format?.duration)
    return Number.isFinite(d) && d > 0 ? d : null
  } catch {
    return null
  }
}

/**
 * Extract `windowS` seconds of `source` starting at `offsetS` into `destDir`
 * as a numbered JPEG sequence. Returns the frame names in order, or null when
 * ffmpeg produced nothing (the caller falls back to a still plate).
 *
 * Cached on (mtime, size, offset, window) via a stamp file, so re-producing an
 * unchanged clip does not re-extract.
 */
export function bakeVideoFrames(
  source: string,
  destDir: string,
  offsetS: number,
  windowS: number
): string[] | null {
  const from = Math.max(0, Number.isFinite(offsetS) ? offsetS : 0)
  const span = Math.max(0.05, Number.isFinite(windowS) && windowS > 0 ? windowS : 1)
  try {
    const st = statSync(source)
    const stampPath = join(destDir, '.stamp')
    const stamp = `${st.mtimeMs}:${st.size}:${from.toFixed(3)}:${span.toFixed(3)}:${VIDEO_FRAME_FPS}`
    if (existsSync(stampPath)) {
      const have = listFrames(destDir)
      if (have.length > 0 && readFileSync(stampPath, 'utf-8') === stamp) return have
    }
    mkdirSync(destDir, { recursive: true })
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-ss', from.toFixed(3),
        '-t', span.toFixed(3),
        '-i', source,
        '-vf',
        `fps=${VIDEO_FRAME_FPS},scale=${FRAME_LONG_EDGE}:${FRAME_LONG_EDGE}:force_original_aspect_ratio=decrease`,
        '-q:v', '3',
        join(destDir, 'f%04d.jpg')
      ],
      { encoding: 'utf-8', timeout: 15 * 60_000, windowsHide: true }
    )
    const frames = listFrames(destDir)
    if (frames.length === 0) return null
    writeFileSync(stampPath, stamp)
    return frames
  } catch {
    return null
  }
}

function listFrames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^f\d+\.jpg$/.test(n))
      .sort()
  } catch {
    return []
  }
}

/**
 * GSAP statements that step one shot's baked frames across [startS, endS).
 * `selector` must resolve to a single shot (e.g. `.shot-4`).
 */
export function frameSequenceTweens(baked: BakedVideo, selector: string, startS: number, endS: number): string {
  const n = baked.frames.length
  if (n === 0) return ''
  const step = Math.max(0.05, endS - startS) / n
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const t = (startS + i * step).toFixed(4)
    const keep = `${selector} .kvf-${i}`
    const drop = Array.from({ length: n }, (_, j) => (j === i ? null : `${selector} .kvf-${j}`))
      .filter((s): s is string => Boolean(s))
      .join(', ')
    lines.push(`      tl.set('${keep}', { display: 'block' }, ${t});`)
    lines.push(`      tl.set('${drop}', { display: 'none' }, ${t});`)
  }
  return lines.join('\n')
}

/** Stacked frame images for one shot: only the first is visible by default. */
export function frameSequenceHtml(baked: BakedVideo, imgStyle: string): string {
  return baked.frames
    .map(
      (f, i) =>
        `<img class="kvf kvf-${i}" src="assets/${baked.dir}/${f}" alt="" style="${imgStyle};display:${i === 0 ? 'block' : 'none'}">`
    )
    .join('')
}