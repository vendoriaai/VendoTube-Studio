import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, isRoutableIp, SsrfError } from '../src/main/net/guard'

/**
 * SSRF guard suite (M1 exit criterion). All cases run against an injected
 * resolver — no network. Hosts resolve to the literal they name, except the
 * tricky ones which resolve to exactly the address under test.
 */

const resolveLiteral = async (host: string): Promise<string[]> => {
  // strip brackets from IPv6 literals; treat everything else as a DNS name
  // that resolves to a fixed public address unless the host IS an IP literal.
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIPCompat(bare)) return [bare]
  return ['93.184.216.34'] // example.com-ish public IP
}

function isIPCompat(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

const assertWith = (url: string, resolve = resolveLiteral) => assertPublicHttpUrl(url, { resolve })

describe('SSRF guard — refused targets', () => {
  const refusals: Array<[string, string]> = [
    ['ftp://example.com/file', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['http://localhost/x', 'localhost'],
    ['http://LOCALHOST:8080/x', 'localhost case'],
    ['http://api.local/x', 'mDNS'],
    ['http://svc.internal/x', 'internal TLD'],
    ['http://127.0.0.1/x', 'v4 loopback'],
    ['http://127.8.8.8/x', 'v4 loopback range'],
    ['http://10.1.2.3/x', 'RFC1918 10/8'],
    ['http://172.16.0.1/x', 'RFC1918 172.16/12'],
    ['http://172.31.255.255/x', 'RFC1918 172.31'],
    ['http://192.168.1.50/x', 'RFC1918 192.168'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['http://100.64.0.1/x', 'CGNAT'],
    ['http://0.0.0.0/x', 'this-network'],
    ['http://224.0.0.1/x', 'multicast'],
    ['http://240.0.0.1/x', 'reserved'],
    ['http://198.18.0.9/x', 'benchmarking'],
    ['http://[::1]/x', 'v6 loopback'],
    ['http://[fe80::1]/x', 'v6 link-local'],
    ['http://[fc00::1]/x', 'v6 unique-local'],
    ['http://[fd12:3456::1]/x', 'v6 unique-local fd'],
    ['http://[ff02::1]/x', 'v6 multicast'],
    ['http://[::ffff:127.0.0.1]/x', 'v4-mapped loopback'],
    ['http://[::ffff:10.0.0.9]/x', 'v4-mapped private'],
    ['http://[2001:0:558:ff01:...]/x', 'teredo']
  ]

  for (const [url, why] of refusals) {
    it(`refuses ${url} (${why})`, async () => {
      await expect(assertWith(url)).rejects.toBeInstanceOf(SsrfError)
    })
  }

  it('refuses a hostname whose DNS resolves private (rebinding style)', async () => {
    const evil = async (host: string): Promise<string[]> => (host === 'innocent.example' ? ['192.168.0.44'] : ['93.184.216.34'])
    await expect(assertWith('https://innocent.example/x', evil)).rejects.toThrow(/non-routable/)
  })

  it('refuses multi-IP answers when ANY address is private', async () => {
    const mixed = async (): Promise<string[]> => ['93.184.216.34', '10.0.0.7']
    await expect(assertWith('https://mixed.example/x', mixed)).rejects.toThrow(/non-routable/)
  })
})

describe('SSRF guard — allowed targets', () => {
  it('allows public https URLs', async () => {
    await expect(assertWith('https://example.com/page?q=1')).resolves.toEqual(['93.184.216.34'])
  })

  it('allows http (research can hit non-TLS hosts)', async () => {
    await expect(assertWith('http://example.com/')).resolves.toBeTruthy()
  })

  it('allows public v6 literals', async () => {
    await expect(assertWith('http://[2606:2800:220:1:248:1893:25c8:1946]/x')).resolves.toBeTruthy()
  })

  it('allows 6to4 embedding a public v4 /16', async () => {
    // 2002:5d58:: → v4 prefix 93.88.x → public
    await expect(assertWith('http://[2002:5d58:3618::1]/x')).resolves.toBeTruthy()
  })

  it('rejects empty and malformed input', async () => {
    await expect(assertWith('')).rejects.toBeInstanceOf(SsrfError)
    await expect(assertWith('not a url')).rejects.toBeInstanceOf(SsrfError)
  })
})

describe('isRoutableIp unit cases', () => {
  it('classifies representative addresses', () => {
    expect(isRoutableIp('8.8.8.8')).toBe(true)
    expect(isRoutableIp('93.184.216.34')).toBe(true)
    expect(isRoutableIp('10.0.0.1')).toBe(false)
    expect(isRoutableIp('192.168.0.1')).toBe(false)
    expect(isRoutableIp('169.254.169.254')).toBe(false)
    expect(isRoutableIp('100.100.1.1')).toBe(false) // CGNAT 100.64/10
    expect(isRoutableIp('100.200.1.1')).toBe(true) // outside CGNAT
    expect(isRoutableIp('::1')).toBe(false)
    expect(isRoutableIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
    expect(isRoutableIp('::ffff:8.8.8.8')).toBe(true)
    expect(isRoutableIp('::ffff:127.0.0.1')).toBe(false)
  })
})
