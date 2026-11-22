import { describe, expect, it } from 'vitest'
import { imageFrame, isPagePlate, isScreenshotPath, parseImageSize, screenshotFrame, screenshotHost } from '../src/main/producer/media-info'

/** Byte-level header parsers must be exact — they decide how media is framed. */
describe('image header parsing', () => {
  it('reads a PNG IHDR', () => {
    const b = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(900, 16)
    b.writeUInt32BE(1400, 20)
    expect(parseImageSize(b)).toEqual({ width: 900, height: 1400 })
  })

  it('reads a GIF logical screen', () => {
    const b = Buffer.alloc(24)
    Buffer.from('GIF89a', 'ascii').copy(b, 0)
    b.writeUInt16LE(640, 6)
    b.writeUInt16LE(480, 8)
    expect(parseImageSize(b)).toEqual({ width: 640, height: 480 })
  })

  it('reads a JPEG SOF segment', () => {
    // SOI, APP0 (empty), SOF0 with height 720 / width 1280.
    const b = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      0x00, 0x00
    ])
    expect(parseImageSize(b)).toEqual({ width: 1280, height: 720 })
  })

  it('reads a WebP VP8X canvas', () => {
    const b = Buffer.alloc(30)
    Buffer.from('RIFF', 'ascii').copy(b, 0)
    b.writeUInt32LE(22, 4)
    Buffer.from('WEBP', 'ascii').copy(b, 8)
    Buffer.from('VP8X', 'ascii').copy(b, 12)
    b.writeUInt32LE(10, 16)
    const w = 1200 - 1
    const h = 3600 - 1
    b[24] = w & 0xff
    b[25] = (w >> 8) & 0xff
    b[26] = (w >> 16) & 0xff
    b[27] = h & 0xff
    b[28] = (h >> 8) & 0xff
    b[29] = (h >> 16) & 0xff
    expect(parseImageSize(b)).toEqual({ width: 1200, height: 3600 })
  })

  it('returns null for unknown bytes', () => {
    expect(parseImageSize(Buffer.from('not an image at all, really'))).toBeNull()
  })
})

describe('media framing', () => {
  it('gives portrait sources a portrait plate, not a landscape letterbox', () => {
    expect(imageFrame({ width: 900, height: 1400 }, 1920)).toEqual({ width: 450, height: 700, fit: 'contain' })
    expect(imageFrame({ width: 1000, height: 1000 }, 1920)).toEqual({ width: 700, height: 700, fit: 'contain' })
    expect(imageFrame({ width: 1400, height: 1000 }, 1920)).toEqual({ width: 950, height: 679, fit: 'contain' })
  })

  it('leaves wide landscapes to the skin frame', () => {
    expect(imageFrame({ width: 1920, height: 1080 }, 1920)).toBeNull()
    expect(imageFrame(null, 1920)).toBeNull()
  })

  it('keeps small logos/scans near their own size instead of upscaling them', () => {
    expect(imageFrame({ width: 200, height: 200 }, 1920)).toEqual({ width: 320, height: 320, fit: 'contain' })
    expect(imageFrame({ width: 300, height: 200 }, 1920)).toEqual({ width: 480, height: 320, fit: 'contain' })
  })

  it('crops tall page screenshots from the top, keeps viewport screenshots whole', () => {
    expect(screenshotFrame({ width: 1200, height: 3600 }, 1920).fit).toBe('cover-top')
    expect(screenshotFrame({ width: 1280, height: 800 }, 1920).fit).toBe('contain')
    expect(screenshotFrame({ width: 1200, height: 3600 }, 1920).width).toBe(1180)
  })

  it('recognises Scout screenshots and derives the host', () => {
    expect(isScreenshotPath('media/screenshots/en.wikipedia.org_John_Grierson_1.jpg')).toBe(true)
    expect(isScreenshotPath('media/images/photo.jpg')).toBe(false)
    expect(screenshotHost('media/screenshots/en.wikipedia.org_John_Grierson_1.jpg')).toBe('en.wikipedia.org')
    expect(screenshotHost('media/screenshots/odd_file.jpg')).toBe('')
  })

  it('treats extremely tall web images as page plates too', () => {
    expect(isPagePlate('media/web/tall_page.jpg', { width: 1200, height: 3600 })).toBe(true)
    expect(isPagePlate('media/web/photo.jpg', { width: 1200, height: 1600 })).toBe(false)
    expect(isPagePlate('media/screenshots/x.jpg', null)).toBe(true)
  })
})