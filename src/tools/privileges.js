import { defineTool } from '@deepseek-ai/dsh-tools'
import { denied, invalid } from '../errors.js'
import { assertNoParameters } from '../sql/params.js'
import {
  assertAllowedName,
  assertNotAborted,
  auditCall,
  canonicalIdentifier,
  connectionOrThrow,
  granteeIdentifier,
  identifier,
  jsonOutput,
  requireMode,
} from './shared.js'

const TABLE_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALL'])
const ROUTINE_PRIVILEGES = new Set(['EXECUTE', 'ALL'])
const OBJECT_CLAUSES = new Map([
  ['table', 'TABLE'],
  ['view', 'TABLE'],
  ['procedure', 'PROCEDURE'],
])

function normalizePrivileges(input, objectType) {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalid('privileges must be a non-empty array', 'INVALID_PRIVILEGE')
  }
  if (input.length > 16) throw invalid('privileges must contain at most 16 entries', 'INVALID_PRIVILEGE')
  const allowed = objectType === 'procedure' ? ROUTINE_PRIVILEGES : TABLE_PRIVILEGES
  const selected = new Set()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw invalid('Every privilege must be a string', 'INVALID_PRIVILEGE')
    }
    let privilege = raw.trim().toUpperCase().replace(/\s+/g, ' ')
    if (privilege === 'ALL PRIVILEGES') privilege = 'ALL'
    if (!allowed.has(privilege)) {
      throw invalid(
        `Privilege "${raw}" is not valid for a ${objectType}; allowed: ${[...allowed].join(', ')}`,
        'INVALID_PRIVILEGE',
      )
    }
    selected.add(privilege)
  }
  if (selected.has('ALL')) return ['ALL']
  return [...selected]
}

function privilegeSql({ action, privileges, objectType, objectId, grantee, withGrantOption, grantOptionFor }) {
  const clause = OBJECT_CLAUSES.get(objectType)
  const list = privileges.join(', ')
  if (action === 'grant') {
    return `GRANT ${list} ON ${clause} ${objectId} TO ${grantee}${withGrantOption ? ' WITH GRANT OPTION' : ''}`
  }
  const option = grantOptionFor ? 'GRANT OPTION FOR ' : ''
  return `REVOKE ${option}${list} ON ${clause} ${objectId} FROM ${grantee}`
}

function createPrivilegeTool(action, context) {
  const { config, manager, metadata, audit, confirmations } = context
  const toolName = `firebird_${action}`
  return defineTool({
    name: toolName,
    description:
      `${action === 'grant' ? 'Grant' : 'Revoke'} Firebird privileges on a table, view or procedure (admin only). ` +
      'This tool is two-step: the first call validates the target and returns the generated SQL with a single-use ' +
      'confirmationToken (5 minutes); review it, then repeat the same arguments with confirmPrivilege: true and that token. ' +
      'Bind parameters are not accepted in privilege SQL. RDB$ targets require allowSystemTables: true.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named admin connection.' },
      privileges: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'One or more of SELECT, INSERT, UPDATE, DELETE, REFERENCES, ALL (EXECUTE/ALL for procedures).',
      },
      objectType: {
        type: 'string',
        required: true,
        enum: ['table', 'view', 'procedure'],
        description: 'Kind of object receiving or losing the privilege.',
      },
      object: {
        type: 'string',
        required: true,
        description: 'Object name; use "QuotedName" for case-sensitive identifiers.',
      },
      grantee: {
        type: 'string',
        required: true,
        description: 'User or role name, or PUBLIC.',
      },
      withGrantOption: {
        type: 'boolean',
        description: 'GRANT only: add WITH GRANT OPTION.',
      },
      grantOptionFor: {
        type: 'boolean',
        description: 'REVOKE only: revoke only the grant option (GRANT OPTION FOR ...).',
      },
      confirmPrivilege: {
        type: 'boolean',
        description: 'Must be true on the second call, together with confirmationToken.',
      },
      confirmationToken: {
        type: 'string',
        description: 'Token returned by the preview call; single use and bound to the generated SQL.',
      },
    },
    output: jsonOutput('Privilege preview or execution result with generated SQL, token and affected object.'),
    async execute(args, exec) {
      let auditSql = ''
      return auditCall(audit, {
        tool: toolName,
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          requireMode(connection, ['admin'], toolName)

          if (action === 'grant' && args.grantOptionFor === true) {
            throw invalid('grantOptionFor is only valid for firebird_revoke', 'INVALID_ARGUMENT')
          }
          if (action === 'revoke' && args.withGrantOption === true) {
            throw invalid('withGrantOption is only valid for firebird_grant', 'INVALID_ARGUMENT')
          }

          const privileges = normalizePrivileges(args.privileges, args.objectType)
          const objectId = identifier(args.object, 'object')
          const canonical = canonicalIdentifier(args.object, 'object')
          const grantee = granteeIdentifier(args.grantee)
          if (canonical.toUpperCase().startsWith('RDB$') && !connection.allowSystemTables) {
            throw denied(
              `Privileges on system object ${objectId.name} require allowSystemTables: true`,
              'SYSTEM_TABLE_DENIED',
            )
          }
          assertAllowedName(connection, canonical, objectId.name)

          const resolved = await metadata.resolveObject(args.connection, canonical, args.objectType)
          const sql = privilegeSql({
            action,
            privileges,
            objectType: args.objectType,
            objectId: objectId.sql,
            grantee: grantee.sql,
            withGrantOption: args.withGrantOption === true,
            grantOptionFor: args.grantOptionFor === true,
          })
          assertNoParameters(sql)
          auditSql = sql

          const wantsExecute = args.confirmPrivilege === true || args.confirmationToken !== undefined
          if (!wantsExecute) {
            const confirmation = confirmations.issue({
              connection: args.connection,
              action: toolName,
              sql,
            })
            return {
              connection: args.connection,
              action,
              executed: false,
              confirmationRequired: true,
              confirmationToken: confirmation.token,
              expiresAt: confirmation.expiresAt,
              ttlSeconds: confirmation.ttlSeconds,
              instruction:
                'Review sql, then call again with identical arguments plus '
                + 'confirmPrivilege: true and confirmationToken.',
              privileges,
              objectType: args.objectType,
              object: resolved.name ?? canonical,
              grantee: grantee.name,
              withGrantOption: action === 'grant' && args.withGrantOption === true,
              grantOptionFor: action === 'revoke' && args.grantOptionFor === true,
              sql,
            }
          }

          if (args.confirmPrivilege !== true) {
            throw denied(
              'Privilege execution requires confirmPrivilege: true together with confirmationToken',
              'CONFIRM_PRIVILEGE_REQUIRED',
            )
          }
          confirmations.consume({
            token: args.confirmationToken,
            connection: args.connection,
            action: toolName,
            sql,
          })

          const result = await manager.ddl(args.connection, sql)
          return {
            connection: args.connection,
            action,
            executed: true,
            privileges,
            objectType: args.objectType,
            object: resolved.name ?? canonical,
            grantee: grantee.name,
            withGrantOption: action === 'grant' && args.withGrantOption === true,
            grantOptionFor: action === 'revoke' && args.grantOptionFor === true,
            sql,
            affectedRows: result?.affectedRows ?? 0,
            warnings: result?.warnings ?? [],
          }
        },
      })
    },
  })
}

export function createGrantTool(context) {
  return createPrivilegeTool('grant', context)
}

export function createRevokeTool(context) {
  return createPrivilegeTool('revoke', context)
}
