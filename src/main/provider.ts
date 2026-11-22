/**
 * LLM provider adapter — skeleton (TAD §6). M0 ships OpenRouter with a key
 * health check; model calls and the per-agent adapter registry land with the
 * agent runtime (M1/M2).
 */
import type { ProviderHealth } from '@shared/ipc'

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

export interface ProviderAdapter {
  readonly baseUrl: string
  health(): Promise<ProviderHealth>
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly baseUrl = OPENROUTER_BASE

  constructor(private readonly getKey: () => string | null) {}

  async health(timeoutMs = 8000): Promise<ProviderHealth> {
    const key = this.getKey()
    if (!key) return { ok: false, error: 'No API key configured' }
    try {
      const res = await fetch(`${this.baseUrl}/auth/key`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'API key rejected (401/403)' }
      }
      if (!res.ok) {
        return { ok: false, error: `Provider returned HTTP ${res.status}` }
      }
      const body = (await res.json()) as { data?: { label?: string } }
      return { ok: true, label: body.data?.label ?? 'openrouter' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
