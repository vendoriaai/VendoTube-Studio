import { isIP } from 'node:net'

/**
 * SSRF network guard (TAD §7 / PRD R7) — Node side.
 * Mirrors bridge/guard.py: http/https only; localhost/.local refused; every
 * resolved IP must be globally routable (loopback, RFC1918, link-local incl.
 * 169.254.169.254, CGNAT, multicast, reserved, and v4-mapped IPv6 refused).
 * Resolver is injectable for deterministic tests (no network in unit tests).
 */

export type ResolveFn = (host: string) => Promise<string[]>

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // this-network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved (incl. broadcast)
]

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    const v = Number(part)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = v4ToInt(ip)
  const b = v4ToInt(base)
  if (a === null || b === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

export function isRoutableIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    if (ip === '255.255.255.255') return false
    return !BLOCKED_V4_RANGES.some(([base, bits]) => inCidr(ip, base, bits))
  }
  if (family === 6) {
    const lower = ip.toLowerCase().replace(/[[\]]/g, '')
    // v4-mapped (::ffff:a.b.c.d) — evaluate the embedded v4 address
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isRoutableIp(mapped[1])
    if (lower === '::' || lower === '::1') return false
    if (lower.startsWith('fe80:')) return false // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false // unique-local
    if (lower.startsWith('ff')) return false // multicast
    // Teredo (2001:0::/32) — conservative reject; encapsulated v4 can be private.
    if (lower.startsWith('2001:0:')) return false
    // 6to4 (2002::/16): evaluate the embedded v4 /16 prefix.
    const sixto4 = lower.match(/^2002:([0-9a-f]{1,4}):/)
    if (sixto4) {
      const word = parseInt(sixto4[1], 16)
      const v4 = `${(word >> 8) & 0xff}.${word & 0xff}.0.1`
      if (!isRoutableIp(v4)) return false
    }
    // Global unicast space is 2000::/3; anything else is conservative-reject.
    const firstWord = parseInt(lower.split(':')[0] ?? 'ffff', 16)
    if (Number.isNaN(firstWord) || (firstWord & 0xe000) !== 0x2000) return false
    return true
  }
  return false
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

export interface AssertOptions {
  resolve?: ResolveFn
}

export async function assertPublicHttpUrl(rawUrl: string, opts: AssertOptions = {}): Promise<string[]> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new SsrfError('url is required')
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new SsrfError(`invalid url: ${rawUrl.slice(0, 80)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`scheme not allowed: ${parsed.protocol.replace(':', '')}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!host) throw new SsrfError('url has no hostname')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfError(`host not allowed: ${host}`)
  }
  const resolve =
    opts.resolve ??
    (async (h: string): Promise<string[]> => {
      const { promises: dns } = await import('node:dns')
      const results = await dns.lookup(h, { all: true, verbatim: true })
      return results.map((r) => r.address)
    })
  let ips: string[]
  try {
    ips = await resolve(host)
  } catch (err) {
    throw new SsrfError(`dns resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!ips.length) throw new SsrfError(`host did not resolve: ${host}`)
  for (const ip of ips) {
    if (!isRoutableIp(ip)) {
      throw new SsrfError(`host ${host} resolves to a non-routable address (${ip}); refused`)
    }
  }
  return ips
}

/** Default system resolver (node:dns). Exported for tests to spy on. */
export const systemResolve: ResolveFn = async (host) => {
  const { promises: dns } = await import('node:dns')
  return (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address)
}
