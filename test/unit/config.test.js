import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  describeConnection,
  loadConfig,
  parseDsn,
  resolveCredentials,
  resolveSecret,
} from '../../src/config.js'

const audit = { file: resolve(process.cwd(), '.tmp-test', 'firebird-audit.jsonl') }

function baseConfig(connection = {}) {
  return {
    audit,
    connections: {
      dev: {
        dsn: 'firebird://localhost:3050/tmp/app.fdb',
        accessMode: 'readonly',
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        ...connection,
      },
    },
  }
}

test('loads a DSN connection with defaults', () => {
  const config = loadConfig(baseConfig())
  const connection = config.connections.dev
  assert.equal(connection.host, 'localhost')
  assert.equal(connection.port, 3050)
  assert.equal(connection.database, '/tmp/app.fdb')
  assert.equal(connection.charset, 'UTF8')
  assert.equal(connection.dialect, 3)
  assert.equal(connection.effectiveDialect, 3)
  assert.equal(connection.authPlugin, 'auto')
  assert.equal(connection.wireCrypt, false)
  assert.equal(connection.idleTimeoutMs, 300_000)
  assert.equal(connection.connectTimeoutMs, 10_000)
  assert.equal(connection.queryTimeoutMs, 30_000)
  assert.equal(connection.ddlTimeoutMs, 60_000)
  assert.equal(connection.maxRows, 500)
  assert.equal(connection.allowRoleSwitch, false)
  assert.equal(connection.allowUnrestrictedDML, false)
  assert.equal(connection.allowSystemTables, false)
  assert.deepEqual(connection.credentials.user, { kind: 'env', name: 'FB_USER' })
  assert.deepEqual(config.connectionNames, ['dev'])
})

test('normalizes host/port/database and per-connection flags', () => {
  const config = loadConfig({
    audit,
    connections: {
      prod: {
        host: '[::1]',
        port: 3051,
        database: '/data/prod.fdb',
        accessMode: 'ADMIN',
        charset: ' win1252 ',
        dialect: 1,
        authPlugin: 'legacy_auth',
        wireCrypt: true,
        userEnv: 'FB_USER',
        passwordEnv: 'FB_PASSWORD',
        role: 'APP_ROLE',
        allowRoleSwitch: true,
        allowUnrestrictedDML: true,
        allowSystemTables: true,
        maxRows: 1000,
        idleTimeoutSeconds: 0,
      },
    },
  })
  const connection = config.connections.prod
  assert.equal(connection.host, '::1')
  assert.equal(connection.port, 3051)
  assert.equal(connection.accessMode, 'admin')
  assert.equal(connection.charset, 'WIN1252')
  assert.equal(connection.dialect, 1)
  assert.equal(connection.effectiveDialect, 3)
  assert.equal(connection.authPlugin, 'Legacy_Auth')
  assert.equal(connection.wireCrypt, true)
  assert.equal(connection.role, 'APP_ROLE')
  assert.equal(connection.allowRoleSwitch, true)
  assert.equal(connection.allowUnrestrictedDML, true)
  assert.equal(connection.allowSystemTables, true)
  assert.equal(connection.idleTimeoutMs, 0)
})

test('deduplicates allowedObjects case-insensitively and rejects wildcards', () => {
  const config = loadConfig(baseConfig({ allowedObjects: ['T', 't', 'APP.X', ' app.x '] }))
  assert.deepEqual(config.connections.dev.allowedObjects, ['T', 'APP.X'])
  assert.throws(() => loadConfig(baseConfig({ allowedObjects: ['T*'] })), /wildcards/)
  assert.throws(() => loadConfig(baseConfig({ allowedObjects: 'T' })), /array/)
  assert.throws(() => loadConfig(baseConfig({ allowedObjects: [''] })), /non-empty/)
})

test('requires accessMode and rejects plaintext credentials and unknown keys', () => {
  const missingMode = baseConfig()
  delete missingMode.connections.dev.accessMode
  assert.throws(() => loadConfig(missingMode), /accessMode/)

  assert.throws(() => loadConfig(baseConfig({ accessMode: 'write' })), /readonly, readwrite or admin/)
  assert.throws(() => loadConfig(baseConfig({ password: 'secret' })), /plaintext credentials/)
  assert.throws(() => loadConfig(baseConfig({ user: 'SYSDBA' })), /plaintext credentials/)
  assert.throws(() => loadConfig(baseConfig({ unknown: true })), /unknown configuration key/)
  assert.throws(() => loadConfig({ audit, connections: {} }), /at least one/)
  assert.throws(() => loadConfig({ audit, connections: { 'bad name': baseConfig().connections.dev } }), /connection names/)
  assert.throws(
    () => loadConfig(baseConfig({ userEnv: 'FB_USER', userRef: 'fb/user' })),
    /only one of/,
  )
})

test('normalizes authentication plugin names and requires boolean wireCrypt', () => {
  assert.equal(loadConfig(baseConfig({ authPlugin: 'srp' })).connections.dev.authPlugin, 'Srp')
  assert.equal(loadConfig(baseConfig({ authPlugin: 'Srp512' })).connections.dev.authPlugin, 'Srp512')
  assert.equal(loadConfig(baseConfig({ wireCrypt: false })).connections.dev.wireCrypt, false)
  assert.throws(() => loadConfig(baseConfig({ authPlugin: 'md5' })), /auto, Srp/)
  assert.throws(() => loadConfig(baseConfig({ authPlugin: 3 })), /auto, Srp/)
  assert.throws(() => loadConfig(baseConfig({ wireCrypt: 'yes' })), /true or false/)
})

test('rejects conflicting and out-of-range connection settings', () => {
  assert.throws(
    () => loadConfig(baseConfig({ host: 'localhost', database: '/tmp/x.fdb' })),
    /either dsn or/,
  )
  assert.throws(() => loadConfig(baseConfig({ charset: 'UTF-8!' })), /character set/)
  assert.throws(() => loadConfig(baseConfig({ dialect: 2 })), /must be 1 or 3/)
  assert.throws(
    () => loadConfig(baseConfig({ dsn: undefined, database: '/tmp/x.fdb', port: 70000 })),
    /between 1 and 65535/,
  )
  assert.throws(() => loadConfig(baseConfig({ maxRows: 5001 })), /between 1 and 5000/)
  assert.throws(() => loadConfig(baseConfig({ queryTimeoutSeconds: 0 })), /between 1 and 600/)
  assert.throws(() => loadConfig({ audit: { file: 'relative/audit.jsonl' }, connections: baseConfig().connections }), /absolute path/)
})

test('parses the supported DSN forms', () => {
  assert.deepEqual(parseDsn('firebird://db.example:3051//data/app.fdb'), {
    host: 'db.example',
    port: 3051,
    database: '/data/app.fdb',
  })
  assert.deepEqual(parseDsn('inet://localhost/app'), {
    host: 'localhost',
    port: undefined,
    database: 'app',
  })
  assert.deepEqual(parseDsn('jdbc:firebirdsql://localhost:3050/C:/db/app.fdb'), {
    host: 'localhost',
    port: 3050,
    database: 'C:/db/app.fdb',
  })
  assert.deepEqual(parseDsn('localhost/3051:C:\\db\\app.fdb'), {
    host: 'localhost',
    port: 3051,
    database: 'C:\\db\\app.fdb',
  })
  assert.deepEqual(parseDsn('[::1]/3050:/data/app.fdb'), {
    host: '::1',
    port: 3050,
    database: '/data/app.fdb',
  })
  assert.deepEqual(parseDsn('C:\\db\\app.fdb'), {
    host: undefined,
    port: undefined,
    database: 'C:\\db\\app.fdb',
  })
})

test('rejects unsafe or unsupported DSNs', () => {
  assert.throws(() => parseDsn(''), /must not be empty/)
  assert.throws(() => parseDsn('mysql://host/db'), /Unsupported DSN scheme/)
  assert.throws(() => parseDsn('firebird://user:pass@host/db'), /must not contain credentials/)
  assert.throws(() => parseDsn('firebird://host/db?charset=UTF8'), /query parameters/)
  assert.throws(() => parseDsn('firebird://host/db#fragment'), /fragment/)
  assert.throws(() => parseDsn('firebird://host'), /database path/)
  assert.throws(() => parseDsn(':db'), /empty host/)
  assert.throws(() => parseDsn('host/not-a-port:db'), /port must be numeric/)
})

test('resolves credentials from environment variables and credential references', async () => {
  const config = loadConfig(baseConfig())
  const connection = config.connections.dev
  const env = { FB_USER: 'SYSDBA', FB_PASSWORD: 'masterkey' }
  assert.deepEqual(await resolveCredentials(connection, undefined, env), {
    user: 'SYSDBA',
    password: 'masterkey',
  })

  const refConfig = loadConfig(baseConfig({
    userEnv: undefined,
    passwordEnv: undefined,
    userRef: 'firebird/dev-user',
    passwordRef: 'firebird/dev-password',
  }))
  const credentials = {
    async resolve(name) {
      return { value: name.endsWith('user') ? 'APP' : 'app-secret' }
    },
  }
  assert.deepEqual(await resolveCredentials(refConfig.connections.dev, credentials, {}), {
    user: 'APP',
    password: 'app-secret',
  })

  await assert.rejects(
    () => resolveCredentials(connection, undefined, {}),
    /FB_USER.*is not set|Environment variable/,
  )
  await assert.rejects(
    () => resolveCredentials(refConfig.connections.dev, undefined, {}),
    /requires the dsh credentials service/,
  )
  await assert.rejects(
    () => resolveSecret({ kind: 'ref', name: 'missing' }, { async resolve() { return null } }, 'user password', {}),
    /is not configured/,
  )
})

test('describeConnection exposes only safe connection facts', () => {
  const config = loadConfig(baseConfig({ allowedObjects: ['T'] }))
  const safe = describeConnection(config.connections.dev)
  assert.equal(safe.name, 'dev')
  assert.equal(safe.accessMode, 'readonly')
  assert.equal(safe.authPlugin, 'auto')
  assert.equal(safe.wireCrypt, false)
  assert.deepEqual(safe.allowedObjects, ['T'])
  assert.deepEqual(safe.userSource, { kind: 'env', name: 'FB_USER' })
  assert.deepEqual(safe.passwordSource, { kind: 'env', name: 'FB_PASSWORD' })
  assert.equal(Object.hasOwn(safe, 'credentials'), false)
  assert.equal(Object.hasOwn(safe, 'password'), false)
})
