import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describeConnection, resolveCredentials } from './config.js'
import { FirebirdToolError, denied, safeErrorMessage } from './errors.js'

const DEFAULT_WORKER = fileURLToPath(new URL('../driver/worker.mjs', import.meta.url))
const CLOSE_TIMEOUT = 5000

class WorkerClient {
  constructor({ workerPath, execPath, cwd, log, redact, onExit }) {
    this.workerPath = workerPath
    this.execPath = execPath
    this.cwd = cwd
    this.log = log
    this.redact = redact
    this.onExit = onExit
    this.child = null
    this.rl = null
    this.pending = new Map()
    this.nextId = 1
    this.alive = false
    this.lastError = null
  }

  start() {
    if (this.child) return
    try {
      this.child = spawn(this.execPath, [this.workerPath], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new FirebirdToolError(`Cannot start Firebird driver worker: ${error.message}`, {
        code: 'WORKER_START_FAILED',
      })
    }
    this.alive = true
    this.lastError = null
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (chunk) => {
      const text = this.redact(String(chunk)).trim()
      if (text) {
        this.lastError = text.slice(0, 2000)
        this.log.debug(`driver worker: ${text.slice(0, 500)}`)
      }
    })
    this.child.on('error', (error) => {
      this.lastError = this.redact(error.message)
      this.kill()
    })
    this.child.on('exit', (code, signal) => {
      const wasAlive = this.alive
      this.alive = false
      this.child = null
      this.rl?.close()
      this.rl = null
      const detail = this.lastError ? `: ${this.lastError}` : ''
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this.failPending(new FirebirdToolError(
        `Firebird driver worker exited (${reason})${detail}`,
        { code: 'WORKER_EXITED' },
      ))
      if (wasAlive && this.onExit) this.onExit()
    })
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    const error = message.error ?? {}
    pending.reject(new FirebirdToolError(
      typeof error.message === 'string' ? error.message : 'Firebird driver error',
      {
        code: typeof error.code === 'string' ? error.code : 'FIREBIRD_ERROR',
        details: {
          gdscode: error.gdscode,
          sqlState: error.sqlState,
          driver: error.name,
        },
      },
    ))
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  request(op, payload, timeoutMs) {
    this.start()
    if (!this.alive || !this.child) {
      throw new FirebirdToolError('Firebird driver worker is not running', { code: 'WORKER_EXITED' })
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new FirebirdToolError(
          `Firebird ${op} operation timed out after ${timeoutMs} ms; the driver worker was recycled`,
          { code: 'TIMEOUT' },
        )
        reject(error)
        this.kill()
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new FirebirdToolError(`Cannot write to the driver worker: ${error.message}`, {
          code: 'WORKER_WRITE_FAILED',
        }))
        this.kill()
      }
    })
  }

  kill() {
    const child = this.child
    this.alive = false
    if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Exit handling will surface the failure to pending requests.
      }
    }
  }

  stop() {
    this.kill()
  }
}

/**
 * Owns lazy named connections, per-connection serialization, timeouts, idle
 * auto-close and worker recycling. Credentials are resolved on every open and
 * are only sent over the private worker pipe.
 */
export class ConnectionManager {
  constructor({
    config,
    credentials,
    audit,
    log,
    workerPath = DEFAULT_WORKER,
    execPath = process.execPath,
    cwd,
  }) {
    this.config = config
    this.credentials = credentials
    this.audit = audit
    this.log = log
    this.states = new Map()
    this.disposed = false
    for (const name of config.connectionNames) {
      const connection = config.connections[name]
      this.states.set(name, {
        opened: false,
        busy: 0,
        activeRole: connection.role ?? null,
        serverVersion: null,
        timer: null,
        queue: Promise.resolve(),
      })
    }
    this.client = new WorkerClient({
      workerPath,
      execPath,
      cwd,
      log,
      redact: (value) => audit.redact(value),
      onExit: () => this.handleWorkerExit(),
    })
  }

  handleWorkerExit() {
    for (const state of this.states.values()) {
      state.opened = false
      state.busy = 0
      state.serverVersion = null
      this.clearIdle(state)
    }
  }

  clearIdle(state) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  enqueue(state, task) {
    const run = state.queue.then(task, task)
    state.queue = run.then(() => undefined, () => undefined)
    return run
  }

  connectionOrThrow(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw denied('A connection name is required', 'UNKNOWN_CONNECTION')
    }
    const connection = this.config.connections[name]
    if (!connection) {
      throw denied(`Unknown Firebird connection "${name}"`, 'UNKNOWN_CONNECTION')
    }
    return connection
  }

  async attachConfig(connection, state, role) {
    const credentials = await resolveCredentials(connection, this.credentials)
    this.audit.addSecret(credentials.password)
    return {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      charset: connection.charset,
      authPlugin: connection.authPlugin,
      wireCrypt: connection.wireCrypt,
      user: credentials.user,
      password: credentials.password,
      role: role ?? undefined,
    }
  }

  async ensureOpen(connection, state) {
    if (state.opened) return state
    const config = await this.attachConfig(connection, state, state.activeRole)
    const result = await this.client.request('open', {
      connection: connection.name,
      config,
    }, connection.connectTimeoutMs)
    state.opened = true
    state.serverVersion = result?.serverVersion ?? null
    this.log.debug(`opened connection ${connection.name}`)
    return state
  }

  scheduleIdle(connection, state) {
    this.clearIdle(state)
    if (!state.opened || connection.idleTimeoutMs <= 0 || this.disposed) return
    state.timer = setTimeout(() => {
      state.timer = null
      this.enqueue(state, async () => {
        if (!state.opened) return
        try {
          if (this.client.alive) {
            await this.client.request('close', { connection: connection.name }, CLOSE_TIMEOUT)
          }
        } catch (error) {
          this.log.warn(`idle close of ${connection.name} failed: ${safeErrorMessage(error)}`)
        } finally {
          state.opened = false
          state.serverVersion = null
          this.log.debug(`closed idle connection ${connection.name}`)
        }
      }).catch(() => {})
    }, connection.idleTimeoutMs)
    state.timer.unref?.()
  }

  async runExclusive(connection, state, task) {
    this.clearIdle(state)
    state.busy += 1
    try {
      await this.ensureOpen(connection, state)
      return await task(state)
    } finally {
      state.busy = Math.max(0, state.busy - 1)
      this.scheduleIdle(connection, state)
    }
  }

  withConnection(name, task) {
    if (this.disposed) {
      return Promise.reject(new FirebirdToolError('Firebird connector is shutting down', { code: 'DISPOSED' }))
    }
    const connection = this.connectionOrThrow(name)
    const state = this.states.get(name)
    return this.enqueue(state, () => this.runExclusive(connection, state, task))
  }

  query(name, sql, params) {
    const connection = this.connectionOrThrow(name)
    return this.withConnection(name, () => this.client.request('query', {
      connection: name,
      sql,
      params,
    }, connection.queryTimeoutMs))
  }

  execute(name, sql, params) {
    const connection = this.connectionOrThrow(name)
    return this.withConnection(name, () => this.client.request('execute', {
      connection: name,
      sql,
      params,
    }, connection.queryTimeoutMs))
  }

  call(name, sql, params) {
    const connection = this.connectionOrThrow(name)
    return this.withConnection(name, () => this.client.request('call', {
      connection: name,
      sql,
      params,
    }, connection.queryTimeoutMs))
  }

  ddl(name, sql) {
    const connection = this.connectionOrThrow(name)
    return this.withConnection(name, () => this.client.request('ddl', {
      connection: name,
      sql,
      params: [],
    }, connection.ddlTimeoutMs))
  }

  batchQuery(name, queries) {
    const connection = this.connectionOrThrow(name)
    return this.withConnection(name, () => this.client.request('batchQuery', {
      connection: name,
      queries,
    }, connection.queryTimeoutMs))
  }

  async getServerVersion(name) {
    const connection = this.connectionOrThrow(name)
    const state = this.states.get(name)
    return this.withConnection(name, () => state.serverVersion)
  }

  setRole(name, role) {
    const connection = this.connectionOrThrow(name)
    const state = this.states.get(name)
    if (this.disposed) {
      return Promise.reject(new FirebirdToolError('Firebird connector is shutting down', { code: 'DISPOSED' }))
    }
    return this.enqueue(state, async () => {
      this.clearIdle(state)
      try {
        const config = await this.attachConfig(connection, state, role)
        const result = await this.client.request('setRole', {
          connection: name,
          config,
        }, connection.connectTimeoutMs)
        state.opened = true
        state.activeRole = role ?? null
        state.serverVersion = result?.serverVersion ?? null
        return { role: state.activeRole, serverVersion: state.serverVersion }
      } catch (error) {
        state.opened = false
        state.serverVersion = null
        throw error
      } finally {
        this.scheduleIdle(connection, state)
      }
    })
  }

  async close(name) {
    const connection = this.connectionOrThrow(name)
    const state = this.states.get(name)
    return this.enqueue(state, async () => {
      this.clearIdle(state)
      if (!state.opened && !this.client.alive) return { closed: false }
      try {
        await this.client.request('close', { connection: name, force: true }, CLOSE_TIMEOUT)
      } finally {
        state.opened = false
        state.serverVersion = null
      }
      return { closed: true }
    })
  }

  describe(name) {
    const connection = this.connectionOrThrow(name)
    const state = this.states.get(name)
    return {
      ...describeConnection(connection),
      open: state.opened,
      activeRole: state.activeRole,
      serverVersion: state.serverVersion,
      configuredDialect: connection.dialect,
      effectiveDialect: connection.effectiveDialect,
    }
  }

  list() {
    return this.config.connectionNames.map((name) => this.describe(name))
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) this.clearIdle(state)
    if (!this.client.alive) return
    try {
      await this.client.request('shutdown', {}, CLOSE_TIMEOUT)
    } catch {
      // The worker may already be gone; kill below is the backstop.
    }
    this.client.stop()
  }
}
