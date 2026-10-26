import { defineTool } from '@deepseek-ai/dsh-tools'
import { denied, invalid, safeErrorMessage } from '../errors.js'
import { analyzeSql } from '../sql/analyze.js'
import { assertNoParameters } from '../sql/params.js'
import { isIdentifier } from '../sql/tokenize.js'
import {
  assertAllowedAnalysis,
  assertNotAborted,
  assertSystemTablesAllowed,
  auditCall,
  connectionOrThrow,
  jsonOutput,
  requireConfirmDdl,
  requireDangerous,
  requireMode,
} from './shared.js'

const READWRITE_OBJECT_TYPES = new Set(['table', 'view', 'index'])
const SUPPORTED_OBJECT_TYPES = new Set([
  'table', 'view', 'index', 'procedure', 'trigger', 'function',
  'generator', 'exception', 'domain', 'collation', 'package', 'role', 'database', 'user',
])
const NON_COLUMN_DROP_TARGETS = new Set([
  'CONSTRAINT', 'NOT', 'DEFAULT', 'NULL', 'PRIMARY', 'FOREIGN', 'UNIQUE',
  'CHECK', 'REFERENCES', 'STATISTICS', 'COLUMN',
])

function dropColumns(tokens, ddl) {
  const columns = []
  const seen = new Set()
  const start = ddl.target?.next ?? 0
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i].depth !== 0 || tokens[i].kind !== 'word' || tokens[i].upper !== 'DROP') continue
    let j = i + 1
    if (tokens[j]?.kind === 'word' && tokens[j].upper === 'COLUMN') j += 1
    const next = tokens[j]
    if (!isIdentifier(next)) continue
    if (next.kind === 'word' && NON_COLUMN_DROP_TARGETS.has(next.upper)) continue
    const name = next.kind === 'ident' ? next.value : next.value.toUpperCase()
    if (seen.has(name)) continue
    seen.add(name)
    columns.push(name)
  }
  if (columns.length === 0 && ddl.dropColumn?.name) columns.push(ddl.dropColumn.name)
  return columns
}

function checkAction(toolAction, ddl) {
  if (toolAction === 'create') {
    if (ddl.action !== 'CREATE' && ddl.action !== 'RECREATE') {
      throw denied('firebird_create only accepts CREATE, CREATE OR ALTER or RECREATE statements', 'DDL_ACTION_MISMATCH')
    }
    return
  }
  if (toolAction === 'alter') {
    if (ddl.action !== 'ALTER' && !(ddl.action === 'CREATE' && ddl.orAlter)) {
      throw denied('firebird_alter only accepts ALTER or CREATE OR ALTER statements', 'DDL_ACTION_MISMATCH')
    }
    return
  }
  if (ddl.action !== 'DROP') {
    throw denied('firebird_drop only accepts DROP statements', 'DDL_ACTION_MISMATCH')
  }
}

function checkObjectType(toolAction, ddl, connection) {
  const objectType = ddl.objectType
  if (!objectType || !SUPPORTED_OBJECT_TYPES.has(objectType)) {
    throw invalid(`Unsupported or unrecognized DDL object type: ${objectType ?? '(missing)'}`, 'UNSUPPORTED_DDL')
  }
  if (objectType === 'user') {
    throw denied('Use firebird_manage_user for user management; generic user DDL is not allowed', 'USER_DDL_DENIED')
  }
  if (toolAction === 'create' && objectType === 'database') {
    throw denied('CREATE DATABASE is not supported by this connection-scoped plugin', 'CREATE_DATABASE_DENIED')
  }
  if (!READWRITE_OBJECT_TYPES.has(objectType) && connection.accessMode !== 'admin') {
    throw denied(
      `${toolAction.toUpperCase()} ${objectType.toUpperCase()} requires accessMode admin`,
      'ACCESS_DENIED',
    )
  }
}

async function dangerousForDdl({ action, ddl, analysis, connection, metadata, allowSystemTables }) {
  const reasons = []
  const target = ddl.target?.name
  if (action === 'drop' && ddl.objectType === 'database') {
    reasons.push('DROP DATABASE destroys the connected database')
  }
  if (analysis.writesSystemTable && allowSystemTables) {
    reasons.push('the statement writes an RDB$ system table')
  }
  if (action === 'drop' && ddl.objectType === 'table' && target) {
    try {
      const fks = await metadata.incomingForeignKeys(connection.name, target)
      if (fks.length > 0) {
        const names = fks.slice(0, 5).map((fk) => fk.name).join(', ')
        reasons.push(`table ${target} is referenced by ${fks.length} foreign key(s): ${names}`)
      }
    } catch (error) {
      reasons.push(`could not verify foreign keys referencing ${target}: ${safeErrorMessage(error)}`)
    }
  }
  if (action === 'alter' && ddl.objectType === 'table' && target) {
    const columns = dropColumns(analysis.tokens, ddl)
    for (const column of columns) {
      try {
        const usage = await metadata.columnUsage(connection.name, target, column)
        const count = usage.dependencies.length + usage.indexes.length + usage.foreignKeys.length
        if (count > 0) {
          const parts = []
          if (usage.dependencies.length > 0) parts.push(`${usage.dependencies.length} dependent object(s)`)
          if (usage.indexes.length > 0) parts.push(`indexes ${usage.indexes.join(', ')}`)
          if (usage.foreignKeys.length > 0) parts.push(`${usage.foreignKeys.length} foreign key(s)`)
          reasons.push(`column ${target}.${column} has dependencies: ${parts.join('; ')}`)
        }
      } catch (error) {
        reasons.push(`could not verify dependencies for column ${target}.${column}: ${safeErrorMessage(error)}`)
      }
    }
  }
  return reasons
}

function createDdlTool(toolAction, context) {
  const { config, manager, metadata, audit } = context
  const label = toolAction.toUpperCase()
  return defineTool({
    name: `firebird_${toolAction}`,
    description:
      `${label} Firebird DDL. confirmDDL: true is mandatory. ` +
      'readwrite connections may manage tables, views and indexes; procedures, triggers, generators, roles and ' +
      'other schema objects require admin. The statement is transactionally executed, metadata caches are invalidated, ' +
      'and dependents/invalidated objects are reported afterwards. ' +
      'DROP DATABASE, dropping a table referenced by a foreign key, and dropping a column with dependencies require confirmDangerous: true.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named Firebird connection.' },
      sql: { type: 'string', required: true, description: `A single Firebird ${label} statement; do not use bind placeholders in DDL.` },
      confirmDDL: { type: 'boolean', description: 'Must be true to acknowledge schema changes.' },
      confirmDangerous: { type: 'boolean', description: 'Required for destructive or dependency-affecting DDL.' },
    },
    output: jsonOutput('DDL execution result with action, object type, warnings and dependent-object advice.'),
    async execute(args, exec) {
      let auditSql = typeof args.sql === 'string' ? args.sql : ''
      return auditCall(audit, {
        tool: `firebird_${toolAction}`,
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          requireMode(connection, ['readwrite', 'admin'], `firebird_${toolAction}`)
          const analysis = analyzeSql(args.sql)
          if (analysis.kind !== 'ddl') {
            throw denied(`firebird_${toolAction} only accepts DDL statements`, 'NOT_DDL')
          }
          const ddl = analysis.ddl
          checkAction(toolAction, ddl)
          checkObjectType(toolAction, ddl, connection)
          requireConfirmDdl(args)
          assertNoParameters(analysis.sql)
          assertAllowedAnalysis(analysis, connection)
          assertSystemTablesAllowed(analysis, connection)
          auditSql = analysis.sql

          const reasons = await dangerousForDdl({
            action: toolAction,
            ddl,
            analysis,
            connection,
            metadata,
            allowSystemTables: connection.allowSystemTables,
          })
          if (reasons.length > 0) requireDangerous(args, reasons)

          const warnings = []
          const target = ddl.target?.name
          let before = []
          let databaseDropped = false
          if (target && toolAction !== 'create' && ddl.objectType !== 'database') {
            try {
              before = await metadata.dependents(args.connection, target)
            } catch (error) {
              warnings.push(`Could not read dependencies before DDL: ${safeErrorMessage(error)}`)
            }
          }

          let result
          try {
            result = await manager.ddl(args.connection, analysis.sql)
            databaseDropped = toolAction === 'drop' && ddl.objectType === 'database'
          } finally {
            metadata.invalidate(args.connection)
            if (databaseDropped) {
              try {
                await manager.close(args.connection)
              } catch {
                // The server detaches a dropped database; the local state is reset regardless.
              }
            }
          }

          if (target && ddl.objectType !== 'database') {
            const after = await metadata.ddlWarnings(args.connection, target, before)
            warnings.push(...after)
          }

          return {
            connection: args.connection,
            action: ddl.action,
            objectType: ddl.objectType,
            object: ddl.target?.display ?? null,
            sql: analysis.sql,
            executed: true,
            affectedRows: result?.affectedRows ?? 0,
            dangerousConfirmed: reasons.length > 0,
            warnings,
          }
        },
      })
    },
  })
}

export function createCreateTool(context) {
  return createDdlTool('create', context)
}

export function createAlterTool(context) {
  return createDdlTool('alter', context)
}

export function createDropTool(context) {
  return createDdlTool('drop', context)
}
