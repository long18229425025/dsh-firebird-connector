export class FirebirdToolError extends Error {
  constructor(message, { code = 'FIREBIRD_ERROR', status = 'error', details } = {}) {
    super(message)
    this.name = 'FirebirdToolError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FirebirdConfigError'
    this.code = 'CONFIG_INVALID'
  }
}

export function denied(message, code = 'DENIED') {
  return new FirebirdToolError(message, { code, status: 'denied' })
}

export function invalid(message, code = 'INVALID_SQL') {
  return new FirebirdToolError(message, { code, status: 'denied' })
}

export function isDenied(error) {
  return error instanceof FirebirdToolError
    ? error.status === 'denied'
    : error?.status === 'denied'
}

export function safeErrorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}
