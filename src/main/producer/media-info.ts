import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Intrinsic media facts the emitter needs to frame imagery professionally
 * (2026-11-16 media-treatment pass). No image library: JPEG/PNG/GIF/WebP
 * headers are parsed from the first bytes of the file. Unknown formats return
 * null and the emitter falls back to its landscape frame.
 */

export interface MediaSize {
  width: number
  height: number
}

const HEAD_BYTES = 512 * 1024

/** Read the intrinsic pixel size of an image, or null when it cannot be read. */
export function imageSize(file: string): MediaSize | null {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size < 24) return null
    const len = Math.min(st.size, HEAD_BYTES)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, 0)
    } finally {
      closeSync(fd)
    }
    return parseImageSize(buf)
  } catch {
    return null
  }
}

/** Pure header parser (exported for tests). */
export function parseImageSize(b: Buffer): MediaSize | null {
  if (!b || b.length < 24) return null

  // PNG: signature + IHDR width/height (big-endian at 16/20).
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const width = b.readUInt32BE(16)
    const height = b.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // GIF: logical screen descriptor (little-endian at 6/8).
  if (b.toString('ascii', 0, 3) === 'GIF') {
    const width = b.readUInt16LE(6)
    const height = b.readUInt16LE(8)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // JPEG: walk markers until the first SOF (which carries h/w).
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const segLen = b.readUInt16BE(i + 2)
      if (segLen < 2) return null
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = b.readUInt16BE(i + 5)
        const width = b.readUInt16BE(i + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      i += 2 + segLen
    }
    return null
  }

  // WebP: RIFF container, first chunk VP8X / VP8 / VP8L.
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16)
    if (kind === 'VP8X' && b.length >= 30) {
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
      return { width, height }
    }
    if (kind === 'VP8 ' && b.length >= 30) {
      if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null
      const width = b.readUInt16LE(26) & 0x3fff
      const height = b.readUInt16LE(28) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (kind === 'VP8L' && b.length >= 25) {
      if (b[20] !== 0x2f) return null
      const bits = b.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
  }

  return null
}

/** Is this a Scout page screenshot (`media/screenshots/...`)? */
export function isScreenshotPath(path: string): boolean {
  return /(^|\/)screenshots\//i.test(String(path ?? '').replace(/\\/g, '/'))
}

/** A page plate is a Scout screenshot OR any extremely tall image (a page/scan
 *  saved under media/web/) — those must not be shrunk into a portrait strip. */
export function isPagePlate(path: string, size: MediaSize | null): boolean {
  return isScreenshotPath(path) || Boolean(size && size.height >= size.width * 2.2)
}

/** Human host for a screenshot's browser chrome, derived from its file name
 *  (`en.wikipedia.org_John_Grierson_1794.jpg` → `en.wikipedia.org`). */
export function screenshotHost(path: string): string {
  const base = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? ''
  const head = base.split('_')[0]
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(head) ? head : ''
}

/** Frame geometry for an image inside the design canvas. */
export interface ImageFrame {
  width: number
  height: number
  /** contain = whole image visible; cover-top = page screenshot cropped from the top. */
  fit: 'contain' | 'cover-top'
}

/**
 * Adaptive exhibit frame: portrait/square sources get a plate whose aspect
 * matches the picture (a 900×1400 portrait in a 1240×700 landscape frame used
 * to shrink to a 200 px sliver with giant blur bars); tall page screenshots
 * become a full-width browser plate cropped from the top.
 */
export function imageFrame(size: MediaSize | null, designWidth: number): ImageFrame | null {
  if (!size || size.width <= 0 || size.height <= 0) return null
  // Small sources (logos, icons, low-res scans) get a plate near their own
  // size instead of being upscaled into a giant blurry exhibit.
  const maxDim = Math.max(size.width, size.height)
  if (maxDim < 600) {
    const k = Math.min(1.6, 600 / maxDim)
    return { width: Math.round(size.width * k), height: Math.round(size.height * k), fit: 'contain' }
  }
  const aspect = size.width / size.height
  // Wide/landscape pictures keep the skin's own frame geometry (their aspect
  // is close to the design frame); portrait, square and 4:3 sources get a
  // plate that matches the picture instead of a letterboxed landscape frame.
  if (aspect >= 1.65) return null
  const scale = Math.min(1, Math.max(0.45, designWidth / 1920))
  const maxW = Math.round(950 * scale)
  const maxH = Math.round(700 * scale)
  let height = maxH
  let width = Math.round(height * aspect)
  if (width > maxW) {
    width = maxW
    height = Math.round(width / aspect)
  }
  return { width, height, fit: 'contain' }
}

/** Screen-plate geometry for a page screenshot. */
export function screenshotFrame(size: MediaSize | null, designWidth: number): ImageFrame {
  const width = Math.round(Math.min(1180, Math.max(520, designWidth - 400)))
  const height = Math.round(width * 0.593)
  // A full-page capture is TALLER than it is wide: show the top at full width
  // (cover-top). A normal viewport-shaped capture keeps the whole page visible.
  const tall = size ? size.height >= size.width * 1.15 : false
  return { width, height, fit: tall ? 'cover-top' : 'contain' }
}