import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { loadConfig } from '../../src/config.js'
import { Redactor } from '../../src/audit.js'
import { ConfirmationStore } from '../../src/confirmations.js'
import { auditArgumentFailures } from '../../src/tools/shared.js'

let buildTools
try {
  ({ buildTools } = await import('../../src/tools/index.js'))
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('@deepseek-ai/dsh-tools')) {
    throw error
  }
  buildTools = null
}

const skip = buildTools ? false : 'dsh-tools is not installed; run tests from a dsh profile or link node_modules'

function makeConfig() {
  return loadConfig({
    logLevel: 'silent',
    audit: { file: resolve(process.cwd(), '.tmp-test', 'tools-audit.jsonl') },
    connections: {
      dev: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'admin',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        allowedObjects: ['T', 'P', 'V', 'CHILD'],
        allowRoleSwitch: true,
      },
      rw: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'readwrite',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        allowedObjects: ['T', 'P', 'V', 'CHILD'],
      },
      ro: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'readonly',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        allowedObjects: ['T'],
      },
      unrestricted: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'readwrite',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        allowUnrestrictedDML: true,
        allowedObjects: ['T'],
      },
      system: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'admin',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        allowSystemTables: true,
      },
      roleOff: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'admin',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
      },
    },
  })
}

function makeManager() {
  const calls = []
  return {
    calls,
    async query(name, sql, params) {
      calls.push({ op: 'query', name, sql, params })
      return { rows: [{ ID: 1 }], fields: [{ name: 'ID' }], warnings: [] }
    },
    async execute(name, sql, params) {
      calls.push({ op: 'execute', name, sql, params })
      return { affectedRows: 1, rows: [], fields: [], warnings: [] }
    },
    async call(name, sql, params) {
      calls.push({ op: 'call', name, sql, params })
      return { affectedRows: 1, rows: [{ OUT: 2 }], fields: [{ name: 'OUT' }], warnings: [] }
    },
    async ddl(name, sql) {
      calls.push({ op: 'ddl', name, sql })
      return { affectedRows: 0, warnings: [] }
    },
    async setRole(name, role) {
      calls.push({ op: 'setRole', name, role })
      return { role, serverVersion: '5.0.3' }
    },
    describe(name) {
      return { activeRole: name === 'dev' ? 'R1' : null }
    },
    list() {
      return [
        { name: 'dev', accessMode: 'admin', userSource: { kind: 'env', name: 'FB_USER' } },
        { name: 'ro', accessMode: 'readonly', userSource: { kind: 'env', name: 'FB_USER' } },
      ]
    },
  }
}

function makeMetadata(overrides = {}) {
  return {
    async resolveObject(_connection, name, type) {
      return { type, name, row: { NAME: name } }
    },
    invalidate() {},
    async ddlWarnings() { return [] },
    async dependents() { return [] },
    async incomingForeignKeys() { return [] },
    async columnUsage() {
      return { dependencies: [], indexes: [], foreignKeys: [] }
    },
    async checkProcedureExecute(_connection, name) {
      return {
        exists: true,
        allowed: true,
        procedure: name,
        owner: 'SYSDBA',
        currentUser: 'ALICE',
        activeRole: null,
        procedureType: 'selectable',
        selectable: true,
        inputCount: 2,
        valid: true,
        grants: [],
      }
    },
    ...overrides,
  }
}

function makeAudit() {
  const entries = []
  const redactor = new Redactor()
  return {
    entries,
    addSecret(value) { redactor.addSecret(value) },
    redact(value) { return redactor.redact(value) },
    write(entry) {
      entries.push({ ...entry, sql: redactor.redact(entry.sql ?? '') })
    },
  }
}

function makeContext(overrides = {}) {
  const config = overrides.config ?? makeConfig()
  const manager = overrides.manager ?? makeManager()
  const metadata = overrides.metadata ?? makeMetadata()
  const audit = overrides.audit ?? makeAudit()
  const confirmations = overrides.confirmations ?? new ConfirmationStore()
  return {
    config,
    manager,
    metadata,
    audit,
    confirmations,
    credentials: undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    tools: Object.fromEntries(buildTools({ config, manager, metadata, audit, confirmations, credentials: undefined, log: { debug() {}, info() {}, warn() {}, error() {} } }).map((tool) => [tool.name, tool])),
  }
}

const lastAudit = (audit) => audit.entries.at(-1)
const lastCall = (manager) => manager.calls.at(-1)

test('firebird_query binds values, applies the row cap and audits success', { skip }, async () => {
  const context = makeContext()
  const result = await context.tools.firebird_query.execute({
    connection: 'dev',
    sql: 'SELECT * FROM T WHERE ID = :id',
    params: { id: 7 },
  }, {})
  assert.equal(lastCall(context.manager).sql, 'SELECT * FROM T WHERE ID = ? ROWS 501')
  assert.deepEqual(lastCall(context.manager).params, [7])
  assert.equal(result.effectiveSql, 'SELECT * FROM T WHERE ID = ? ROWS 501')
  assert.equal(result.rowCount, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.limitCapped, false)
  assert.equal(lastAudit(context.audit).status, 'success')
})

test('firebird_query rejects writes, locks and unlisted objects', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_query.execute({ connection: 'dev', sql: 'UPDATE T SET X = 1 WHERE ID = 1' }, {}),
    (error) => error.code === 'NOT_A_QUERY',
  )
  await assert.rejects(
    () => context.tools.firebird_query.execute({ connection: 'dev', sql: 'SELECT * FROM T FOR UPDATE' }, {}),
    (error) => error.code === 'LOCK_CLAUSE',
  )
  await assert.rejects(
    () => context.tools.firebird_query.execute({ connection: 'dev', sql: 'SELECT * FROM S' }, {}),
    (error) => error.code === 'OBJECT_NOT_ALLOWED',
  )
  assert.equal(lastAudit(context.audit).status, 'denied')
})

test('firebird_execute requires confirmWrite and gates unrestricted DML', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_execute.execute({ connection: 'dev', sql: 'INSERT INTO T (ID) VALUES (?)', params: [1] }, {}),
    (error) => error.code === 'CONFIRM_WRITE_REQUIRED',
  )
  await assert.rejects(
    () => context.tools.firebird_execute.execute({ connection: 'dev', sql: 'DELETE FROM T', confirmWrite: true }, {}),
    (error) => error.code === 'UNRESTRICTED_DML_DENIED',
  )
  await assert.rejects(
    () => context.tools.firebird_execute.execute({ connection: 'dev', sql: 'DELETE FROM T', confirmWrite: true, confirmDangerous: true }, {}),
    (error) => error.code === 'UNRESTRICTED_DML_DENIED',
  )

  const unrestricted = makeContext()
  const result = await unrestricted.tools.firebird_execute.execute({
    connection: 'unrestricted',
    sql: 'DELETE FROM T',
    confirmWrite: true,
    confirmDangerous: true,
  }, {})
  assert.equal(result.executed, true)
  assert.equal(result.dangerousConfirmed, true)
  assert.equal(lastCall(unrestricted.manager).op, 'execute')
})

test('firebird_execute enforces whitelist and system-table gating', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_execute.execute({
      connection: 'dev', sql: 'UPDATE S SET X = 1 WHERE ID = 1', confirmWrite: true,
    }, {}),
    (error) => error.code === 'OBJECT_NOT_ALLOWED',
  )
  await assert.rejects(
    () => context.tools.firebird_execute.execute({
      connection: 'roleOff', sql: 'UPDATE RDB$X SET A = 1 WHERE ID = 1', confirmWrite: true,
    }, {}),
    (error) => error.code === 'SYSTEM_TABLE_WRITE_DENIED',
  )
  await assert.rejects(
    () => context.tools.firebird_execute.execute({
      connection: 'system', sql: 'UPDATE RDB$X SET A = 1 WHERE ID = 1', confirmWrite: true,
    }, {}),
    (error) => error.code === 'CONFIRM_DANGEROUS_REQUIRED',
  )
  const result = await context.tools.firebird_execute.execute({
    connection: 'system',
    sql: 'UPDATE RDB$X SET A = ? WHERE ID = ?',
    params: [1, 2],
    confirmWrite: true,
    confirmDangerous: true,
  }, {})
  assert.equal(result.executed, true)
})

test('firebird_call_procedure checks EXECUTE and binds input values', { skip }, async () => {
  const deniedMetadata = makeMetadata({
    async checkProcedureExecute() {
      return { exists: true, allowed: false, reason: 'no EXECUTE' }
    },
  })
  const denied = makeContext({ metadata: deniedMetadata })
  await assert.rejects(
    () => denied.tools.firebird_call_procedure.execute({ connection: 'dev', procedure: 'P', params: [1, 2] }, {}),
    (error) => error.code === 'EXECUTE_DENIED',
  )

  const missing = makeContext({ metadata: makeMetadata({
    async checkProcedureExecute() { return { exists: false, allowed: false } },
  }) })
  await assert.rejects(
    () => missing.tools.firebird_call_procedure.execute({ connection: 'dev', procedure: 'P', params: [] }, {}),
    (error) => error.code === 'OBJECT_NOT_FOUND',
  )

  const context = makeContext()
  const result = await context.tools.firebird_call_procedure.execute({
    connection: 'dev',
    procedure: 'P',
    params: [1, 'x'],
  }, {})
  assert.equal(lastCall(context.manager).sql, 'SELECT * FROM P(?, ?)')
  assert.deepEqual(lastCall(context.manager).params, [1, 'x'])
  assert.equal(result.mode, 'select')
  assert.equal(result.rowCount, 1)
})

test('DDL requires confirmDDL, enforces access modes and dangerous confirmations', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_create.execute({ connection: 'rw', sql: 'CREATE TABLE T (ID INT)' }, {}),
    (error) => error.code === 'CONFIRM_DDL_REQUIRED',
  )
  await assert.rejects(
    () => context.tools.firebird_create.execute({ connection: 'ro', sql: 'CREATE TABLE T (ID INT)', confirmDDL: true }, {}),
    (error) => error.code === 'ACCESS_DENIED',
  )
  await assert.rejects(
    () => context.tools.firebird_create.execute({ connection: 'rw', sql: 'CREATE PROCEDURE P AS BEGIN EXIT; END', confirmDDL: true }, {}),
    (error) => error.code === 'ACCESS_DENIED',
  )
  await assert.rejects(
    () => context.tools.firebird_create.execute({ connection: 'rw', sql: 'CREATE TABLE S (ID INT)', confirmDDL: true }, {}),
    (error) => error.code === 'OBJECT_NOT_ALLOWED',
  )
  await assert.rejects(
    () => context.tools.firebird_create.execute({ connection: 'rw', sql: 'CREATE USER X PASSWORD \'x\'', confirmDDL: true }, {}),
    (error) => error.code === 'USER_DDL_DENIED',
  )

  const created = await context.tools.firebird_create.execute({
    connection: 'rw',
    sql: 'CREATE TABLE T (ID INT)',
    confirmDDL: true,
  }, {})
  assert.equal(created.executed, true)
  assert.equal(lastCall(context.manager).sql, 'CREATE TABLE T (ID INT)')
})

test('DROP TABLE referenced by a foreign key requires confirmDangerous', { skip }, async () => {
  const manager = makeManager()
  const metadata = makeMetadata({
    async incomingForeignKeys() { return [{ name: 'FK_CHILD_T' }] },
  })
  const context = makeContext({ manager, metadata })
  await assert.rejects(
    () => context.tools.firebird_drop.execute({ connection: 'dev', sql: 'DROP TABLE T', confirmDDL: true }, {}),
    (error) => error.code === 'CONFIRM_DANGEROUS_REQUIRED',
  )
  const dropped = await context.tools.firebird_drop.execute({
    connection: 'dev',
    sql: 'DROP TABLE T',
    confirmDDL: true,
    confirmDangerous: true,
  }, {})
  assert.equal(dropped.executed, true)
  assert.equal(dropped.dangerousConfirmed, true)
})

test('ALTER TABLE DROP column with dependencies requires confirmDangerous', { skip }, async () => {
  const context = makeContext({
    metadata: makeMetadata({
      async columnUsage() {
        return {
          dependencies: [{ name: 'P' }],
          indexes: ['IDX_NAME'],
          foreignKeys: [],
        }
      },
    }),
  })
  await assert.rejects(
    () => context.tools.firebird_alter.execute({
      connection: 'dev', sql: 'ALTER TABLE T DROP COLUMN NAME', confirmDDL: true,
    }, {}),
    (error) => error.code === 'CONFIRM_DANGEROUS_REQUIRED' && /IDX_NAME/.test(error.message),
  )
  const altered = await context.tools.firebird_alter.execute({
    connection: 'dev',
    sql: 'ALTER TABLE T DROP COLUMN NAME',
    confirmDDL: true,
    confirmDangerous: true,
  }, {})
  assert.equal(altered.executed, true)
})

test('firebird_grant is two-step, single-use and bound to the generated SQL', { skip }, async () => {
  const context = makeContext()
  const preview = await context.tools.firebird_grant.execute({
    connection: 'dev',
    privileges: ['SELECT', 'INSERT'],
    objectType: 'table',
    object: 'T',
    grantee: 'alice',
  }, {})
  assert.equal(preview.executed, false)
  assert.equal(preview.confirmationRequired, true)
  assert.equal(preview.sql, 'GRANT SELECT, INSERT ON TABLE T TO alice')
  assert.equal(preview.confirmationToken.length > 20, true)
  assert.equal(lastAudit(context.audit).status, 'success')

  await assert.rejects(
    () => context.tools.firebird_grant.execute({
      connection: 'dev',
      privileges: ['SELECT', 'INSERT'],
      objectType: 'table',
      object: 'T',
      grantee: 'alice',
      confirmationToken: preview.confirmationToken,
    }, {}),
    (error) => error.code === 'CONFIRM_PRIVILEGE_REQUIRED',
  )

  const executed = await context.tools.firebird_grant.execute({
    connection: 'dev',
    privileges: ['SELECT', 'INSERT'],
    objectType: 'table',
    object: 'T',
    grantee: 'alice',
    confirmPrivilege: true,
    confirmationToken: preview.confirmationToken,
  }, {})
  assert.equal(executed.executed, true)
  assert.equal(lastCall(context.manager).sql, 'GRANT SELECT, INSERT ON TABLE T TO alice')

  await assert.rejects(
    () => context.tools.firebird_grant.execute({
      connection: 'dev',
      privileges: ['SELECT', 'INSERT'],
      objectType: 'table',
      object: 'T',
      grantee: 'alice',
      confirmPrivilege: true,
      confirmationToken: preview.confirmationToken,
    }, {}),
    (error) => error.code === 'CONFIRMATION_INVALID',
  )
})

test('firebird_grant validates privileges, objects and revoke options', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_grant.execute({
      connection: 'dev', privileges: ['EXECUTE'], objectType: 'table', object: 'T', grantee: 'A',
    }, {}),
    (error) => error.code === 'INVALID_PRIVILEGE',
  )
  await assert.rejects(
    () => context.tools.firebird_grant.execute({
      connection: 'dev', privileges: ['SELECT'], objectType: 'table', object: 'S', grantee: 'A',
    }, {}),
    (error) => error.code === 'OBJECT_NOT_ALLOWED',
  )
  await assert.rejects(
    () => context.tools.firebird_grant.execute({
      connection: 'dev', privileges: ['SELECT'], objectType: 'table', object: 'T', grantee: 'A', grantOptionFor: true,
    }, {}),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
  const revoke = context.tools.firebird_revoke
  const preview = await revoke.execute({
    connection: 'dev',
    privileges: ['SELECT'],
    objectType: 'table',
    object: 'T',
    grantee: 'alice',
    grantOptionFor: true,
  }, {})
  assert.equal(preview.sql, 'REVOKE GRANT OPTION FOR SELECT ON TABLE T FROM alice')
  assert.equal(preview.executed, false)
})

test('firebird_set_role honours allowRoleSwitch and clears with an empty role', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_set_role.execute({ connection: 'roleOff', role: 'R' }, {}),
    (error) => error.code === 'ROLE_SWITCH_DENIED',
  )
  const switched = await context.tools.firebird_set_role.execute({ connection: 'dev', role: 'R2' }, {})
  assert.equal(switched.previousRole, 'R1')
  assert.equal(switched.role, 'R2')
  assert.equal(switched.changed, true)
  assert.deepEqual(lastCall(context.manager), { op: 'setRole', name: 'dev', role: 'R2' })

  const cleared = await context.tools.firebird_set_role.execute({ connection: 'dev', role: '' }, {})
  assert.equal(cleared.role, null)
  assert.equal(lastCall(context.manager).role, null)
})

test('firebird_manage_user resolves passwords only from env/refs and redacts SQL', { skip }, async () => {
  const context = makeContext()
  await assert.rejects(
    () => context.tools.firebird_manage_user.execute({
      connection: 'dev', action: 'create', username: 'APP', confirmDDL: true,
    }, {}),
    (error) => error.code === 'PASSWORD_REQUIRED',
  )
  await assert.rejects(
    () => context.tools.firebird_manage_user.execute({
      connection: 'dev', action: 'create', username: 'APP', passwordEnv: 'MISSING_PASSWORD_ENV', confirmDDL: true,
    }, {}),
    /is not set/,
  )

  process.env.FB_TEST_PASSWORD = "s3cr'et!"
  try {
    const created = await context.tools.firebird_manage_user.execute({
      connection: 'dev',
      action: 'create',
      username: 'app',
      passwordEnv: 'FB_TEST_PASSWORD',
      firstName: 'App',
      confirmDDL: true,
    }, {})
    assert.equal(created.username, 'APP')
    assert.equal(created.passwordSource, 'env')
    assert.match(created.sql, /^CREATE USER APP PASSWORD '\*\*\*' FIRSTNAME 'App'$/)
    assert.equal(created.sql.includes("s3cr'et!"), false)
    assert.equal(lastCall(context.manager).sql, "CREATE USER APP PASSWORD 's3cr''et!' FIRSTNAME 'App'")
    assert.equal(lastAudit(context.audit).sql.includes("s3cr'et!"), false)

    await assert.rejects(
      () => context.tools.firebird_manage_user.execute({
        connection: 'dev', action: 'drop', username: 'APP', confirmDDL: true,
      }, {}),
      (error) => error.code === 'CONFIRM_DANGEROUS_REQUIRED',
    )
    const dropped = await context.tools.firebird_manage_user.execute({
      connection: 'dev', action: 'drop', username: 'APP', confirmDDL: true, confirmDangerous: true,
    }, {})
    assert.equal(lastCall(context.manager).sql, 'DROP USER APP')
    assert.equal(dropped.executed, true)

    await assert.rejects(
      () => context.tools.firebird_manage_user.execute({
        connection: 'dev', action: 'alter', username: 'APP', confirmDDL: true,
      }, {}),
      (error) => error.code === 'NO_USER_CHANGES',
    )
    await assert.rejects(
      () => context.tools.firebird_manage_user.execute({
        connection: 'dev', action: 'drop', username: 'APP', passwordEnv: 'FB_TEST_PASSWORD', confirmDDL: true, confirmDangerous: true,
      }, {}),
      (error) => error.code === 'PASSWORD_NOT_ALLOWED',
    )
  } finally {
    delete process.env.FB_TEST_PASSWORD
  }
})

test('firebird_list_connections returns safe facts and audits the call', { skip }, async () => {
  const context = makeContext()
  const result = await context.tools.firebird_list_connections.execute({}, {})
  assert.equal(result.count, 2)
  assert.equal(result.connections[0].accessMode, 'admin')
  assert.equal(lastAudit(context.audit).tool, 'firebird_list_connections')
  assert.equal(lastAudit(context.audit).status, 'success')
})

test('auditArgumentFailures records dsh schema rejections', { skip }, async () => {
  const context = makeContext()
  const wrapped = auditArgumentFailures(context.tools.firebird_query, context.audit)
  await assert.rejects(
    () => wrapped.execute({ sql: 'SELECT 1' }, {}),
    (error) => error.code === 'INVALID_ARGS',
  )
  const entry = lastAudit(context.audit)
  assert.equal(entry.code, 'INVALID_ARGS')
  assert.equal(entry.status, 'denied')
  assert.equal(entry.tool, 'firebird_query')
})
