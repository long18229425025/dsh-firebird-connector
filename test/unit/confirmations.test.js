import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfirmationStore } from '../../src/confirmations.js'

test('issues single-use tokens bound to action, connection and SQL', () => {
  const store = new ConfirmationStore()
  const sql = 'GRANT SELECT ON TABLE T TO ALICE'
  const issued = store.issue({ connection: 'dev', action: 'firebird_grant', sql })
  assert.match(issued.token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(issued.ttlSeconds, 300)
  assert.ok(Date.parse(issued.expiresAt) > Date.now())

  assert.doesNotThrow(() => store.consume({
    token: issued.token,
    connection: 'dev',
    action: 'firebird_grant',
    sql,
  }))
  assert.throws(
    () => store.consume({ token: issued.token, connection: 'dev', action: 'firebird_grant', sql }),
    (error) => error.code === 'CONFIRMATION_INVALID',
  )
})

test('rejects tokens for a different connection, action or SQL', () => {
  const store = new ConfirmationStore()
  const issued = store.issue({ connection: 'dev', action: 'firebird_grant', sql: 'GRANT SELECT' })
  for (const attempt of [
    { connection: 'prod', action: 'firebird_grant', sql: 'GRANT SELECT' },
    { connection: 'dev', action: 'firebird_revoke', sql: 'GRANT SELECT' },
    { connection: 'dev', action: 'firebird_grant', sql: 'GRANT ALL' },
  ]) {
    assert.throws(
      () => store.consume({ token: issued.token, ...attempt }),
      (error) => error.code === 'CONFIRMATION_MISMATCH',
    )
  }
  assert.doesNotThrow(() => store.consume({
    token: issued.token,
    connection: 'dev',
    action: 'firebird_grant',
    sql: 'GRANT SELECT',
  }))
})

test('rejects missing and expired tokens', () => {
  const store = new ConfirmationStore()
  assert.throws(
    () => store.consume({ connection: 'dev', action: 'a', sql: 'x' }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  )
  const expired = new ConfirmationStore({ ttlMs: -1 })
  const issued = expired.issue({ connection: 'dev', action: 'a', sql: 'x' })
  assert.throws(
    () => expired.consume({ token: issued.token, connection: 'dev', action: 'a', sql: 'x' }),
    (error) => error.code === 'CONFIRMATION_EXPIRED',
  )
})

test('clear removes outstanding tokens', () => {
  const store = new ConfirmationStore()
  const issued = store.issue({ connection: 'dev', action: 'a', sql: 'x' })
  store.clear()
  assert.throws(
    () => store.consume({ token: issued.token, connection: 'dev', action: 'a', sql: 'x' }),
    (error) => error.code === 'CONFIRMATION_INVALID',
  )
})
