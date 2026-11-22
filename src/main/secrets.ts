import { safeStorage } from 'electron'
import type { Db } from './db'

/**
 * Secret storage on top of Electron safeStorage (DPAPI on Windows).
 * Falls back to base64 with a `secure=false` flag when the OS layer is
 * unavailable — surfaced to the UI via ProviderKeyStatus.secure.
 */

interface SecretRow {
  ciphertext: string
}

export function setSecret(db: Db, key: string, plaintext: string): { secure: boolean } {
  const secure = safeStorage.isEncryptionAvailable()
  const ciphertext = secure
    ? safeStorage.encryptString(plaintext).toString('base64')
    : Buffer.from(plaintext, 'utf8').toString('base64')
  db.prepare(
    `INSERT INTO secrets (key, ciphertext, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
  ).run(key, ciphertext, new Date().toISOString())
  return { secure }
}

export function getSecret(db: Db, key: string): string | null {
  const row = db.prepare<[string], SecretRow>('SELECT ciphertext FROM secrets WHERE key = ?').get(key)
  if (!row) return null
  const raw = Buffer.from(row.ciphertext, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw)
    } catch {
      // fall through to base64 fallback below
    }
  }
  return raw.toString('utf8')
}

export function deleteSecret(db: Db, key: string): void {
  db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
}

export function secretStatus(db: Db, key: string): { configured: boolean; last4: string | null; secure: boolean } {
  const secret = getSecret(db, key)
  const secure = safeStorage.isEncryptionAvailable()
  return {
    configured: secret !== null && secret.length > 0,
    last4: secret ? secret.slice(-4) : null,
    secure
  }
}
