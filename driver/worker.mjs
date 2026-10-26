import { createInterface } from 'node:readline'

const connections = new Map()
let driverPromise

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function serializeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    name: error?.name ?? 'Error',
    message: message.slice(0, 4000),
    code: typeof error?.code === 'string' ? error.code : undefined,
    gdscode: typeof error?.gdscode === 'number' ? error.gdscode : undefined,
    sqlState: typeof error?.sqlState === 'string'
      ? error.sqlState
      : (typeof error?.sqlstate === 'string' ? error.sqlstate : undefined),
  }
}

async function loadDriver() {
  if (!driverPromise) {
    driverPromise = import('node-firebird').then((module) => {
      const driver = module.default ?? module
      if (!driver || typeof driver.attachAsync !== 'function') {
        throw Object.assign(
          new Error('node-firebird 2.18.2 or newer is required (attachAsync is unavailable)'),
          { code: 'DRIVER_UNSUPPORTED' },
        )
      }
      return driver
    }, () => {
      throw Object.assign(
        new Error('Cannot load node-firebird; install node-firebird@^2.18.2 into the dsh profile'),
        { code: 'DRIVER_UNAVAILABLE' },
      )
    })
  }
  return driverPromise
}

function entryFor(name) {
  let entry = connections.get(name)
  if (!entry) {
    entry = { db: null, queue: Promise.resolve() }
    connections.set(name, entry)
  }
  return entry
}

function enqueue(name, task) {
  const entry = entryFor(name)
  const run = entry.queue.then(task, task)
  entry.queue = run.then(() => undefined, () => undefined)
  return run
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Buffer.isBuffer(value)) {
    return { type: 'buffer', encoding: 'base64', data: value.toString('base64'), byteLength: value.length }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const mapped = value.map((item) => sanitize(item, seen))
    seen.delete(value)
    return mapped
  }
  if (type === 'object') {
    if (seen.has(value)) return null
    seen.add(value)
    const result = {}
    for (const key of Object.keys(value)) {
      result[key] = sanitize(value[key], seen)
    }
    seen.delete(value)
    return result
  }
  return null
}

function normalizeResult(result) {
  const rows = result?.rows === undefined
    ? []
    : (Array.isArray(result.rows) ? result.rows : [result.rows])
  const fields = Array.isArray(result?.fields)
    ? result.fields.map((field) => ({
      name: field.alias ?? field.field ?? '',
      type: field.typeName ?? String(field.type ?? ''),
      nullable: typeof field.nullable === 'boolean' ? field.nullable : undefined,
    }))
    : []
  return sanitize({
    rows,
    fields,
    affectedRows: result?.affectedRows ?? 0,
    recordCounts: result?.recordCounts,
    warnings: Array.isArray(result?.warnings)
      ? result.warnings.map((warning) => warning?.message ?? String(warning))
      : [],
  })
}

async function attachDatabase(config) {
  const driver = await loadDriver()
  const options = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    encoding: config.charset,
    lowercase_keys: false,
    wireCrypt: config.wireCrypt ? 1 : 0,
  }
  if (config.role) options.role = config.role
  const plugins = !config.authPlugin || config.authPlugin === 'auto'
    ? ['Srp', 'Legacy_Auth']
    : [config.authPlugin]
  let db
  let lastError
  for (const pluginName of plugins) {
    try {
      db = await driver.attachAsync({ ...options, pluginName })
      break
    } catch (error) {
      lastError = error
      const rejected = /don't accept plugin/i.test(String(error?.message ?? error))
      if (!rejected || pluginName === plugins[plugins.length - 1]) throw error
    }
  }
  if (!db) throw lastError
  let serverVersion = null
  try {
    const rows = await db.queryAsync(
      "SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS VERSION FROM RDB$DATABASE",
    )
    serverVersion = rows?.[0]?.VERSION ?? rows?.[0]?.version ?? null
  } catch {
    serverVersion = null
  }
  return { db, serverVersion }
}

async function detach(db, force = false) {
  if (!db) return
  try {
    await db.detachAsync(force)
  } catch {
    if (!force) {
      try {
        await db.detachAsync(true)
      } catch {
        // The parent recycles the worker if a detach becomes wedged.
      }
    }
  }
}

async function handleOpen(request) {
  const entry = entryFor(request.connection)
  if (entry.db) await detach(entry.db, true)
  entry.db = null
  const { db, serverVersion } = await attachDatabase(request.config)
  entry.db = db
  return { serverVersion, effectiveDialect: 3 }
}

async function handleQuery(request, method) {
  const entry = entryFor(request.connection)
  if (!entry.db) {
    throw Object.assign(new Error('Connection is not open'), { code: 'CONNECTION_CLOSED' })
  }
  const params = request.params ?? []
  if (method === 'query') {
    const result = await entry.db.queryAsync(request.sql, params, { withMeta: true })
    return normalizeResult(result)
  }
  if (method === 'execute') {
    const result = await entry.db.withTransaction((transaction) => (
      transaction.executeAsync(request.sql, params, { withMeta: true })
    ))
    return normalizeResult(result)
  }
  if (method === 'call') {
    const result = await entry.db.withTransaction((transaction) => (
      transaction.queryAsync(request.sql, params, { withMeta: true })
    ))
    return normalizeResult(result)
  }
  if (method === 'ddl') {
    const result = await entry.db.withTransaction((transaction) => (
      transaction.executeAsync(request.sql, params, { withMeta: true })
    ))
    return normalizeResult(result)
  }
  throw Object.assign(new Error(`Unknown operation ${method}`), { code: 'BAD_OPERATION' })
}

async function handleSetRole(request) {
  const entry = entryFor(request.connection)
  if (entry.db) await detach(entry.db, true)
  entry.db = null
  const { db, serverVersion } = await attachDatabase(request.config)
  entry.db = db
  return { serverVersion, role: request.config.role ?? null, effectiveDialect: 3 }
}

async function handleClose(request) {
  const entry = connections.get(request.connection)
  if (!entry) return { closed: false }
  connections.delete(request.connection)
  await detach(entry.db, Boolean(request.force))
  return { closed: true }
}

async function handleBatchQuery(request) {
  const entry = entryFor(request.connection)
  if (!entry.db) {
    throw Object.assign(new Error('Connection is not open'), { code: 'CONNECTION_CLOSED' })
  }
  const results = {}
  for (const query of request.queries ?? []) {
    const rows = await entry.db.queryAsync(query.sql, query.params ?? [])
    results[query.key] = sanitize(rows)
  }
  return { results }
}

async function handleRequest(request) {
  switch (request.op) {
    case 'open':
      return enqueue(request.connection, () => handleOpen(request))
    case 'query':
    case 'execute':
    case 'call':
    case 'ddl':
      return enqueue(request.connection, () => handleQuery(request, request.op))
    case 'batchQuery':
      return enqueue(request.connection, () => handleBatchQuery(request))
    case 'setRole':
      return enqueue(request.connection, () => handleSetRole(request))
    case 'close':
      return enqueue(request.connection, () => handleClose(request))
    case 'ping':
      return { pong: true }
    default:
      throw Object.assign(new Error(`Unknown operation ${request.op}`), { code: 'BAD_OPERATION' })
  }
}

async function shutdown() {
  const tasks = []
  for (const entry of connections.values()) tasks.push(detach(entry.db, true))
  connections.clear()
  await Promise.allSettled(tasks)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.op === 'shutdown') {
    send({ id: request.id, ok: true, result: { closing: true } })
    Promise.resolve()
      .then(shutdown)
      .finally(() => process.exit(0))
    return
  }
  handleRequest(request).then(
    (result) => send({ id: request.id, ok: true, result }),
    (error) => send({ id: request.id, ok: false, error: serializeError(error) }),
  )
})

input.on('close', () => {
  Promise.resolve()
    .then(shutdown)
    .finally(() => process.exit(0))
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`firebird worker uncaught: ${error?.message ?? 'unknown'}\n`)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  process.stderr.write(`firebird worker rejection: ${error?.message ?? 'unknown'}\n`)
})
