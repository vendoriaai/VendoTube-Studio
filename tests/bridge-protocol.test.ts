import { describe, expect, it } from 'vitest'
import {
  encodeNotification,
  encodeRequest,
  isResponse,
  parseFrame,
  RpcErrorCode
} from '../src/shared/bridge-protocol'

/** Newline-delimited JSON-RPC framing shared with bridge/server.py. */

describe('bridge protocol framing', () => {
  it('encodes requests as single-line JSON', () => {
    const wire = encodeRequest(7, 'sys.ping')
    expect(wire).toMatch(/^\{.*\}\n$/)
    expect(JSON.parse(wire)).toEqual({ jsonrpc: '2.0', id: 7, method: 'sys.ping' })
  })

  it('encodes params when provided', () => {
    const wire = encodeRequest(1, 'dwk.init_project', { path: 'x' })
    expect(JSON.parse(wire).params).toEqual({ path: 'x' })
  })

  it('round-trips a response', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ok: true } })
    const frame = parseFrame(line)
    expect(frame).not.toBeNull()
    if (frame && isResponse(frame)) {
      expect(frame.id).toBe(3)
      expect(frame.result).toEqual({ ok: true })
    } else {
      throw new Error('expected a response frame')
    }
  })

  it('round-trips an error response', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      error: { code: RpcErrorCode.MethodNotFound, message: 'nope' }
    })
    const frame = parseFrame(line)
    expect(frame).not.toBeNull()
    if (frame && isResponse(frame)) expect(frame.error?.code).toBe(-32601)
    else throw new Error('expected a response frame')
  })

  it('parses notifications (no id)', () => {
    const frame = parseFrame(encodeNotification('bridge.log', { line: 'hi' }))
    expect(frame).not.toBeNull()
    expect(isResponse(frame!)).toBe(false)
  })

  it('returns null for garbage without throwing', () => {
    expect(parseFrame('')).toBeNull()
    expect(parseFrame('   ')).toBeNull()
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('{"jsonrpc":"1.0","id":1}')).toBeNull()
    expect(parseFrame('{"jsonrpc":"2.0"}')).toBeNull()
    expect(parseFrame('[1,2,3]')).toBeNull()
    expect(parseFrame('42')).toBeNull()
  })

  it('never throws on partial frames (truncated JSON)', () => {
    const full = encodeRequest(1, 'sys.ping').trim()
    for (let cut = 1; cut < full.length; cut += 7) {
      expect(parseFrame(full.slice(0, cut))).toBeNull()
    }
  })
})
