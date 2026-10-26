import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { ConfigError } from './errors.js'

const ACCESS_MODES = new Set(['readonly', 'readwrite', 'admin'])
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/
const CONNECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const CHARSET_NAME = /^[A-Z][A-Z0-9_]{0,30}$/
const PLAINTEXT_KEYS = new Set(['user', 'username', 'password', 'passwd', 'pwd'])
const AUTH_PLUGINS = new Map([
  ['auto', 'auto'],
  ['srp', 'Srp'],
  ['srp256', 'Srp256'],
  ['srp384', 'Srp384'],
  ['srp512', 'Srp512'],
  ['legacy_auth', 'Legacy_Auth'],
])

const ROOT_KEYS = new Set(['connections', 'logLevel', 'audit'])
const AUDIT_KEYS = new Set(['file'])
const CONNECTION_KEYS = new Set([
  'dsn', 'host', 'port', 'database',
  'userEnv', 'userRef', 'passwordEnv', 'passwordRef',
  'charset', 'dialect', 'accessMode', 'allowedObjects', 'role',
  'authPlugin', 'wireCrypt',
  'allowRoleSwitch', 'allowUnrestrictedDML', 'allowSystemTables',
  'idleTimeoutSeconds', 'connectTimeoutSeconds', 'queryTimeoutSeconds',
  'ddlTimeoutSeconds', 'maxRows',
])

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3050,
  charset: 'UTF8',
  dialect: 3,
  authPlugin: 'auto',
  wireCrypt: false,
  idleTimeoutSeconds: 300,
  connectTimeoutSeconds: 10,
  queryTimeoutSeconds: 30,
  ddlTimeoutSeconds: 60,
  maxRows: 500,
}

function fail(path, message) {
  throw new ConfigError(`${path}: ${message}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertObject(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be a mapping')
  return value
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (PLAINTEXT_KEYS.has(key)) {
      fail(
        `${path}.${key}`,
        'plaintext credentials are forbidden; use userEnv/userRef and passwordEnv/passwordRef',
      )
    }
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown configuration key')
  }
}

function positiveNumber(value, path, { min, max, fallback, integer = true }) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    fail(path, `must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`)
  }
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}`)
  return value
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, 'must be true or false')
  return value
}

function normalizeAuthPlugin(value, path) {
  if (value === undefined) return DEFAULTS.authPlugin
  if (typeof value !== 'string') {
    fail(`${path}.authPlugin`, 'must be auto, Srp, Srp256, Srp384, Srp512 or Legacy_Auth')
  }
  const normalized = AUTH_PLUGINS.get(value.trim().toLowerCase())
  if (!normalized) {
    fail(`${path}.authPlugin`, 'must be auto, Srp, Srp256, Srp384, Srp512 or Legacy_Auth')
  }
  return normalized
}

function optionalString(value, path, maxLength = 1024) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string')
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`)
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(path, 'must not contain control characters')
  return value
}

function credentialSource(raw, kind, path) {
  const envKey = `${kind}Env`
  const refKey = `${kind}Ref`
  const envName = raw[envKey]
  const refName = raw[refKey]
  if (envName !== undefined && refName !== undefined) {
    fail(`${path}.${kind}`, `set only one of ${envKey} or ${refKey}`)
  }
  if (envName === undefined && refName === undefined) {
    fail(
      `${path}.${kind}`,
      `is required as an environment variable name (${envKey}) or credential reference (${refKey}); ` +
      'plaintext credentials are forbidden',
    )
  }
  const sourceKind = envName !== undefined ? 'env' : 'ref'
  const name = envName !== undefined ? envName : refName
  const valid = typeof name === 'string'
    && (sourceKind === 'env' ? ENV_NAME.test(name) : CREDENTIAL_REF.test(name))
  if (!valid) {
    fail(
      `${path}.${sourceKind === 'env' ? envKey : refKey}`,
      sourceKind === 'env'
        ? 'must be a POSIX-style environment variable name'
        : 'must be a credential reference name (letters, digits, "_", ".", ":", "/" or "-")',
    )
  }
  return { kind: sourceKind, name }
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function normalizeAudit(raw, path) {
  const audit = raw === undefined ? {} : assertObject(raw, path)
  assertKnownKeys(audit, AUDIT_KEYS, path)
  const file = audit.file === undefined
    ? join(homedir(), '.dsh', 'firebird', 'audit.jsonl')
    : optionalString(audit.file, `${path}.file`, 4096)
  const expanded = expandHome(file)
  if (!isAbsolute(expanded)) fail(`${path}.file`, 'must be an absolute path (or start with ~)')
  return { file: resolvePath(expanded) }
}

function decodeUriPath(pathname) {
  let database
  try {
    database = decodeURIComponent(pathname || '')
  } catch {
    throw new ConfigError('DSN contains malformed percent-encoding')
  }
  if (database.startsWith('/')) database = database.slice(1)
  if (database.includes('/') && !database.startsWith('/') && !/^[A-Za-z]:\//.test(database)) {
    database = `/${database}`
  }
  return database
}

/**
 * Parse the DSN forms node-firebird accepts: firebird://, inet://, inet4://,
 * inet6://, the JDBC prefix, or traditional [host[/port]:]database strings.
 * Credentials and driver options are rejected so the plugin config stays the
 * single source of connection settings.
 */
export function parseDsn(raw) {
  let dsn = String(raw).trim()
  if (!dsn) throw new ConfigError('DSN must not be empty')
  if (/^jdbc:firebirdsql:/i.test(dsn)) {
    dsn = dsn.replace(/^jdbc:firebirdsql:/i, '')
    if (!/^\/\//.test(dsn)) throw new ConfigError('JDBC DSN must use jdbc:firebirdsql://host[:port]/database')
    dsn = `inet:${dsn}`
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(dsn)) {
    const scheme = dsn.slice(0, dsn.indexOf('://')).toLowerCase()
    if (!['firebird', 'inet', 'inet4', 'inet6'].includes(scheme)) {
      throw new ConfigError(`Unsupported DSN scheme "${scheme}" (use firebird://, inet://, inet4:// or inet6://)`)
    }
    let url
    try {
      url = new URL(dsn)
    } catch {
      throw new ConfigError('Invalid DSN URI')
    }
    if (url.username || url.password) {
      throw new ConfigError('DSN must not contain credentials; use userEnv/userRef and passwordEnv/passwordRef')
    }
    if (url.searchParams.size > 0) {
      throw new ConfigError('DSN query parameters are not allowed; configure charset/role/timeouts in plugin config')
    }
    if (url.hash) throw new ConfigError('DSN must not contain a fragment')
    const database = decodeUriPath(url.pathname)
    if (!database) throw new ConfigError('DSN must include a database path or alias')
    const host = url.hostname ? url.hostname.replace(/^\[(.*)\]$/, '$1') : undefined
    const port = url.port ? Number(url.port) : undefined
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new ConfigError('DSN port must be between 1 and 65535')
    }
    return { host, port, database }
  }

  let host
  let port
  let database = dsn
  const ipv6 = /^\[([^\]]+)\](?:\/([^:]*))?:(.*)$/.exec(dsn)
  if (ipv6) {
    host = ipv6[1]
    port = ipv6[2]
    database = ipv6[3]
  } else {
    const colon = dsn.indexOf(':')
    if (colon === 0) throw new ConfigError('Invalid DSN: empty host')
    if (colon > 1) {
      const hostPart = dsn.slice(0, colon)
      database = dsn.slice(colon + 1)
      const slash = hostPart.indexOf('/')
      if (slash !== -1) {
        host = hostPart.slice(0, slash)
        port = hostPart.slice(slash + 1)
        if (!host) throw new ConfigError('Invalid DSN: empty host')
      } else {
        host = hostPart
      }
    }
  }
  if (!database) throw new ConfigError('Invalid DSN: empty database path')
  if (host?.includes('@')) throw new ConfigError('DSN must not contain credentials')
  let normalizedPort
  if (port !== undefined) {
    if (!/^\d+$/.test(port)) throw new ConfigError('DSN port must be numeric')
    normalizedPort = Number(port)
    if (normalizedPort < 1 || normalizedPort > 65535) {
      throw new ConfigError('DSN port must be between 1 and 65535')
    }
  }
  return { host, port: normalizedPort, database }
}

function normalizeConnection(name, raw) {
  const path = `connections.${name}`
  assertObject(raw, path)
  assertKnownKeys(raw, CONNECTION_KEYS, path)

  if (raw.accessMode === undefined) {
    fail(`${path}.accessMode`, 'is required and must be readonly, readwrite or admin')
  }
  if (typeof raw.accessMode !== 'string' || !ACCESS_MODES.has(raw.accessMode.toLowerCase())) {
    fail(`${path}.accessMode`, 'must be readonly, readwrite or admin')
  }
  const accessMode = raw.accessMode.toLowerCase()

  let host
  let port
  let database
  if (raw.dsn !== undefined) {
    if (raw.host !== undefined || raw.port !== undefined || raw.database !== undefined) {
      fail(path, 'use either dsn or host/port/database, not both')
    }
    if (typeof raw.dsn !== 'string') fail(`${path}.dsn`, 'must be a string')
    const parsed = parseDsn(raw.dsn)
    host = parsed.host ?? DEFAULTS.host
    port = parsed.port ?? DEFAULTS.port
    database = parsed.database
  } else {
    database = raw.database
    if (typeof database !== 'string' || database.trim() === '') {
      fail(`${path}.database`, 'is required when dsn is not set')
    }
    if (/[\u0000-\u001f\u007f]/.test(database)) {
      fail(`${path}.database`, 'must not contain control characters')
    }
    host = raw.host === undefined ? DEFAULTS.host : optionalString(raw.host, `${path}.host`, 255)
    port = positiveNumber(raw.port, `${path}.port`, { min: 1, max: 65535, fallback: DEFAULTS.port })
  }

  host = host.replace(/^\[(.*)\]$/, '$1')
  if (!host || /[\s@/\\]/.test(host)) fail(`${path}.host`, 'must be a hostname or IP address without credentials or path')
  if (/[\u0000-\u001f\u007f]/.test(database)) fail(`${path}.database`, 'must not contain control characters')
  port = positiveNumber(port, `${path}.port`, { min: 1, max: 65535, fallback: DEFAULTS.port })

  const charset = raw.charset === undefined
    ? DEFAULTS.charset
    : String(raw.charset).trim().toUpperCase()
  if (!CHARSET_NAME.test(charset)) fail(`${path}.charset`, 'must be a Firebird character set name such as UTF8 or WIN1252')

  const dialect = positiveNumber(raw.dialect, `${path}.dialect`, { min: 1, max: 3, fallback: DEFAULTS.dialect })
  if (dialect !== 1 && dialect !== 3) fail(`${path}.dialect`, 'must be 1 or 3')

  const authPlugin = normalizeAuthPlugin(raw.authPlugin, path)
  const wireCrypt = boolean(raw.wireCrypt, `${path}.wireCrypt`, DEFAULTS.wireCrypt)

  let allowedObjects
  if (raw.allowedObjects !== undefined) {
    if (!Array.isArray(raw.allowedObjects)) fail(`${path}.allowedObjects`, 'must be an array of object names')
    if (raw.allowedObjects.length > 1000) fail(`${path}.allowedObjects`, 'must contain at most 1000 entries')
    const seen = new Set()
    allowedObjects = []
    for (let i = 0; i < raw.allowedObjects.length; i += 1) {
      const entry = raw.allowedObjects[i]
      if (typeof entry !== 'string' || entry.trim() === '') {
        fail(`${path}.allowedObjects[${i}]`, 'must be a non-empty object name')
      }
      const trimmed = entry.trim()
      if (trimmed.length > 128) fail(`${path}.allowedObjects[${i}]`, 'must be at most 128 characters')
      if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
        fail(`${path}.allowedObjects[${i}]`, 'must not contain control characters')
      }
      if (/[*?]/.test(trimmed)) fail(`${path}.allowedObjects[${i}]`, 'wildcards are not allowed')
      const key = trimmed.toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      allowedObjects.push(trimmed)
    }
  }

  let role
  if (raw.role !== undefined) {
    role = optionalString(raw.role, `${path}.role`, 63)
    if (role.includes('\u0000')) fail(`${path}.role`, 'must not contain NUL')
  }

  return {
    name,
    host,
    port,
    database,
    charset,
    dialect,
    effectiveDialect: 3,
    authPlugin,
    wireCrypt,
    accessMode,
    allowedObjects: allowedObjects ?? [],
    role,
    allowRoleSwitch: boolean(raw.allowRoleSwitch, `${path}.allowRoleSwitch`, false),
    allowUnrestrictedDML: boolean(raw.allowUnrestrictedDML, `${path}.allowUnrestrictedDML`, false),
    allowSystemTables: boolean(raw.allowSystemTables, `${path}.allowSystemTables`, false),
    idleTimeoutMs: positiveNumber(raw.idleTimeoutSeconds, `${path}.idleTimeoutSeconds`, {
      min: 0, max: 86400, fallback: DEFAULTS.idleTimeoutSeconds,
    }) * 1000,
    connectTimeoutMs: positiveNumber(raw.connectTimeoutSeconds, `${path}.connectTimeoutSeconds`, {
      min: 1, max: 300, fallback: DEFAULTS.connectTimeoutSeconds,
    }) * 1000,
    queryTimeoutMs: positiveNumber(raw.queryTimeoutSeconds, `${path}.queryTimeoutSeconds`, {
      min: 1, max: 600, fallback: DEFAULTS.queryTimeoutSeconds,
    }) * 1000,
    ddlTimeoutMs: positiveNumber(raw.ddlTimeoutSeconds, `${path}.ddlTimeoutSeconds`, {
      min: 1, max: 1800, fallback: DEFAULTS.ddlTimeoutSeconds,
    }) * 1000,
    maxRows: positiveNumber(raw.maxRows, `${path}.maxRows`, { min: 1, max: 5000, fallback: DEFAULTS.maxRows }),
    credentials: {
      user: credentialSource(raw, 'user', path),
      password: credentialSource(raw, 'password', path),
    },
  }
}

/** Validate plugin configuration and normalize every connection. */
export function loadConfig(raw) {
  const config = assertObject(raw, 'config')
  assertKnownKeys(config, ROOT_KEYS, 'config')
  if (config.connections === undefined) fail('config.connections', 'is required')
  assertObject(config.connections, 'config.connections')
  const names = Object.keys(config.connections)
  if (names.length === 0) fail('config.connections', 'must contain at least one named connection')

  const connections = Object.create(null)
  for (const name of names) {
    if (!CONNECTION_NAME.test(name)) {
      fail(
        `config.connections.${name}`,
        'connection names must start with a letter and contain only letters, digits, "_" or "-" (max 64)',
      )
    }
    connections[name] = normalizeConnection(name, config.connections[name])
  }

  let logLevel = config.logLevel ?? 'info'
  if (typeof logLevel !== 'string' || !LOG_LEVELS.has(logLevel.toLowerCase())) {
    fail('config.logLevel', 'must be silent, error, warn, info or debug')
  }
  logLevel = logLevel.toLowerCase()

  return {
    connections,
    connectionNames: names,
    logLevel,
    auditFile: normalizeAudit(config.audit, 'config.audit').file,
  }
}

async function resolveSource(source, credentials, label, env) {
  if (source.kind === 'env') {
    const value = env[source.name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError(
        `Environment variable ${source.name} for the Firebird ${label} is not set (connection credentials are resolved when connecting)`,
      )
    }
    if (value.includes('\u0000')) throw new ConfigError(`Environment variable ${source.name} contains NUL`)
    return value
  }
  if (!credentials || typeof credentials.resolve !== 'function') {
    throw new ConfigError(
      `Credential reference ${source.name} for the Firebird ${label} requires the dsh credentials service`,
    )
  }
  let resolved
  try {
    resolved = await credentials.resolve(source.name)
  } catch {
    throw new ConfigError(`Failed to resolve credential reference ${source.name} for the Firebird ${label}`)
  }
  if (!resolved || typeof resolved.value !== 'string' || resolved.value.length === 0) {
    throw new ConfigError(`Credential reference ${source.name} for the Firebird ${label} is not configured`)
  }
  if (resolved.value.includes('\u0000')) {
    throw new ConfigError(`Credential reference ${source.name} for the Firebird ${label} contains NUL`)
  }
  return resolved.value
}

/**
 * Resolve one ad-hoc secret (for example a user-management password) from an
 * environment variable or credential reference. The value is returned to the
 * caller only and must be registered with the audit redactor before use.
 */
export async function resolveSecret(source, credentials, label, env = process.env) {
  return resolveSource(source, credentials, label, env)
}

/**
 * Resolve credentials for one connection operation. Values are returned to the
 * caller only, are never stored in the normalized config and must not be
 * logged; callers should drop the reference as soon as the worker has attached.
 */
export async function resolveCredentials(connection, credentials, env = process.env) {
  const [user, password] = await Promise.all([
    resolveSource(connection.credentials.user, credentials, 'user', env),
    resolveSource(connection.credentials.password, credentials, 'password', env),
  ])
  return { user, password }
}

/** Safe connection facts for tool output; credential values are never included. */
export function describeConnection(connection) {
  return {
    name: connection.name,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    charset: connection.charset,
    dialect: connection.dialect,
    effectiveDialect: connection.effectiveDialect,
    authPlugin: connection.authPlugin,
    wireCrypt: connection.wireCrypt,
    accessMode: connection.accessMode,
    allowedObjects: [...connection.allowedObjects],
    role: connection.role ?? null,
    allowRoleSwitch: connection.allowRoleSwitch,
    allowUnrestrictedDML: connection.allowUnrestrictedDML,
    allowSystemTables: connection.allowSystemTables,
    userSource: connection.credentials.user,
    passwordSource: connection.credentials.password,
    idleTimeoutMs: connection.idleTimeoutMs,
    maxRows: connection.maxRows,
  }
}
