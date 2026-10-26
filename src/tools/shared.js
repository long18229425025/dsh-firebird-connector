import { FirebirdToolError, denied, invalid, isDenied, safeErrorMessage } from '../errors.js'
import { findDisallowedObject, isObjectAllowed } from '../sql/analyze.js'

const IDENTIFIER_WORD = /^[A-Za-z_][A-Za-z0-9_$#]*$/
const USER_NAME = /^[A-Za-z][A-Za-z0-9_$#.-]{0,63}$/
const QUERY_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])

/**
 * dsh validates arguments before calling the tool body, so a schema violation
 * would otherwise bypass the per-operation audit. Keep the defineTool
 * definition intact and only add an audit record for that pre-body rejection.
 */
export function auditArgumentFailures(tool, audit) {
  const execute = tool.execute
  return {
    ...tool,
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (error) {
        if (error?.code === 'INVALID_ARGS') {
          try {
            audit.write({
              connection: typeof args?.connection === 'string' ? args.connection : '',
              tool: tool.name,
              sql: typeof args?.sql === 'string' ? args.sql : '',
              status: 'denied',
              durationMs: 0,
              error: safeErrorMessage(error),
              code: 'INVALID_ARGS',
            })
          } catch {
            // The validation failure remains the primary error.
          }
        }
        throw error
      }
    },
  }
}

export function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function jsonOutput(description) {
  return {
    schema: { type: 'json', description },
    render: jsonRender,
  }
}

export async function auditCall(audit, { tool, connection, sql, run }) {
  const started = Date.now()
  const currentSql = () => (typeof sql === 'function' ? sql() : (sql ?? ''))
  let value
  try {
    value = await run()
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    try {
      audit.write({
        connection: connection ?? '',
        tool,
        sql: currentSql(),
        status: isDenied(error) ? 'denied' : 'error',
        durationMs: Date.now() - started,
        error: safeErrorMessage(error),
        code,
      })
    } catch (auditError) {
      auditError.message += ` (original tool failure: ${safeErrorMessage(error)})`
      throw auditError
    }
    throw error
  }
  try {
    audit.write({
      connection: connection ?? '',
      tool,
      sql: currentSql(),
      status: 'success',
      durationMs: Date.now() - started,
    })
  } catch (auditError) {
    auditError.message += ' (the Firebird operation may have completed; verify state before retrying)'
    throw auditError
  }
  return value
}

export function connectionOrThrow(config, name) {
  const connection = config.connections[name]
  if (!connection) {
    throw denied(`Unknown Firebird connection "${name}"`, 'UNKNOWN_CONNECTION')
  }
  return connection
}

export function requireMode(connection, modes, operation) {
  if (!modes.includes(connection.accessMode)) {
    throw denied(
      `${operation} requires accessMode ${modes.join(' or ')}; connection "${connection.name}" is ${connection.accessMode}`,
      'ACCESS_DENIED',
    )
  }
}

export function assertAllowedAnalysis(analysis, connection) {
  const disallowed = findDisallowedObject(analysis, connection.allowedObjects)
  if (disallowed) {
    throw denied(
      `Object ${disallowed.display} is not listed in allowedObjects for connection "${connection.name}"`,
      'OBJECT_NOT_ALLOWED',
    )
  }
}

export function assertAllowedName(connection, name, display = name) {
  if (!isObjectAllowed({ name, schema: undefined }, connection.allowedObjects)) {
    throw denied(
      `Object ${display} is not listed in allowedObjects for connection "${connection.name}"`,
      'OBJECT_NOT_ALLOWED',
    )
  }
}

export function assertSystemTablesAllowed(analysis, connection) {
  if (analysis.writesSystemTable && !connection.allowSystemTables) {
    throw denied(
      'Writing RDB$ system tables is disabled on this connection; set allowSystemTables: true to allow it',
      'SYSTEM_TABLE_WRITE_DENIED',
    )
  }
}

export function assertReadableQuery(analysis) {
  if (analysis.kind !== 'query' && analysis.kind !== 'explain') {
    throw denied(
      'firebird_query only accepts SELECT, WITH or EXPLAIN statements; use firebird_execute for DML',
      'NOT_A_QUERY',
    )
  }
  if (analysis.kind === 'explain' && !QUERY_VERBS.has(analysis.mainVerb)) {
    throw denied('EXPLAIN must target a SELECT, INSERT, UPDATE, DELETE or MERGE statement', 'NOT_A_QUERY')
  }
  if (analysis.kind === 'query' && analysis.writeObjects.length > 0) {
    throw denied('A read-only query must not write to tables', 'NOT_A_QUERY')
  }
  for (let i = 0; i < analysis.tokens.length; i += 1) {
    const token = analysis.tokens[i]
    if (token.kind !== 'word') continue
    const next = analysis.tokens[i + 1]
    if (token.upper === 'FOR' && next?.kind === 'word' && next.upper === 'UPDATE') {
      throw denied('SELECT ... FOR UPDATE is not allowed in firebird_query; use a transaction tool instead', 'LOCK_CLAUSE')
    }
    if (token.upper === 'WITH' && next?.kind === 'word' && next.upper === 'LOCK') {
      throw denied('WITH LOCK is not allowed in firebird_query', 'LOCK_CLAUSE')
    }
  }
}

export function assertDml(analysis) {
  if (analysis.kind !== 'dml' || !QUERY_VERBS.has(analysis.mainVerb)) {
    throw denied('firebird_execute only accepts INSERT, UPDATE, DELETE or MERGE statements', 'NOT_DML')
  }
}

export function requireConfirmWrite(args) {
  if (args.confirmWrite !== true) {
    throw denied(
      'firebird_execute modifies data and requires confirmWrite: true on the same call',
      'CONFIRM_WRITE_REQUIRED',
    )
  }
}

export function requireConfirmDdl(args) {
  if (args.confirmDDL !== true) {
    throw denied(
      'DDL requires confirmDDL: true on the same call after reviewing the statement',
      'CONFIRM_DDL_REQUIRED',
    )
  }
}

export function requireDangerous(args, reasons) {
  if (args.confirmDangerous !== true) {
    throw denied(
      `Dangerous operation requires confirmDangerous: true (${reasons.join('; ')})`,
      'CONFIRM_DANGEROUS_REQUIRED',
    )
  }
}

export function chooseLimit(connection, requested) {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 5000)) {
    throw invalid('limit must be an integer between 1 and 5000', 'INVALID_LIMIT')
  }
  const desired = requested ?? connection.maxRows
  const limit = Math.min(desired, connection.maxRows)
  return { requested: desired, limit, capped: desired > limit }
}

export function applyQueryLimit(sql, analysis, limit) {
  if (analysis.explain) {
    return { sql, applied: false, wrapped: false }
  }
  const hasLimitClause = analysis.tokens.some((token) => (
    token.depth === 0
    && token.kind === 'word'
    && (token.upper === 'FIRST' || token.upper === 'ROWS' || token.upper === 'FETCH')
  ))
  const fetch = limit + 1
  if (hasLimitClause) {
    return {
      sql: `SELECT * FROM (${sql}) AS DSH_LIMIT ROWS ${fetch}`,
      applied: true,
      wrapped: true,
    }
  }
  return { sql: `${sql} ROWS ${fetch}`, applied: true, wrapped: false }
}

export function identifier(input, label = 'identifier') {
  if (typeof input !== 'string') {
    throw invalid(`${label} must be a string`, 'INVALID_IDENTIFIER')
  }
  const value = input.trim()
  if (!value) throw invalid(`${label} must not be empty`, 'INVALID_IDENTIFIER')
  if (value.length > 128) throw invalid(`${label} must be at most 128 characters`, 'INVALID_IDENTIFIER')
  if (value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1).replace(/""/g, '"')
    if (!inner) throw invalid(`${label} must not be an empty quoted identifier`, 'INVALID_IDENTIFIER')
    if (/[\u0000-\u001f\u007f]/.test(inner)) {
      throw invalid(`${label} must not contain control characters`, 'INVALID_IDENTIFIER')
    }
    return {
      sql: `"${inner.replace(/"/g, '""')}"`,
      name: inner,
      quoted: true,
    }
  }
  if (!IDENTIFIER_WORD.test(value)) {
    throw invalid(
      `${label} must be a Firebird identifier; wrap case-sensitive or special names in double quotes`,
      'INVALID_IDENTIFIER',
    )
  }
  return { sql: value, name: value, quoted: false }
}

export function canonicalIdentifier(input, label = 'identifier') {
  const parsed = identifier(input, label)
  return parsed.quoted ? parsed.name : parsed.name.toUpperCase()
}

export function granteeIdentifier(input, label = 'grantee') {
  const parsed = identifier(input, label)
  if (!parsed.quoted && parsed.name.toUpperCase() === 'PUBLIC') {
    return { ...parsed, sql: 'PUBLIC', name: 'PUBLIC' }
  }
  return parsed
}

export function userName(input) {
  if (typeof input !== 'string') throw invalid('username must be a string', 'INVALID_USERNAME')
  const value = input.trim()
  if (!USER_NAME.test(value)) {
    throw invalid(
      'username must start with a letter and contain only letters, digits, "_", "$", "#", "." or "-" (max 64)',
      'INVALID_USERNAME',
    )
  }
  return value.toUpperCase()
}

export function stringLiteral(value, label = 'value') {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${label} must be a non-empty string`, 'INVALID_LITERAL')
  }
  if (value.includes('\u0000')) throw invalid(`${label} must not contain NUL`, 'INVALID_LITERAL')
  return `'${value.replace(/'/g, "''")}'`
}

export function assertNotAborted(exec) {
  if (exec?.signal?.aborted) {
    throw new FirebirdToolError('Tool execution was aborted before it started', { code: 'ABORTED' })
  }
}

export function maxTimeout(connections, key) {
  return Math.max(5_000, ...connections.map((connection) => connection[key] + 5_000))
}

export function errorResult(error) {
  return {
    error: safeErrorMessage(error),
    code: typeof error?.code === 'string' ? error.code : 'FIREBIRD_ERROR',
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export { QUERY_VERBS }
