import { defineTool } from '@deepseek-ai/dsh-tools'
import { FirebirdToolError, denied, invalid } from '../errors.js'
import { analyzeSql } from '../sql/analyze.js'
import { bindParameters } from '../sql/params.js'
import {
  applyQueryLimit,
  assertAllowedAnalysis,
  assertAllowedName,
  assertDml,
  assertNotAborted,
  assertReadableQuery,
  assertSystemTablesAllowed,
  auditCall,
  canonicalIdentifier,
  chooseLimit,
  connectionOrThrow,
  identifier,
  jsonOutput,
  requireConfirmWrite,
  requireDangerous,
  requireMode,
} from './shared.js'

function queryResult(args, result, limitInfo, limited, bound) {
  const rows = Array.isArray(result?.rows) ? result.rows : []
  const effectiveLimit = limited.applied ? limitInfo.limit : null
  const truncated = effectiveLimit !== null && rows.length > effectiveLimit
  const visible = truncated ? rows.slice(0, effectiveLimit) : rows
  return {
    connection: args.connection,
    sql: bound.sql,
    effectiveSql: limited.sql,
    rowLimit: effectiveLimit,
    requestedLimit: limitInfo.requested,
    limitCapped: limitInfo.capped,
    wrappedForLimit: limited.wrapped,
    truncated,
    rowCount: visible.length,
    columns: result?.fields ?? [],
    rows: visible,
    warnings: result?.warnings ?? [],
  }
}

export function createQueryTool(context) {
  const { config, manager, audit } = context
  return defineTool({
    name: 'firebird_query',
    description:
      'Run a read-only Firebird SELECT, WITH or EXPLAIN statement. ' +
      'All values must be passed via ? or :name placeholders in params; string interpolation is rejected. ' +
      'The statement is checked against the connection accessMode and allowedObjects whitelist. ' +
      'A row limit is appended automatically (connection maxRows, or the lower limit argument).',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named connection from the plugin config.' },
      sql: { type: 'string', required: true, description: 'A single SELECT/WITH/EXPLAIN statement with ? or :name placeholders.' },
      params: {
        type: 'json',
        description: 'Optional array for positional ? placeholders, or object keyed by :name. Values are bound, never interpolated.',
      },
      limit: {
        type: 'integer',
        description: 'Optional row cap (1-5000); effective max is the connection maxRows. Defaults to connection maxRows.',
      },
    },
    output: jsonOutput('Query result with columns, rows, limit/truncation details and warnings.'),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let auditSql = typeof args.sql === 'string' ? args.sql : ''
      return auditCall(audit, {
        tool: 'firebird_query',
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          const analysis = analyzeSql(args.sql)
          assertReadableQuery(analysis)
          assertAllowedAnalysis(analysis, connection)
          const bound = bindParameters(analysis.sql, args.params)
          const limitInfo = chooseLimit(connection, args.limit)
          const limited = applyQueryLimit(bound.sql, analysis, limitInfo.limit)
          auditSql = limited.sql
          const result = await manager.query(args.connection, limited.sql, bound.values)
          return queryResult(args, result, limitInfo, limited, bound)
        },
      })
    },
  })
}

export function createExecuteTool(context) {
  const { config, manager, audit } = context
  return defineTool({
    name: 'firebird_execute',
    description:
      'Run INSERT, UPDATE, DELETE or MERGE on a readwrite/admin connection. ' +
      'Values must be passed through ? or :name placeholders; confirmWrite: true is mandatory. ' +
      'The operation runs in a transaction: commit on success, rollback on failure. ' +
      'UPDATE/DELETE without WHERE are rejected unless allowUnrestrictedDML is enabled, then require confirmDangerous.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named readwrite or admin connection.' },
      sql: { type: 'string', required: true, description: 'A single DML statement with ? or :name placeholders.' },
      params: {
        type: 'json',
        description: 'Optional array for positional ? placeholders, or object keyed by :name. Values are bound, never interpolated.',
      },
      confirmWrite: { type: 'boolean', description: 'Must be true to acknowledge that data will be modified.' },
      confirmDangerous: { type: 'boolean', description: 'Required for unrestricted DML or writes to RDB$ tables when enabled.' },
    },
    output: jsonOutput('DML result with affected row count, optional RETURNING rows and warnings.'),
    async execute(args, exec) {
      let auditSql = typeof args.sql === 'string' ? args.sql : ''
      return auditCall(audit, {
        tool: 'firebird_execute',
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          requireMode(connection, ['readwrite', 'admin'], 'firebird_execute')
          const analysis = analyzeSql(args.sql)
          assertDml(analysis)
          assertAllowedAnalysis(analysis, connection)
          requireConfirmWrite(args)
          assertSystemTablesAllowed(analysis, connection)

          const dangerous = []
          if (
            (analysis.mainVerb === 'UPDATE' || analysis.mainVerb === 'DELETE')
            && !analysis.hasWhere
            && !analysis.isUpsert
          ) {
            if (!connection.allowUnrestrictedDML) {
              throw denied(
                'UPDATE/DELETE without a top-level WHERE clause is disabled on this connection; add WHERE or enable allowUnrestrictedDML',
                'UNRESTRICTED_DML_DENIED',
              )
            }
            dangerous.push('unrestricted UPDATE/DELETE without WHERE')
          }
          if (analysis.writesSystemTable) {
            dangerous.push('writing an RDB$ system table')
          }
          if (dangerous.length > 0) requireDangerous(args, dangerous)

          const bound = bindParameters(analysis.sql, args.params)
          auditSql = bound.sql
          const result = await manager.execute(args.connection, bound.sql, bound.values)
          return {
            connection: args.connection,
            sql: bound.sql,
            executed: true,
            affectedRows: result?.affectedRows ?? 0,
            rows: Array.isArray(result?.rows) ? result.rows : [],
            columns: result?.fields ?? [],
            warnings: result?.warnings ?? [],
            dangerousConfirmed: dangerous.length > 0,
          }
        },
      })
    },
  })
}

export function createCallProcedureTool(context) {
  const { config, manager, metadata, audit } = context
  return defineTool({
    name: 'firebird_call_procedure',
    description:
      'Execute a Firebird stored procedure on a readwrite/admin connection. ' +
      'Input values are bound as parameters. The tool validates the procedure exists and that the current user ' +
      '(or active role/PUBLIC) has EXECUTE privilege before invocation, then returns output parameters or result sets. ' +
      'Selectable procedures are called with SELECT * FROM ...; executable procedures with EXECUTE PROCEDURE.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named readwrite or admin connection.' },
      procedure: {
        type: 'string',
        required: true,
        description: 'Procedure name. Use a plain Firebird identifier for normal names, or "QuotedName" for case-sensitive names.',
      },
      params: {
        type: 'array',
        items: { type: 'json' },
        description: 'Input parameter values in declaration order. Each value is bound, never interpolated.',
      },
    },
    output: jsonOutput('Procedure execution result with output rows, affected row count and warnings.'),
    async execute(args, exec) {
      let auditSql = ''
      return auditCall(audit, {
        tool: 'firebird_call_procedure',
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          requireMode(connection, ['readwrite', 'admin'], 'firebird_call_procedure')
          const procedureId = identifier(args.procedure, 'procedure')
          const canonical = canonicalIdentifier(args.procedure, 'procedure')
          assertAllowedName(connection, canonical, procedureId.name)
          const values = args.params === undefined ? [] : args.params
          if (!Array.isArray(values)) {
            throw invalid('params for firebird_call_procedure must be an array', 'PARAM_STYLE')
          }

          const check = await metadata.checkProcedureExecute(args.connection, canonical)
          if (!check.exists) {
            throw new FirebirdToolError(
              `Procedure ${procedureId.name} was not found on connection "${args.connection}"`,
              { code: 'OBJECT_NOT_FOUND' },
            )
          }
          if (!check.allowed) {
            throw denied(check.reason ?? `EXECUTE privilege is required on procedure ${procedureId.name}`, 'EXECUTE_DENIED')
          }

          const placeholders = values.length > 0
            ? `(${values.map(() => '?').join(', ')})`
            : ''
          const mode = check.selectable ? 'select' : 'execute'
          const sql = check.selectable
            ? `SELECT * FROM ${procedureId.sql}${placeholders}`
            : `EXECUTE PROCEDURE ${procedureId.sql}${placeholders}`
          const bound = bindParameters(sql, values)
          auditSql = bound.sql

          const warnings = []
          if (!check.valid) {
            warnings.push(`Procedure ${check.procedure} has an invalid BLR and may be recompiled by the server.`)
          }
          if (check.inputCount !== values.length) {
            warnings.push(
              `Procedure ${check.procedure} declares ${check.inputCount} input parameter(s) but ${values.length} value(s) were supplied; the server may reject the call.`,
            )
          }

          const result = await manager.call(args.connection, bound.sql, bound.values)
          return {
            connection: args.connection,
            procedure: check.procedure,
            procedureType: check.procedureType,
            mode,
            sql: bound.sql,
            executedAs: check.currentUser,
            activeRole: check.activeRole ?? null,
            executed: true,
            affectedRows: result?.affectedRows ?? 0,
            rowCount: Array.isArray(result?.rows) ? result.rows.length : 0,
            rows: Array.isArray(result?.rows) ? result.rows : [],
            columns: result?.fields ?? [],
            warnings: [...warnings, ...(result?.warnings ?? [])],
          }
        },
      })
    },
  })
}
