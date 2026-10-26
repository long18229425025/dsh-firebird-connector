import { createHash, randomBytes } from 'node:crypto'
import { denied } from './errors.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_ENTRIES = 128

function hashSql(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Single-use approval tokens for generated privilege SQL. A token is bound to
 * one action, connection and exact SQL string so a preview cannot be replayed
 * against different privileges or another database.
 */
export class ConfirmationStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.entries = new Map()
  }

  prune() {
    const now = Date.now()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token)
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  issue({ connection, action, sql }) {
    this.prune()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + this.ttlMs
    this.entries.set(token, {
      connection,
      action,
      sqlHash: hashSql(sql),
      expiresAt,
    })
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: Math.round(this.ttlMs / 1000),
    }
  }

  consume({ token, connection, action, sql }) {
    if (typeof token !== 'string' || token.length === 0) {
      throw denied(
        'This action requires a confirmation token from a previous preview call',
        'CONFIRMATION_REQUIRED',
      )
    }
    const entry = this.entries.get(token)
    if (!entry) {
      throw denied(
        'Confirmation token is invalid, expired or already used; request a new preview',
        'CONFIRMATION_INVALID',
      )
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(token)
      throw denied('Confirmation token has expired; request a new preview', 'CONFIRMATION_EXPIRED')
    }
    if (
      entry.connection !== connection
      || entry.action !== action
      || entry.sqlHash !== hashSql(sql)
    ) {
      throw denied(
        'Confirmation token does not match this connection and generated SQL',
        'CONFIRMATION_MISMATCH',
      )
    }
    this.entries.delete(token)
  }

  clear() {
    this.entries.clear()
  }
}
