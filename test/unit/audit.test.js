import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog, Redactor } from '../../src/audit.js'

function tempAudit() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fb-audit-'))
  return { dir, file: join(dir, 'audit.jsonl') }
}

const sha = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

test('Redactor masks configured secrets and credential-shaped syntax', () => {
  const redactor = new Redactor()
  redactor.addSecret('hunter2')
  assert.equal(redactor.redact('SELECT \'hunter2\' FROM X'), "SELECT '***' FROM X")
  assert.equal(
    redactor.redact("CREATE USER APP PASSWORD 'pa''ss'"),
    "CREATE USER APP PASSWORD '***'",
  )
  assert.equal(
    redactor.redact("ALTER USER APP IDENTIFIED BY 'pa''ss'"),
    "ALTER USER APP IDENTIFIED BY '***'",
  )
  assert.equal(redactor.redact('password=plain pwd=other'), 'password=*** pwd=***')
  assert.equal(
    redactor.redact('firebird://sysdba:masterkey@host:3050/app.fdb'),
    'firebird://***:***@host:3050/app.fdb',
  )
  assert.equal(redactor.redact(null), '')
  assert.equal(redactor.redact(undefined), '')
  redactor.addSecret('')
  assert.equal(redactor.redact('abc'), 'abc')
})

test('AuditLog writes one redacted JSONL record per call', () => {
  const { dir, file } = tempAudit()
  const redactor = new Redactor()
  redactor.addSecret('masterkey')
  const audit = new AuditLog(file, { redactor })
  audit.open()

  const longSql = `SELECT 'masterkey' FROM T WHERE X = 1 ${'AND Y = 2 '.repeat(30)}`
  const record = audit.write({
    connection: 'dev',
    tool: 'firebird_query',
    sql: longSql,
    status: 'success',
    durationMs: 12.6,
  })
  audit.write({
    connection: 'prod',
    tool: 'firebird_execute',
    sql: 'DELETE FROM T',
    status: 'error',
    durationMs: -5,
    error: 'boom '.repeat(300),
    code: 'DB_ERROR',
  })
  audit.flush()
  audit.close()

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  const [first, second] = lines
  assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(first.connection, 'dev')
  assert.equal(first.tool, 'firebird_query')
  assert.equal(first.status, 'success')
  assert.equal(first.durationMs, 13)
  assert.equal(first.sql.length, 200)
  assert.equal(first.sqlTruncated, true)
  assert.equal(first.sql.includes('masterkey'), false)
  const redactedFull = redactor.redact(longSql)
  assert.equal(first.sqlHash, sha(redactedFull))
  assert.equal(record.sqlHash, first.sqlHash)

  assert.equal(second.durationMs, 0)
  assert.equal(second.code, 'DB_ERROR')
  assert.equal(second.error.length, 1000)
  assert.equal(second.sqlTruncated, undefined)
  assert.equal(second.sqlHash, sha('DELETE FROM T'))
  assert.equal(second.sql, 'DELETE FROM T')
  assert.throws(() => audit.write({
    connection: 'dev',
    tool: 'x',
    status: 'success',
    durationMs: 1,
  }), (error) => error.code === 'AUDIT_UNAVAILABLE')

  rmSync(dir, { recursive: true, force: true })
})

test('AuditLog redacts connection text and hashes the full SQL', () => {
  const { dir, file } = tempAudit()
  const audit = new AuditLog(file)
  audit.open()
  audit.write({
    connection: 'firebird://user:secret@host/db password=secret',
    tool: 'firebird_list_connections',
    sql: 'SELECT ' + 'X'.repeat(250),
    status: 'denied',
    durationMs: 1.4,
    code: 'DENIED',
  })
  audit.close()
  const record = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.equal(record.connection, 'firebird://***:***@host/db password=***')
  assert.equal(record.status, 'denied')
  assert.equal(record.durationMs, 1)
  assert.equal(record.sql.length, 200)
  assert.equal(record.sqlTruncated, true)
  rmSync(dir, { recursive: true, force: true })
})
