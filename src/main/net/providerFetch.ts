import * as httpMod from 'node:http'
import * as httpsMod from 'node:https'
import type { FetchEngine } from '../agent/chat'

/**
 * Provider fetch engines (TAD §6) — no external dependencies.
 *
 * 1. node:https on HTTP/1.1 with a patient socket timeout — the workhorse for
 *    lossy international links (HTTP/2 stream resets and undici's short
 *    connect caps are the two failures we kept hitting).
 * 2. Chromium's network stack (net.fetch) — happy-eyeballs across addresses,
 *    honors system proxy; the fallback engine.
 */

const SOCKET_TIMEOUT_MS = 180_000
const MAX_REDIRECTS = 3

interface SimpleResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

function requestOnce(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<SimpleResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'http:' ? httpMod : httpsMod
    const req = mod.request(
      url,
      { method, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          const status = res.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            location: res.headers.location,
            text: async () => text,
            json: async () => JSON.parse(text)
          })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`socket timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** Minimal fetch-compatible POST/GET over HTTP/1.1 with redirect following. */
async function nodeHttpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url)
  const method = init?.method ?? 'GET'
  const headers = (init?.headers ?? {}) as Record<string, string>
  let body = typeof init?.body === 'string' ? init.body : undefined

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, hop === 0 ? method : 'GET', headers, hop === 0 ? body : undefined, SOCKET_TIMEOUT_MS)
    if ([301, 302, 307, 308].includes(res.status) && res.location) {
      url = new URL(res.location, url)
      continue
    }
    return res as unknown as Response
  }
  throw new Error(`too many redirects (> ${MAX_REDIRECTS})`)
}

export const nodeHttpEngine: FetchEngine = {
  name: 'http/1.1',
  fetch: nodeHttpFetch as unknown as typeof fetch
}

export function buildProviderEngines(chromiumFetch: typeof fetch): Array<FetchEngine> {
  return [nodeHttpEngine, { name: 'chromium', fetch: chromiumFetch }]
}
