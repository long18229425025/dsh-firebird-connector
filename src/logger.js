const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 }

/** Small severity-gated logger; callers pass already-safe strings. */
export function createLogger(ctx, level, redact = (value) => value) {
  const threshold = LEVELS[level] ?? LEVELS.info
  let sink
  try {
    sink = typeof ctx?.logger === 'function' ? ctx.logger('firebird-connector') : undefined
  } catch {
    sink = undefined
  }
  const emit = (method, message) => {
    if (threshold < LEVELS[method]) return
    const text = redact(String(message))
    if (sink && typeof sink[method] === 'function') {
      try {
        sink[method](text)
      } catch {
        // Logging must never turn a database operation into a failure.
      }
    } else if (method === 'error' && threshold >= LEVELS.error) {
      console.error(`[firebird-connector] ${text}`)
    }
  }
  return {
    error: (message) => emit('error', message),
    warn: (message) => emit('warn', message),
    info: (message) => emit('info', message),
    debug: (message) => emit('debug', message),
  }
}
