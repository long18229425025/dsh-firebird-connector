import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  auditCall,
  connectionOrThrow,
  jsonOutput,
} from './shared.js'

export function createListObjectsTool(context) {
  const { config, metadata, audit } = context
  return defineTool({
    name: 'firebird_list_objects',
    description:
      'List Firebird tables, views, procedures, triggers and generators using the RDB$ catalog. ' +
      'Results are cached for 120 seconds per connection and invalidated after DDL through this plugin. ' +
      'System objects are hidden unless includeSystem is true.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named Firebird connection.' },
      type: {
        type: 'string',
        enum: ['all', 'table', 'view', 'procedure', 'trigger', 'generator'],
        description: 'Object category to list; defaults to all.',
      },
      filter: { type: 'string', description: 'Optional case-insensitive substring match against object names.' },
      includeSystem: { type: 'boolean', description: 'Include RDB$ system objects (default false).' },
    },
    output: jsonOutput('Object list with names, types, owners, trigger bindings and validity flags.'),
    isConcurrencySafe: () => true,
    async execute(args) {
      const type = args.type ?? 'all'
      const auditSql = `LIST OBJECTS type=${type}${args.includeSystem ? ' includeSystem=true' : ''}`
      return auditCall(audit, {
        tool: 'firebird_list_objects',
        connection: args.connection,
        sql: auditSql,
        run: async () => {
          connectionOrThrow(config, args.connection)
          return metadata.listObjects(args.connection, type, {
            includeSystem: args.includeSystem === true,
            filter: args.filter,
          })
        },
      })
    },
  })
}

export function createDescribeObjectTool(context) {
  const { config, metadata, audit } = context
  return defineTool({
    name: 'firebird_describe_object',
    description:
      'Describe one Firebird object: columns and domains, indexes, incoming/outgoing foreign keys, trigger bindings, ' +
      'procedure input/output parameters, dependencies and validity. Uses RDB$ catalog views with a 120-second cache. ' +
      'Pass type when a table, view, procedure or trigger share a name.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Named Firebird connection.' },
      name: { type: 'string', required: true, description: 'Object name. Use "QuotedName" for case-sensitive identifiers.' },
      type: {
        type: 'string',
        enum: ['table', 'view', 'procedure', 'trigger', 'generator', 'sequence'],
        description: 'Optional object type; inferred when omitted. "sequence" is an alias for generator.',
      },
    },
    output: jsonOutput('Full object description from the Firebird RDB$ catalog.'),
    isConcurrencySafe: () => true,
    async execute(args) {
      const auditSql = `DESCRIBE ${args.name}${args.type ? ` type=${args.type}` : ''}`
      return auditCall(audit, {
        tool: 'firebird_describe_object',
        connection: args.connection,
        sql: auditSql,
        run: async () => {
          connectionOrThrow(config, args.connection)
          return metadata.describeObject(args.connection, args.name, args.type)
        },
      })
    },
  })
}
