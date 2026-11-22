/**
 * JSON-RPC 2.0 newline-delimited framing shared by the Electron main process
 * (BridgeClient), the Python bridge, and the protocol unit tests.
 */
export const JSONRPC_VERSION = '2.0' as const

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: number
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export function encodeRequest(id: number, method: string, params?: unknown): string {
  const frame: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method }
  if (params !== undefined) frame.params = params
  return JSON.stringify(frame) + '\n'
}

export function encodeNotification(method: string, params?: unknown): string {
  const frame: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method }
  if (params !== undefined) frame.params = params
  return JSON.stringify(frame) + '\n'
}

/** Parse one newline-delimited frame. Returns null for empty/garbage lines. */
export function parseFrame(line: string): JsonRpcResponse | JsonRpcNotification | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const frame = parsed as Record<string, unknown>
  if (frame.jsonrpc !== JSONRPC_VERSION) return null
  if (typeof frame.method === 'string') {
    // Notification (no id expected on the wire from the bridge)
    return { jsonrpc: JSONRPC_VERSION, method: frame.method, params: frame.params } as JsonRpcNotification
  }
  if (typeof frame.id === 'number') {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: frame.id,
      result: frame.result,
      ...(frame.error !== undefined ? { error: frame.error as JsonRpcError } : {})
    } as JsonRpcResponse
  }
  return null
}

export function isResponse(frame: JsonRpcResponse | JsonRpcNotification): frame is JsonRpcResponse {
  return 'id' in frame
}

/** Standard JSON-RPC error codes used by the bridge. */
export const RpcErrorCode = {
  ParseError: -32700,
  MethodNotFound: -32601,
  ServerError: -32000
} as const
