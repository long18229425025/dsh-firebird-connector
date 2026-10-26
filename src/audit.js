import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { FirebirdToolError } from './errors.js'

const PREVIEW_LENGTH = 200
const ERROR_LENGTH = 1000

const QUOTED_PASSWORD = /(\b(?:PASSWORD|PASSWD|PWD)\b\s*(?:=|IS)?\s*)'(?:[^']|'')*'/gi
const IDENTIFIED_BY = /(\bIDENTIFIED\s+BY\s*)'(?:[^']|'')*'/gi
const ASSIGNED_SECRET = /(\b(?:PASSWORD|PASSWD|PWD)\b\s*=\s*)[^\s;,'"]+/gi
const URI_USERINFO = /(\/\/)[^/@\s:]+:[^/@\s]*@/g

/**
 * Redact configured secrets and credential-shaped syntax. The audit log is
 * append-only and has no retention settings: anything sensitive that reaches
 * it stays there, so redaction runs before preview, hash and error capture.
 */
export class Redactor {
  constructor() {
    this.secrets = new Set()
  }

  addSecret(value) {
    if (typeof value === 'string' && value.length > 0) this.secrets.add(value)
  }

  redact(value) {
    if (value === undefined || value === null) return ''
    let text = String(value)
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length)
    for (const secret of secrets) {
      text = text.split(secret).join('***')
    }
    text = text
      .replace(IDENTIFIED_BY, "$1'***'")
      .replace(QUOTED_PASSWORD, "$1'***'")
      .replace(ASSIGNED_SECRET, '$1***')
      .replace(URI_USERINFO, '$1***:***@')
    return text
  }
}

/**
 * One durable JSONL audit record per tool invocation (success, denial or
 * failure). Writes are synchronous so a line exists before the tool returns;
 * fsync on dispose guarantees everything reached stable storage.
 */
export class AuditLog {
  constructor(file, { redactor = new Redactor() } = {}) {
    this.file = file
    this.redactor = redactor
    this.fd = null
  }

  open() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      this.fd = openSync(this.file, 'a', 0o600)
      try {
        chmodSync(this.file, 0o600)
      } catch {
        // Windows does not implement POSIX modes; the default ACL still applies.
      }
    } catch (error) {
      throw new FirebirdToolError(
        `Cannot open audit log ${this.file}: ${error.message}`,
        { code: 'AUDIT_UNAVAILABLE', status: 'error' },
      )
    }
  }

  addSecret(value) {
    this.redactor.addSecret(value)
  }

  redact(value) {
    return this.redactor.redact(value)
  }

  /**
   * @param {object} entry
   * @param {string} entry.connection
   * @param {string} entry.tool
   * @param {string} [entry.sql] executed or generated SQL (never parameter values)
   * @param {'success'|'denied'|'error'} entry.status
   * @param {number} entry.durationMs
   * @param {string} [entry.error]
   * @param {string} [entry.code]
   */
  write(entry) {
    if (this.fd === null) {
      throw new FirebirdToolError('Audit log is not open', { code: 'AUDIT_UNAVAILABLE', status: 'error' })
    }
    const redactedSql = this.redactor.redact(entry.sql ?? '')
    const record = {
      timestamp: new Date().toISOString(),
      connection: this.redactor.redact(entry.connection ?? ''),
      tool: String(entry.tool ?? ''),
      sql: redactedSql.slice(0, PREVIEW_LENGTH),
      sqlHash: `sha256:${createHash('sha256').update(redactedSql, 'utf8').digest('hex')}`,
      status: entry.status,
      durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
    }
    if (redactedSql.length > PREVIEW_LENGTH) record.sqlTruncated = true
    if (entry.error !== undefined) record.error = this.redactor.redact(entry.error).slice(0, ERROR_LENGTH)
    if (entry.code !== undefined) record.code = String(entry.code)
    try {
      writeSync(this.fd, `${JSON.stringify(record)}\n`, null, 'utf8')
    } catch (error) {
      throw new FirebirdToolError(
        `Failed to write audit log ${this.file}: ${error.message}`,
        { code: 'AUDIT_WRITE_FAILED', status: 'error' },
      )
    }
    return record
  }

  flush() {
    if (this.fd === null) return
    try {
      fsyncSync(this.fd)
    } catch (error) {
      throw new FirebirdToolError(
        `Failed to flush audit log ${this.file}: ${error.message}`,
        { code: 'AUDIT_FLUSH_FAILED', status: 'error' },
      )
    }
  }

  close() {
    if (this.fd === null) return
    try {
      fsyncSync(this.fd)
    } catch {
      // Best effort at shutdown; the line was already written synchronously.
    }
    try {
      closeSync(this.fd)
    } finally {
      this.fd = null
    }
  }
}
