import { protocol } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'

/**
 * studio:// protocol — read-only local file access for the renderer
 * (asset thumbnails, preview video etc.), restricted to registered project
 * roots. Path is passed base64url-encoded: studio://local/<base64url(abs path)>.
 *
 * HTTP range requests (RFC 7233) are honored so Chromium's <video> can stream
 * and seek the MP4 masters instead of buffering the whole file up front; a
 * request without a Range header still returns the full body.
 */

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
}

/** Parse a single-range `Range: bytes=start-end` header against a file size. */
export function parseByteRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, startRaw, endRaw] = m
  if (startRaw === '' && endRaw === '') return null
  let start: number
  let end: number
  if (startRaw === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endRaw)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

/**
 * Stream a file with an explicit close on cancel. `Readable.toWeb` alone can
 * leave the underlying descriptor open after Chromium seeks away or drops the
 * request, which on Windows keeps the file locked (EBUSY blocks project
 * deletion while a preview stream is abandoned) — 2026-11-19.
 */
function fileStream(abs: string, start?: number, end?: number): ReadableStream {
  const stream = start !== undefined ? createReadStream(abs, { start, end }) : createReadStream(abs)
  // Destroying the node stream closes the descriptor even if the consumer
  // (Chromium's media loader) abandons the body mid-range.
  const cancel = (reason?: unknown): void => {
    stream.destroy(reason instanceof Error ? reason : undefined)
  }
  return new ReadableStream({
    start(controller) {
      let done = false
      const fail = (err: unknown): void => {
        if (done) return
        done = true
        controller.error(err)
      }
      stream.on('data', (chunk: string | Buffer) => {
        if (done) return
        controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk))
      })
      stream.on('end', () => {
        if (done) return
        done = true
        controller.close()
      })
      stream.on('error', fail)
    },
    cancel
  })
}

async function serveFile(abs: string, rangeHeader: string | null): Promise<Response> {
  if (!existsSync(abs)) return new Response('not found', { status: 404 })
  const stat = statSync(abs)
  if (!stat.isFile()) return new Response('not a file', { status: 404 })
  const size = stat.size
  const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  const range = parseByteRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  if (range) {
    const { start, end } = range
    return new Response(fileStream(abs, start, end), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }
  return new Response(fileStream(abs), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}

/** Resolve + authorize a studio:// URL into an absolute file path. */
export function resolveStudioRequest(url: string, allowedRoots: string[]): { abs: string } | { error: Response } {
  const parsed = new URL(url)
  if (parsed.host !== 'local') return { error: new Response('unknown host', { status: 404 }) }
  const encoded = parsed.pathname.replace(/^\/+/, '')
  const abs = resolve(Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf-8'))
  if (!isAbsolute(abs)) return { error: new Response('bad path', { status: 400 }) }
  const roots = allowedRoots.map((r) => resolve(r).toLowerCase())
  const inside = roots.some((root) => abs.toLowerCase().startsWith(root + sep) || abs.toLowerCase() === root)
  if (!inside) return { error: new Response('forbidden', { status: 403 }) }
  return { abs }
}

/** Testable core: authorize + serve, given a Request. */
export async function handleStudioRequest(request: Request, allowedRoots: string[]): Promise<Response> {
  try {
    const resolved = resolveStudioRequest(request.url, allowedRoots)
    if ('error' in resolved) return resolved.error
    return await serveFile(resolved.abs, request.headers.get('Range'))
  } catch (err) {
    return new Response(`error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 })
  }
}

export function registerStudioProtocol(getAllowedRoots: () => string[]): void {
  protocol.handle('studio', (request) => handleStudioRequest(request, getAllowedRoots()))
}

/** Renderer helper — kept here for symmetry; the renderer has its own copy. */
export function toStudioUrl(absPath: string): string {
  return `studio://local/${Buffer.from(absPath, 'utf-8').toString('base64url')}`
}
