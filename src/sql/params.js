import { tokenize } from './tokenize.js'
import { denied, invalid } from '../errors.js'

function paramError(message, code) {
  return invalid(message, code)
}

function isPlainParamsObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !Buffer.isBuffer(value)
    && !(value instanceof Date)
}

function assertBindable(value, label) {
  if (value === undefined) {
    throw paramError(`Missing value for parameter ${label}`, 'PARAM_MISSING')
  }
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean' || type === 'bigint') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw paramError(`Parameter ${label} must be a finite number`, 'PARAM_INVALID')
    }
    return value
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw paramError(`Parameter ${label} is an invalid Date`, 'PARAM_INVALID')
    }
    return value
  }
  if (Buffer.isBuffer(value)) return value
  throw paramError(
    `Parameter ${label} must be a scalar value (null, string, number, bigint, boolean, Date or Buffer)`,
    'PARAM_INVALID',
  )
}

function lookupNamed(params, name) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return { key: name, value: params[name] }
  const prefixed = `:${name}`
  if (Object.prototype.hasOwnProperty.call(params, prefixed)) {
    return { key: prefixed, value: params[prefixed] }
  }
  const matches = Object.keys(params).filter((key) => key.toUpperCase() === name.toUpperCase())
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw paramError(`Parameter :${name} is ambiguous (case-insensitive matches: ${matches.join(', ')})`, 'PARAM_INVALID')
  }
  return { key: matches[0], value: params[matches[0]] }
}

/**
 * Validate and bind user values without ever interpolating them into SQL.
 * Positional `?` and named `:name` styles may not be mixed; names are
 * rewritten to the driver's positional form and values are returned in token
 * order. Unused or missing values are rejected so typos never silently shift.
 */
export function bindParameters(sql, params) {
  let tokens
  try {
    tokens = tokenize(sql)
  } catch (error) {
    throw invalid(`SQL parse error: ${error.message}`, 'SYNTAX')
  }

  const placeholders = tokens.filter((token) => token.kind === 'param')
  const positional = placeholders.filter((token) => !token.named)
  const named = placeholders.filter((token) => token.named)

  if (positional.length > 0 && named.length > 0) {
    throw paramError('Mixing positional ? and named :name parameters is not allowed', 'PARAM_MIXED')
  }

  if (placeholders.length === 0) {
    if (params === undefined || params === null) {
      return { sql, values: [], mode: 'none', names: [] }
    }
    const empty = Array.isArray(params) ? params.length === 0
      : isPlainParamsObject(params) && Object.keys(params).length === 0
    if (!empty) {
      throw paramError('Parameters were supplied but the SQL contains no placeholders', 'PARAM_UNUSED')
    }
    return { sql, values: [], mode: 'none', names: [] }
  }

  if (named.length > 0) {
    if (!isPlainParamsObject(params)) {
      throw paramError('Named :name parameters require a plain object keyed by parameter name', 'PARAM_STYLE')
    }
    const used = new Set()
    const values = []
    const names = []
    let output = ''
    let last = 0
    for (const token of placeholders) {
      const match = lookupNamed(params, token.value)
      if (!match) {
        throw paramError(`Missing value for named parameter :${token.value}`, 'PARAM_MISSING')
      }
      used.add(match.key)
      values.push(assertBindable(match.value, `:${token.value}`))
      names.push(token.value)
      output += `${sql.slice(last, token.start)}?`
      last = token.end
    }
    output += sql.slice(last)
    const unused = Object.keys(params).filter((key) => !used.has(key))
    if (unused.length > 0) {
      throw paramError(`Unused parameter(s): ${unused.join(', ')}`, 'PARAM_UNUSED')
    }
    return { sql: output, values, mode: 'named', names }
  }

  if (!Array.isArray(params)) {
    throw paramError(`Positional ? parameters require an array of ${placeholders.length} value(s)`, 'PARAM_STYLE')
  }
  if (params.length !== placeholders.length) {
    throw paramError(
      `SQL has ${placeholders.length} positional parameter(s) but ${params.length} value(s) were supplied`,
      'PARAM_COUNT',
    )
  }
  const values = params.map((value, index) => assertBindable(value, `#${index + 1}`))
  return {
    sql,
    values,
    mode: 'positional',
    names: placeholders.map((_, index) => `#${index + 1}`),
  }
}

/** DDL and generated privilege SQL cannot carry bind markers. */
export function assertNoParameters(sql) {
  let tokens
  try {
    tokens = tokenize(sql)
  } catch (error) {
    throw invalid(`SQL parse error: ${error.message}`, 'SYNTAX')
  }
  const count = tokens.filter((token) => token.kind === 'param').length
  if (count > 0) {
    throw denied('DDL and privilege statements cannot contain bind parameters', 'PARAM_FORBIDDEN')
  }
}
