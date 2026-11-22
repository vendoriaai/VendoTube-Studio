import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleStudioRequest, parseByteRange, resolveStudioRequest } from '../src/main/studio-protocol'

/** studio:// path for an absolute file path (mirrors toStudioUrl). */
const studioUrl = (abs: string): string => `studio://local/${Buffer.from(abs, 'utf-8').toString('base64url')}`

describe('parseByteRange (RFC 7233)', () => {
  it('returns null with no header', () => {
    expect(parseByteRange(null, 100)).toBeNull()
  })
  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
  })
  it('clamps an open-ended range to the file size', () => {
    expect(parseByteRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
  })
  it('parses a suffix range (last N bytes)', () => {
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })
  it('clamps an end past EOF', () => {
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
  })
  it('flags a start at/past EOF as unsatisfiable', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=200-300', 100)).toBe('unsatisfiable')
  })
  it('ignores malformed headers', () => {
    expect(parseByteRange('bytes=abc', 100)).toBeNull()
    expect(parseByteRange('items=0-1', 100)).toBeNull()
  })
})

describe('resolveStudioRequest (containment)', () => {
  it('accepts a path inside an allowed root', () => {
    const root = process.platform === 'win32' ? 'C:\\proj\\film' : '/proj/film'
    const file = join(root, 'delivery', 'documentary.mp4')
    const r = resolveStudioRequest(studioUrl(file), [root])
    expect('abs' in r && r.abs.toLowerCase().endsWith('documentary.mp4')).toBe(true)
  })
  it('rejects a path outside the allowed roots', () => {
    const root = process.platform === 'win32' ? 'C:\\proj\\film' : '/proj/film'
    const outside = process.platform === 'win32' ? 'C:\\windows\\system32\\evil.mp4' : '/etc/passwd'
    const r = resolveStudioRequest(studioUrl(outside), [root])
    expect('error' in r && r.error.status).toBe(403)
  })
  it('rejects an unknown host', () => {
    const r = resolveStudioRequest('studio://other/x', [])
    expect('error' in r && r.error.status).toBe(404)
  })
})

describe('handleStudioRequest (range streaming)', () => {
  let dir: string
  let file: string
  const bytes = Buffer.from('0123456789abcdef', 'utf-8') // 16 bytes

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-proto-'))
    file = join(dir, 'clip.mp4')
    writeFileSync(file, bytes)
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const req = (url: string, headers: Record<string, string> = {}): Request => new Request(url, { headers })

  it('serves the full body as 200 with Accept-Ranges and Content-Length', async () => {
    const res = await handleStudioRequest(req(studioUrl(file)), [dir])
    expect(res.status).toBe(200)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Length')).toBe('16')
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(Buffer.from(await res.arrayBuffer()).toString('utf-8')).toBe('0123456789abcdef')
  })

  it('serves a 206 with Content-Range for a range request', async () => {
    const res = await handleStudioRequest(req(studioUrl(file), { Range: 'bytes=0-1' }), [dir])
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/16')
    expect(res.headers.get('Content-Length')).toBe('2')
    expect(Buffer.from(await res.arrayBuffer()).toString('utf-8')).toBe('01')
  })

  it('serves the middle of the file', async () => {
    const res = await handleStudioRequest(req(studioUrl(file), { Range: 'bytes=4-7' }), [dir])
    expect(res.status).toBe(206)
    expect(Buffer.from(await res.arrayBuffer()).toString('utf-8')).toBe('4567')
  })

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await handleStudioRequest(req(studioUrl(file), { Range: 'bytes=99-' }), [dir])
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */16')
  })

  it('returns 404 for a missing file', async () => {
    const res = await handleStudioRequest(req(studioUrl(join(dir, 'nope.mp4'))), [dir])
    expect(res.status).toBe(404)
  })

  it('returns 403 for a file outside the roots', async () => {
    const outside = process.platform === 'win32' ? 'C:\\windows\\win.ini' : '/etc/hosts'
    const res = await handleStudioRequest(req(studioUrl(outside)), [dir])
    expect(res.status).toBe(403)
  })
})
