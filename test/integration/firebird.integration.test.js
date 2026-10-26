import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, before, after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AuditLog, Redactor } from '../../src/audit.js'
import { loadConfig } from '../../src/config.js'
import { ConfirmationStore } from '../../src/confirmations.js'
import { ConnectionManager } from '../../src/driver.js'
import { MetadataService } from '../../src/metadata.js'

const ENABLED = process.env.FIREBIRD_INTEGRATION === '1'

let buildTools = null
let toolsError = null
try {
  ({ buildTools } = await import('../../src/tools/index.js'))
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('@deepseek-ai/dsh-tools')) {
    throw error
  }
  toolsError = 'dsh-tools is not installed; run from a dsh profile or link its node_modules'
}

let driverError = null
try {
  await import('node-firebird')
} catch {
  driverError = 'node-firebird is not installed; run `dsh plugin --profile web add node-firebird@^2.18.2`'
}

const skip = !ENABLED
  ? 'set FIREBIRD_INTEGRATION=1 (and start test/integration/docker-compose.yml) to run'
  : (toolsError ?? driverError ?? false)

if (ENABLED && !skip) {
  if (!process.env.FB_IT_USER) process.env.FB_IT_USER = 'SYSDBA'
  if (!process.env.FB_IT_PASSWORD) process.env.FB_IT_PASSWORD = 'masterkey'
}

const VERSIONS = [
  {
    key: '25',
    name: 'fb25',
    label: 'Firebird 2.5',
    port: 3025,
    database: '/firebird/data/it25.fdb',
  },
  {
    key: '30',
    name: 'fb30',
    label: 'Firebird 3.0',
    port: 3030,
    database: '/var/lib/firebird/data/it30.fdb',
  },
  {
    key: '50',
    name: 'fb50',
    label: 'Firebird 5.0',
    port: 3035,
    database: '/var/lib/firebird/data/it50.fdb',
  },
].map((version) => ({
  ...version,
  host: process.env[`FB${version.key}_HOST`] ?? '127.0.0.1',
  port: Number(process.env[`FB${version.key}_PORT`] ?? version.port),
  database: process.env[`FB${version.key}_DATABASE`] ?? version.database,
}))

const TABLE = 'IT_TEST'
const PROCEDURE = 'IT_PROC'
const PROCEDURE_SQL = `RECREATE PROCEDURE ${PROCEDURE} (X INTEGER) RETURNS (Y INTEGER) AS
BEGIN
  Y = X * 2;
  SUSPEND;
END`

function silentLog() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

async function createHarness(version) {
  const workDir = mkdtempSync(join(tmpdir(), `dsh-firebird-it-${version.key}-`))
  const auditFile = join(workDir, 'audit.jsonl')
  const audit = new AuditLog(auditFile, { redactor: new Redactor() })
  audit.open()
  const config = loadConfig({
    logLevel: 'silent',
    audit: { file: auditFile },
    connections: {
      [version.name]: {
        host: version.host,
        port: version.port,
        database: version.database,
        accessMode: 'admin',
        charset: 'UTF8',
        userEnv: 'FB_IT_USER',
        passwordEnv: 'FB_IT_PASSWORD',
        connectTimeoutSeconds: 20,
        queryTimeoutSeconds: 60,
        ddlTimeoutSeconds: 120,
      },
    },
  })
  const log = silentLog()
  const manager = new ConnectionManager({ config, credentials: undefined, audit, log })
  const metadata = new MetadataService({ manager, log })
  const confirmations = new ConfirmationStore()
  const tools = Object.fromEntries(buildTools({
    config,
    manager,
    metadata,
    audit,
    confirmations,
    credentials: undefined,
    log,
  }).map((tool) => [tool.name, tool]))

  return {
    connection: version.name,
    workDir,
    auditFile,
    audit,
    config,
    manager,
    metadata,
    confirmations,
    tools,
  }
}

function call(harness, tool, args = {}) {
  const definition = harness.tools[tool]
  if (!definition) throw new Error(`Tool ${tool} is not registered`)
  return definition.execute(args, {})
}

async function waitForDatabase(harness, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await harness.manager.query(
        harness.connection,
        'SELECT 1 AS OK FROM RDB$DATABASE',
        [],
      )
      if (Array.isArray(result?.rows) && result.rows.length === 1) return
    } catch (error) {
      lastError = error
    }
    await delay(1000)
  }
  throw new Error(
    `Firebird did not become ready at ${harness.config.connections[harness.connection].host}:`
    + `${harness.config.connections[harness.connection].port} `
    + `(database ${harness.config.connections[harness.connection].database}): `
    + `${lastError?.message ?? 'timeout'}`,
  )
}

for (const version of VERSIONS) {
  describe(version.label, { skip }, () => {
    let harness

    before(async () => {
      harness = await createHarness(version)
      await waitForDatabase(harness)
    })

    after(async () => {
      if (!harness) return
      for (const sql of [`DROP PROCEDURE ${PROCEDURE}`, `DROP TABLE ${TABLE}`]) {
        try {
          await call(harness, 'firebird_drop', {
            connection: harness.connection,
            sql,
            confirmDDL: true,
          })
        } catch {
          // Objects may not exist when an earlier assertion failed.
        }
      }
      try {
        await harness.manager.dispose()
      } finally {
        harness.audit.close()
        rmSync(harness.workDir, { recursive: true, force: true })
      }
    })

    it('connects lazily and binds query parameters', async () => {
      const listed = await call(harness, 'firebird_list_connections')
      assert.equal(listed.count, 1)
      assert.equal(listed.connections[0].name, version.name)
      assert.equal(listed.connections[0].accessMode, 'admin')

      const result = await call(harness, 'firebird_query', {
        connection: harness.connection,
        sql: 'SELECT CAST(? AS INTEGER) AS VAL FROM RDB$DATABASE',
        params: [42],
      })
      assert.equal(result.rows.length, 1)
      assert.equal(result.rows[0].VAL, 42)
      assert.equal(result.effectiveSql, 'SELECT CAST(? AS INTEGER) AS VAL FROM RDB$DATABASE ROWS 501')
      assert.equal(result.rowLimit, 500)
      assert.equal(result.truncated, false)
    })

    it('runs DDL, metadata introspection and bound DML', async () => {
      const created = await call(harness, 'firebird_create', {
        connection: harness.connection,
        sql: `RECREATE TABLE ${TABLE} (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(50))`,
        confirmDDL: true,
      })
      assert.equal(created.executed, true)
      assert.equal(created.objectType, 'table')

      const tables = await call(harness, 'firebird_list_objects', {
        connection: harness.connection,
        type: 'table',
        filter: TABLE,
      })
      assert.equal(tables.objects.some((object) => object.name === TABLE), true)

      const described = await call(harness, 'firebird_describe_object', {
        connection: harness.connection,
        name: TABLE,
        type: 'table',
      })
      assert.deepEqual(described.columns.map((column) => column.name), ['ID', 'NAME'])

      for (const [id, name] of [[1, 'alpha'], [2, 'beta'], [3, 'gamma']]) {
        const inserted = await call(harness, 'firebird_execute', {
          connection: harness.connection,
          sql: `INSERT INTO ${TABLE} (ID, NAME) VALUES (?, ?)`,
          params: [id, name],
          confirmWrite: true,
        })
        assert.equal(inserted.executed, true)
        assert.equal(inserted.affectedRows, 1)
      }

      const updated = await call(harness, 'firebird_execute', {
        connection: harness.connection,
        sql: `UPDATE ${TABLE} SET NAME = ? WHERE ID = ?`,
        params: ['beta-updated', 2],
        confirmWrite: true,
      })
      assert.equal(updated.affectedRows, 1)

      const deleted = await call(harness, 'firebird_execute', {
        connection: harness.connection,
        sql: `DELETE FROM ${TABLE} WHERE ID = ?`,
        params: [3],
        confirmWrite: true,
      })
      assert.equal(deleted.affectedRows, 1)

      await assert.rejects(
        () => call(harness, 'firebird_execute', {
          connection: harness.connection,
          sql: `DELETE FROM ${TABLE}`,
          confirmWrite: true,
        }),
        (error) => error.code === 'UNRESTRICTED_DML_DENIED',
      )

      const limited = await call(harness, 'firebird_query', {
        connection: harness.connection,
        sql: `SELECT ID FROM ${TABLE} ORDER BY ID`,
        limit: 1,
      })
      assert.equal(limited.rowCount, 1)
      assert.equal(limited.truncated, true)

      const all = await call(harness, 'firebird_query', {
        connection: harness.connection,
        sql: `SELECT ID, NAME FROM ${TABLE} ORDER BY ID`,
      })
      assert.equal(all.rowCount, 2)
      assert.equal(all.rows[1].NAME, 'beta-updated')
    })

    it('calls stored procedures, applies GRANT/REVOKE and audits every call', async () => {
      await call(harness, 'firebird_create', {
        connection: harness.connection,
        sql: PROCEDURE_SQL,
        confirmDDL: true,
      })

      const procedures = await call(harness, 'firebird_list_objects', {
        connection: harness.connection,
        type: 'procedure',
        filter: PROCEDURE,
      })
      assert.equal(procedures.objects.some((object) => object.name === PROCEDURE), true)

      const described = await call(harness, 'firebird_describe_object', {
        connection: harness.connection,
        name: PROCEDURE,
        type: 'procedure',
      })
      assert.deepEqual(described.parameters.input.map((parameter) => parameter.name), ['X'])
      assert.deepEqual(described.parameters.output.map((parameter) => parameter.name), ['Y'])

      const called = await call(harness, 'firebird_call_procedure', {
        connection: harness.connection,
        procedure: PROCEDURE,
        params: [21],
      })
      assert.equal(called.mode, 'select')
      assert.equal(called.executed, true)
      assert.equal(called.rows.length, 1)
      assert.equal(called.rows[0].Y, 42)

      const preview = await call(harness, 'firebird_grant', {
        connection: harness.connection,
        privileges: ['SELECT'],
        objectType: 'table',
        object: TABLE,
        grantee: 'PUBLIC',
      })
      assert.equal(preview.executed, false)
      assert.equal(preview.sql, `GRANT SELECT ON TABLE ${TABLE} TO PUBLIC`)
      assert.equal(preview.confirmationToken.length > 20, true)

      const granted = await call(harness, 'firebird_grant', {
        connection: harness.connection,
        privileges: ['SELECT'],
        objectType: 'table',
        object: TABLE,
        grantee: 'PUBLIC',
        confirmPrivilege: true,
        confirmationToken: preview.confirmationToken,
      })
      assert.equal(granted.executed, true)
      assert.equal(granted.affectedRows >= 0, true)

      const revokePreview = await call(harness, 'firebird_revoke', {
        connection: harness.connection,
        privileges: ['SELECT'],
        objectType: 'table',
        object: TABLE,
        grantee: 'PUBLIC',
      })
      assert.equal(revokePreview.sql, `REVOKE SELECT ON TABLE ${TABLE} FROM PUBLIC`)

      const revoked = await call(harness, 'firebird_revoke', {
        connection: harness.connection,
        privileges: ['SELECT'],
        objectType: 'table',
        object: TABLE,
        grantee: 'PUBLIC',
        confirmPrivilege: true,
        confirmationToken: revokePreview.confirmationToken,
      })
      assert.equal(revoked.executed, true)

      await assert.rejects(
        () => call(harness, 'firebird_query', {
          connection: harness.connection,
          sql: `DELETE FROM ${TABLE}`,
        }),
        (error) => error.code === 'NOT_A_QUERY',
      )

      const lines = readFileSync(harness.auditFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
      assert.equal(lines.length > 10, true)
      for (const entry of lines) {
        assert.equal(typeof entry.timestamp, 'string')
        assert.equal(typeof entry.tool, 'string')
        assert.equal(typeof entry.status, 'string')
        assert.equal(typeof entry.durationMs, 'number')
        assert.match(entry.sqlHash, /^sha256:[0-9a-f]{64}$/)
      }
      assert.equal(lines.some((entry) => entry.tool === 'firebird_grant' && entry.status === 'success'), true)
      assert.equal(lines.some((entry) => entry.tool === 'firebird_query' && entry.status === 'denied'), true)
      assert.equal(JSON.stringify(lines).includes('masterkey'), false)
      assert.equal(JSON.stringify(lines).includes(preview.confirmationToken), false)
    })
  })
}
