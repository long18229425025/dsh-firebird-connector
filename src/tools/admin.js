import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveSecret } from '../config.js'
import { denied, invalid } from '../errors.js'
import { assertNoParameters } from '../sql/params.js'
import {
  assertNotAborted,
  auditCall,
  connectionOrThrow,
  identifier,
  jsonOutput,
  requireConfirmDdl,
  requireDangerous,
  requireMode,
  stringLiteral,
  userName,
} from './shared.js'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/

function optionalPersonName(value, label) {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${label} must be a non-empty string`, 'INVALID_USER_NAME_PART')
  }
  if (value.length > 255) throw invalid(`${label} must be at most 255 characters`, 'INVALID_USER_NAME_PART')
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${label} must not contain control characters`, 'INVALID_USER_NAME_PART')
  }
  return stringLiteral(value, label)
}

function passwordSource(args) {
  const hasEnv = args.passwordEnv !== undefined
  const hasRef = args.passwordRef !== undefined
  if (hasEnv && hasRef) {
    throw invalid('Set only one of passwordEnv or passwordRef', 'PASSWORD_SOURCE_INVALID')
  }
  if (!hasEnv && !hasRef) return null
  const name = hasEnv ? args.passwordEnv : args.passwordRef
  const valid = typeof name === 'string' && (hasEnv ? ENV_NAME.test(name) : CREDENTIAL_REF.test(name))
  if (!valid) {
    throw invalid(
      hasEnv
        ? 'passwordEnv must be a POSIX-style environment variable name'
        : 'passwordRef must be a credential reference name (letters, digits, "_", ".", ":", "/" or "-")',
      'PASSWORD_SOURCE_INVALID',
    )
  }
  return { kind: hasEnv ? 'env' : 'ref', name }
}

export function createSetRoleTool(context) {
  const { config, manager, audit } = context
  return defineTool({
    name: 'firebird_set_role',
    description:
      'Switch the Firebird role for a named connection by reattaching with that role. ' +
      'Requires allowRoleSwitch: true on the connection. Pass an empty role to clear it. ' +
      'Switching detaches the current connection; the next operation reconnects with the new role.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named Firebird connection.' },
      role: {
        type: 'string',
        required: true,
        description: 'Firebird role name, or an empty string to clear the active role.',
      },
    },
    output: jsonOutput('Role switch result with previous/new role and server version.'),
    async execute(args, exec) {
      const requested = typeof args.role === 'string' ? args.role.trim() : ''
      let roleId = null
      let auditSql = 'SET ROLE NONE'
      if (requested) {
        roleId = identifier(requested, 'role')
        auditSql = `SET ROLE ${roleId.sql}`
      }
      return auditCall(audit, {
        tool: 'firebird_set_role',
        connection: args.connection,
        sql: auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          if (!connection.allowRoleSwitch) {
            throw denied(
              `Role switching is disabled on connection "${args.connection}"; set allowRoleSwitch: true`,
              'ROLE_SWITCH_DENIED',
            )
          }
          const previousRole = manager.describe(args.connection).activeRole ?? null
          const result = await manager.setRole(args.connection, roleId ? roleId.name : null)
          return {
            connection: args.connection,
            previousRole,
            role: result.role ?? null,
            changed: previousRole !== (result.role ?? null),
            serverVersion: result.serverVersion ?? null,
          }
        },
      })
    },
  })
}

export function createManageUserTool(context) {
  const { config, manager, audit, credentials } = context
  return defineTool({
    name: 'firebird_manage_user',
    description:
      'Create, alter or drop a Firebird user (admin only). The password is never accepted as plaintext: ' +
      'pass passwordEnv (environment variable name) or passwordRef (dsh credential reference) and it is resolved at call time. ' +
      'confirmDDL: true is mandatory; DROP USER also requires confirmDangerous: true. ' +
      'Returns redacted SQL only; the password is added to the audit redactor before execution.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named admin connection.' },
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'alter', 'drop'],
        description: 'User operation to perform.',
      },
      username: { type: 'string', required: true, description: 'Firebird user name (letters, digits, "_", "$", "#", ".", "-").' },
      passwordEnv: {
        type: 'string',
        description: 'Environment variable holding the password. Mutually exclusive with passwordRef.',
      },
      passwordRef: {
        type: 'string',
        description: 'dsh credential reference holding the password. Mutually exclusive with passwordEnv.',
      },
      firstName: { type: 'string', description: 'Optional FIRSTNAME value (create/alter).' },
      middleName: { type: 'string', description: 'Optional MIDDLENAME value (create/alter).' },
      lastName: { type: 'string', description: 'Optional LASTNAME value (create/alter).' },
      confirmDDL: { type: 'boolean', description: 'Must be true to acknowledge the user-management change.' },
      confirmDangerous: { type: 'boolean', description: 'Required for DROP USER.' },
    },
    output: jsonOutput('User-management result with action, username, password source and redacted SQL.'),
    async execute(args, exec) {
      let auditSql = ''
      return auditCall(audit, {
        tool: 'firebird_manage_user',
        connection: args.connection,
        sql: () => auditSql,
        run: async () => {
          assertNotAborted(exec)
          const connection = connectionOrThrow(config, args.connection)
          requireMode(connection, ['admin'], 'firebird_manage_user')
          const action = args.action
          const name = userName(args.username)
          requireConfirmDdl(args)
          if (action === 'drop') requireDangerous(args, ['DROP USER permanently removes the account'])

          const source = passwordSource(args)
          if (action === 'create' && !source) {
            throw invalid('CREATE USER requires passwordEnv or passwordRef', 'PASSWORD_REQUIRED')
          }
          if (action === 'drop' && source) {
            throw invalid('DROP USER does not accept a password source', 'PASSWORD_NOT_ALLOWED')
          }
          if (action === 'drop' && (args.firstName || args.middleName || args.lastName)) {
            throw invalid('DROP USER does not accept name fields', 'NAME_NOT_ALLOWED')
          }

          const firstName = action === 'drop' ? null : optionalPersonName(args.firstName, 'firstName')
          const middleName = action === 'drop' ? null : optionalPersonName(args.middleName, 'middleName')
          const lastName = action === 'drop' ? null : optionalPersonName(args.lastName, 'lastName')

          let password = null
          if (source) {
            password = await resolveSecret(source, credentials, 'user password')
            audit.addSecret(password)
          }

          const nameParts = []
          if (firstName) nameParts.push(`FIRSTNAME ${firstName}`)
          if (middleName) nameParts.push(`MIDDLENAME ${middleName}`)
          if (lastName) nameParts.push(`LASTNAME ${lastName}`)

          let sql
          if (action === 'create') {
            sql = `CREATE USER ${name} PASSWORD ${stringLiteral(password, 'password')}`
            if (nameParts.length > 0) sql += ` ${nameParts.join(' ')}`
          } else if (action === 'alter') {
            const changes = []
            if (password !== null) changes.push(`PASSWORD ${stringLiteral(password, 'password')}`)
            changes.push(...nameParts)
            if (changes.length === 0) {
              throw invalid(
                'ALTER USER requires passwordEnv/passwordRef or at least one of firstName, middleName or lastName',
                'NO_USER_CHANGES',
              )
            }
            sql = `ALTER USER ${name} ${changes.join(' ')}`
          } else {
            sql = `DROP USER ${name}`
          }
          assertNoParameters(sql)
          auditSql = sql

          const result = await manager.ddl(args.connection, sql)
          return {
            connection: args.connection,
            action,
            username: name,
            executed: true,
            passwordSource: source ? source.kind : null,
            sql: audit.redact(sql),
            affectedRows: result?.affectedRows ?? 0,
            warnings: result?.warnings ?? [],
          }
        },
      })
    },
  })
}

export function createListConnectionsTool(context) {
  const { manager, audit } = context
  return defineTool({
    name: 'firebird_list_connections',
    description:
      'List configured Firebird connections with access mode, host, port, database, allowedObjects, role, ' +
      'timeout settings and current open/role state. Credential values are never returned.',
    parameters: {},
    output: jsonOutput('Configured connections with safe, non-secret connection facts.'),
    isConcurrencySafe: () => true,
    async execute() {
      return auditCall(audit, {
        tool: 'firebird_list_connections',
        connection: '',
        sql: '',
        run: async () => {
          const connections = manager.list()
          return { count: connections.length, connections }
        },
      })
    },
  })
}
