import { FirebirdToolError, safeErrorMessage } from './errors.js'

const CACHE_TTL_MS = 120_000

const FIELD_TYPE_NAMES = new Map([
  [7, 'SMALLINT'],
  [8, 'INTEGER'],
  [9, 'QUAD'],
  [10, 'FLOAT'],
  [11, 'D_FLOAT'],
  [12, 'DATE'],
  [13, 'TIME'],
  [14, 'CHAR'],
  [15, 'BIGINT'],
  [16, 'DOUBLE PRECISION'],
  [23, 'TIMESTAMP'],
  [24, 'VARCHAR'],
  [25, 'CSTRING'],
  [26, 'BLOB'],
  [27, 'BLOB_ID'],
  [28, 'SQL_DATE'],
  [29, 'SQL_TIME'],
  [30, 'SQL_TIMESTAMP'],
  [35, 'BOOLEAN'],
  [37, 'INT128'],
  [45, 'DEC16'],
  [46, 'DEC34'],
  [261, 'BLOB'],
])

const INTEGER_PRECISION = new Map([
  [7, 5],
  [8, 10],
  [15, 19],
  [37, 38],
  [45, 16],
  [46, 34],
])

const CHARACTER_TYPES = new Set([14, 24, 25])

const TRIGGER_TYPES = new Map([
  [1, ['BEFORE', ['INSERT']]],
  [2, ['AFTER', ['INSERT']]],
  [3, ['BEFORE', ['UPDATE']]],
  [4, ['AFTER', ['UPDATE']]],
  [5, ['BEFORE', ['DELETE']]],
  [6, ['AFTER', ['DELETE']]],
  [7, ['BEFORE', ['CONNECT']]],
  [8, ['AFTER', ['CONNECT']]],
  [9, ['BEFORE', ['TRANSACTION START']]],
  [10, ['AFTER', ['TRANSACTION START']]],
  [11, ['BEFORE', ['TRANSACTION COMMIT']]],
  [12, ['AFTER', ['TRANSACTION COMMIT']]],
  [13, ['BEFORE', ['TRANSACTION ROLLBACK']]],
  [14, ['AFTER', ['TRANSACTION ROLLBACK']]],
  [15, ['BEFORE', ['COMMIT RETAIN']]],
  [16, ['AFTER', ['COMMIT RETAIN']]],
  [17, ['BEFORE', ['ROLLBACK RETAIN']]],
  [18, ['AFTER', ['ROLLBACK RETAIN']]],
  [19, ['BEFORE', ['INSERT', 'UPDATE']]],
  [20, ['AFTER', ['INSERT', 'UPDATE']]],
  [21, ['BEFORE', ['INSERT', 'DELETE']]],
  [22, ['AFTER', ['INSERT', 'DELETE']]],
  [23, ['BEFORE', ['UPDATE', 'DELETE']]],
  [24, ['AFTER', ['UPDATE', 'DELETE']]],
  [25, ['BEFORE', ['INSERT', 'UPDATE', 'DELETE']]],
  [26, ['AFTER', ['INSERT', 'UPDATE', 'DELETE']]],
])

const DEPENDENT_TYPE_NAMES = new Map([
  [0, 'relation'],
  [1, 'trigger'],
  [2, 'computed field'],
  [3, 'validation'],
  [4, 'procedure'],
  [5, 'exception'],
  [6, 'generator'],
  [7, 'UDF'],
  [8, 'blob filter'],
  [9, 'user'],
])

const OBJECT_TYPES = new Set(['table', 'view', 'procedure', 'trigger', 'generator'])

function text(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.replace(/[\s\u0000]+$/, '')
  if (typeof value === 'object' && value.type === 'buffer' && value.encoding === 'base64') {
    return Buffer.from(value.data, 'base64').toString('utf8').replace(/[\s\u0000]+$/, '')
  }
  return String(value)
}

function number(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function flag(value) {
  return number(value, 0) === 1
}

function normalizeName(value) {
  const result = text(value)
  return result ? result.trim() : null
}

function normalizeType(type) {
  if (!type) return null
  const normalized = String(type).toLowerCase()
  if (normalized === 'sequence') return 'generator'
  if (!OBJECT_TYPES.has(normalized)) {
    throw new FirebirdToolError(`Unsupported object type "${type}"`, { code: 'INVALID_OBJECT_TYPE' })
  }
  return normalized
}

function numericType(subType, scale, precision, fallbackPrecision) {
  const kind = subType === 2 ? 'DECIMAL' : 'NUMERIC'
  const digits = precision ?? fallbackPrecision
  if (digits === null) return kind
  return `${kind}(${digits}, ${Math.abs(scale)})`
}

function formatField(field) {
  const code = number(field.FIELD_TYPE)
  if (code === null) return 'UNKNOWN'
  const subType = number(field.SUB_TYPE, 0)
  const scale = number(field.FIELD_SCALE, 0)
  const length = number(field.FIELD_LENGTH, 0)
  const charLength = number(field.CHAR_LENGTH, length)
  const precision = number(field.FIELD_PRECISION)

  if (code === 26 || code === 261) {
    return subType === 1 ? 'BLOB SUB_TYPE TEXT' : 'BLOB SUB_TYPE BINARY'
  }
  if (INTEGER_PRECISION.has(code)) {
    if (scale < 0) return numericType(subType, scale, precision, INTEGER_PRECISION.get(code))
    if (scale > 0) return numericType(subType, scale, precision, INTEGER_PRECISION.get(code))
    if (code === 37) return 'INT128'
    return FIELD_TYPE_NAMES.get(code)
  }
  if (CHARACTER_TYPES.has(code)) {
    return `${FIELD_TYPE_NAMES.get(code)}(${charLength})`
  }
  if (code === 10) return 'FLOAT'
  if (code === 11) return 'D_FLOAT'
  if (code === 16) return 'DOUBLE PRECISION'
  return FIELD_TYPE_NAMES.get(code) ?? `TYPE_${code}`
}

function triggerDescription(triggerType) {
  const known = TRIGGER_TYPES.get(triggerType)
  if (!known) return { timing: null, events: [], rawType: triggerType }
  return { timing: known[0], events: [...known[1]], rawType: triggerType }
}

function procedureType(code) {
  if (code === 1) return 'selectable'
  if (code === 2) return 'executable'
  if (code === 0 || code === null) return 'legacy'
  return `type_${code}`
}

function dependentType(code) {
  return DEPENDENT_TYPE_NAMES.get(code) ?? `type_${code}`
}

function normalizeColumn(row) {
  return {
    name: normalizeName(row.NAME),
    position: number(row.POSITION, 0),
    type: formatField(row),
    nullable: !flag(row.NOT_NULL),
    domain: normalizeName(row.FIELD_SOURCE),
    characterSet: normalizeName(row.CHARSET_NAME),
    default: text(row.DEFAULT_SOURCE),
    description: text(row.DESCRIPTION),
  }
}

function normalizeParameter(row) {
  return {
    name: normalizeName(row.NAME),
    mode: number(row.PARAMETER_TYPE, 0) === 1 ? 'output' : 'input',
    position: number(row.POSITION, 0),
    type: formatField(row),
    nullable: !flag(row.NOT_NULL),
    characterSet: normalizeName(row.CHARSET_NAME),
    description: text(row.DESCRIPTION),
  }
}

function normalizeDependency(row) {
  return {
    name: normalizeName(row.NAME),
    type: dependentType(number(row.DEPENDENT_TYPE, -1)),
    field: normalizeName(row.FIELD_NAME),
  }
}

function normalizeTrigger(row) {
  return {
    name: normalizeName(row.NAME),
    ...triggerDescription(number(row.TRIGGER_TYPE, -1)),
    sequence: number(row.SEQUENCE, 0),
    inactive: flag(row.INACTIVE),
    valid: number(row.VALID_BLR, 1) !== 0,
    description: text(row.DESCRIPTION),
  }
}

function assembleIndexes(rows) {
  const indexes = new Map()
  for (const row of rows) {
    const name = normalizeName(row.INDEX_NAME)
    if (!name) continue
    let index = indexes.get(name)
    if (!index) {
      index = {
        name,
        unique: flag(row.UNIQUE_FLAG),
        descending: number(row.INDEX_TYPE, 0) === 1,
        constraint: normalizeName(row.CONSTRAINT_TYPE),
        columns: [],
      }
      indexes.set(name, index)
    }
    const column = normalizeName(row.FIELD_NAME)
    if (column && !index.columns.includes(column)) index.columns.push(column)
  }
  return [...indexes.values()]
}

function relationForeignKey(row) {
  return {
    name: normalizeName(row.NAME),
    table: normalizeName(row.TABLE_NAME),
    referencedTable: normalizeName(row.REFERENCED_TABLE),
    referencedConstraint: normalizeName(row.REFERENCED_CONSTRAINT),
    updateRule: normalizeName(row.UPDATE_RULE),
    deleteRule: normalizeName(row.DELETE_RULE),
  }
}

function columnsByConstraint(rows) {
  const byConstraint = new Map()
  for (const row of rows) {
    const constraint = normalizeName(row.CONSTRAINT_NAME)
    const column = normalizeName(row.FIELD_NAME)
    if (!constraint || !column) continue
    if (!byConstraint.has(constraint)) byConstraint.set(constraint, [])
    byConstraint.get(constraint).push({
      column,
      position: number(row.FIELD_POSITION, 0),
    })
  }
  for (const columns of byConstraint.values()) {
    columns.sort((a, b) => a.position - b.position)
  }
  return byConstraint
}

function columnNamesByConstraint(rows) {
  const result = new Map()
  for (const [constraint, columns] of columnsByConstraint(rows)) {
    result.set(constraint, columns.map((entry) => entry.column))
  }
  return result
}

function candidateNames(name) {
  const trimmed = String(name).trim()
  const variants = [trimmed]
  const upper = trimmed.toUpperCase()
  const lower = trimmed.toLowerCase()
  if (!variants.includes(upper)) variants.push(upper)
  if (!variants.includes(lower)) variants.push(lower)
  return variants
}

function pickRow(rows, name) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const exact = rows.filter((row) => normalizeName(row.NAME) === name)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw new FirebirdToolError(`Object name "${name}" is ambiguous`, { code: 'OBJECT_AMBIGUOUS' })
  }
  const upper = rows.filter((row) => normalizeName(row.NAME) === name.toUpperCase())
  if (upper.length === 1) return upper[0]
  if (upper.length > 1) {
    throw new FirebirdToolError(`Object name "${name}" is ambiguous`, { code: 'OBJECT_AMBIGUOUS' })
  }
  const lower = rows.filter((row) => normalizeName(row.NAME) === name.toLowerCase())
  if (lower.length === 1) return lower[0]
  if (lower.length > 1) {
    throw new FirebirdToolError(`Object name "${name}" is ambiguous`, { code: 'OBJECT_AMBIGUOUS' })
  }
  return null
}

function requiredList(results, key) {
  const rows = results?.[key]
  return Array.isArray(rows) ? rows : []
}

/**
 * Read-only Firebird catalog access. List and describe results are cached for
 * two minutes per connection; DDL must call invalidate() so the next read sees
 * the new schema. All object names are bound, never interpolated.
 */
export class MetadataService {
  constructor({ manager, log, ttlMs = CACHE_TTL_MS }) {
    this.manager = manager
    this.log = log
    this.ttlMs = ttlMs
    this.cache = new Map()
  }

  key(connection, parts) {
    return `${connection}\u0000${JSON.stringify(parts)}`
  }

  async cached(connection, parts, loader) {
    const key = this.key(connection, parts)
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value
    const value = await loader()
    this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, value })
    return value
  }

  invalidate(connection) {
    if (connection === undefined) {
      this.cache.clear()
      return
    }
    const prefix = `${connection}\u0000`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  async batch(connection, queries) {
    if (queries.length === 0) return {}
    const response = await this.manager.batchQuery(connection, queries.map((query) => ({
      key: query.key,
      sql: query.sql,
      params: query.params ?? [],
    })))
    return response?.results ?? {}
  }

  async rows(connection, sql, params = []) {
    const result = await this.manager.query(connection, sql, params)
    if (Array.isArray(result)) return result
    return Array.isArray(result?.rows) ? result.rows : []
  }

  async loadRelationRows(connection, names) {
    const params = names.length > 0 ? names : ['']
    const placeholders = params.map(() => '?').join(', ')
    return this.rows(connection, `
      SELECT TRIM(RDB$RELATION_NAME) AS NAME,
             CASE WHEN RDB$VIEW_BLR IS NULL THEN 0 ELSE 1 END AS IS_VIEW,
             TRIM(RDB$OWNER_NAME) AS OWNER,
             COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
             CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
      FROM RDB$RELATIONS
      WHERE RDB$RELATION_NAME IN (${placeholders})
      ORDER BY RDB$RELATION_NAME
    `, params)
  }

  async loadProcedureRows(connection, names) {
    const params = names.length > 0 ? names : ['']
    const placeholders = params.map(() => '?').join(', ')
    return this.rows(connection, `
      SELECT TRIM(RDB$PROCEDURE_NAME) AS NAME,
             TRIM(RDB$OWNER_NAME) AS OWNER,
             COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
             COALESCE(RDB$PROCEDURE_TYPE, 0) AS PROCEDURE_TYPE,
             COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR,
             CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
      FROM RDB$PROCEDURES
      WHERE RDB$PROCEDURE_NAME IN (${placeholders})
      ORDER BY RDB$PROCEDURE_NAME
    `, params)
  }

  async loadTriggerRows(connection, names) {
    const params = names.length > 0 ? names : ['']
    const placeholders = params.map(() => '?').join(', ')
    return this.rows(connection, `
      SELECT TRIM(RDB$TRIGGER_NAME) AS NAME,
             TRIM(RDB$RELATION_NAME) AS RELATION_NAME,
             RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
             COALESCE(RDB$TRIGGER_SEQUENCE, 0) AS "SEQUENCE",
             COALESCE(RDB$TRIGGER_INACTIVE, 0) AS INACTIVE,
             COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR,
             TRIM(RDB$OWNER_NAME) AS OWNER,
             COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
             CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
      FROM RDB$TRIGGERS
      WHERE RDB$TRIGGER_NAME IN (${placeholders})
      ORDER BY RDB$TRIGGER_NAME
    `, params)
  }

  async loadGeneratorRows(connection, names) {
    const params = names.length > 0 ? names : ['']
    const placeholders = params.map(() => '?').join(', ')
    return this.rows(connection, `
      SELECT TRIM(RDB$GENERATOR_NAME) AS NAME,
             RDB$GENERATOR_ID AS GENERATOR_ID,
             COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG
      FROM RDB$GENERATORS
      WHERE RDB$GENERATOR_NAME IN (${placeholders})
      ORDER BY RDB$GENERATOR_NAME
    `, params)
  }

  async listObjects(connection, type = 'all', { includeSystem = false, filter } = {}) {
    const normalized = type === 'all' ? 'all' : normalizeType(type)
    if (normalized === 'all') {
      const groups = await Promise.all(['table', 'view', 'procedure', 'trigger', 'generator'].map((item) => (
        this.listObjects(connection, item, { includeSystem })
      )))
      const objects = groups.flatMap((group) => group.objects)
      return { connection, type: 'all', count: objects.length, objects: filterObjects(objects, filter) }
    }
    return this.cached(connection, ['list', normalized, includeSystem], async () => {
      const objects = await this.loadObjectList(connection, normalized, includeSystem)
      return { connection, type: normalized, count: objects.length, objects }
    }).then((result) => {
      const objects = filterObjects(result.objects, filter)
      return { ...result, objects, count: objects.length }
    })
  }

  async loadObjectList(connection, type, includeSystem) {
    const systemFilter = includeSystem ? '' : 'AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0'
    if (type === 'table' || type === 'view') {
      const viewCondition = type === 'view' ? 'RDB$VIEW_BLR IS NOT NULL' : 'RDB$VIEW_BLR IS NULL'
      const rows = await this.rows(connection, `
        SELECT TRIM(RDB$RELATION_NAME) AS NAME,
               TRIM(RDB$OWNER_NAME) AS OWNER,
               COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
               CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
        FROM RDB$RELATIONS
        WHERE ${viewCondition} ${systemFilter}
        ORDER BY RDB$RELATION_NAME
      `)
      return rows.map((row) => ({
        name: normalizeName(row.NAME),
        type,
        owner: normalizeName(row.OWNER),
        system: flag(row.SYSTEM_FLAG),
        description: text(row.DESCRIPTION),
      }))
    }
    if (type === 'procedure') {
      const rows = await this.rows(connection, `
        SELECT TRIM(RDB$PROCEDURE_NAME) AS NAME,
               TRIM(RDB$OWNER_NAME) AS OWNER,
               COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
               COALESCE(RDB$PROCEDURE_TYPE, 0) AS PROCEDURE_TYPE,
               COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR,
               CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
        FROM RDB$PROCEDURES
        WHERE 1 = 1 ${systemFilter}
        ORDER BY RDB$PROCEDURE_NAME
      `)
      return rows.map((row) => {
        const code = number(row.PROCEDURE_TYPE, 0)
        return {
          name: normalizeName(row.NAME),
          type: 'procedure',
          owner: normalizeName(row.OWNER),
          system: flag(row.SYSTEM_FLAG),
          procedureType: procedureType(code),
          selectable: code === 1,
          valid: number(row.VALID_BLR, 1) !== 0,
          description: text(row.DESCRIPTION),
        }
      })
    }
    if (type === 'trigger') {
      const rows = await this.rows(connection, `
        SELECT TRIM(RDB$TRIGGER_NAME) AS NAME,
               TRIM(RDB$RELATION_NAME) AS RELATION_NAME,
               RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
               COALESCE(RDB$TRIGGER_SEQUENCE, 0) AS "SEQUENCE",
               COALESCE(RDB$TRIGGER_INACTIVE, 0) AS INACTIVE,
               COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR,
               TRIM(RDB$OWNER_NAME) AS OWNER,
               COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG,
               CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
        FROM RDB$TRIGGERS
        WHERE 1 = 1 ${systemFilter}
        ORDER BY RDB$TRIGGER_NAME
      `)
      return rows.map((row) => ({
        name: normalizeName(row.NAME),
        type: 'trigger',
        relation: normalizeName(row.RELATION_NAME),
        owner: normalizeName(row.OWNER),
        system: flag(row.SYSTEM_FLAG),
        ...triggerDescription(number(row.TRIGGER_TYPE, -1)),
        sequence: number(row.SEQUENCE, 0),
        inactive: flag(row.INACTIVE),
        valid: number(row.VALID_BLR, 1) !== 0,
        description: text(row.DESCRIPTION),
      }))
    }
    const rows = await this.rows(connection, `
      SELECT TRIM(RDB$GENERATOR_NAME) AS NAME,
             RDB$GENERATOR_ID AS GENERATOR_ID,
             COALESCE(RDB$SYSTEM_FLAG, 0) AS SYSTEM_FLAG
      FROM RDB$GENERATORS
      WHERE 1 = 1 ${systemFilter}
      ORDER BY RDB$GENERATOR_NAME
    `)
    return rows.map((row) => ({
      name: normalizeName(row.NAME),
      type: 'generator',
      id: number(row.GENERATOR_ID),
      system: flag(row.SYSTEM_FLAG),
    }))
  }

  async resolveObject(connection, name, type) {
    const explicit = normalizeType(type)
    const variants = candidateNames(name)
    const desired = explicit ? [explicit] : ['table', 'view', 'procedure', 'trigger', 'generator']
    const [relations, procedures, triggers, generators] = await Promise.all([
      desired.includes('table') || desired.includes('view')
        ? this.loadRelationRows(connection, variants)
        : [],
      desired.includes('procedure') ? this.loadProcedureRows(connection, variants) : [],
      desired.includes('trigger') ? this.loadTriggerRows(connection, variants) : [],
      desired.includes('generator') ? this.loadGeneratorRows(connection, variants) : [],
    ])

    const candidates = []
    const relationRow = pickRow(relations, name)
    if (relationRow) {
      const isView = flag(relationRow.IS_VIEW)
      const actualType = isView ? 'view' : 'table'
      if (!explicit || explicit === actualType) {
        candidates.push({ type: actualType, row: relationRow })
      } else if (explicit === 'table' || explicit === 'view') {
        throw new FirebirdToolError(
          `Object "${name}" is a ${actualType}, not a ${explicit}`,
          { code: 'OBJECT_TYPE_MISMATCH' },
        )
      }
    }
    const procedureRow = pickRow(procedures, name)
    if (procedureRow && (!explicit || explicit === 'procedure')) {
      candidates.push({ type: 'procedure', row: procedureRow })
    }
    const triggerRow = pickRow(triggers, name)
    if (triggerRow && (!explicit || explicit === 'trigger')) {
      candidates.push({ type: 'trigger', row: triggerRow })
    }
    const generatorRow = pickRow(generators, name)
    if (generatorRow && (!explicit || explicit === 'generator')) {
      candidates.push({ type: 'generator', row: generatorRow })
    }

    if (candidates.length === 0) {
      throw new FirebirdToolError(
        `Object "${name}" was not found on Firebird connection "${connection}"`,
        { code: 'OBJECT_NOT_FOUND' },
      )
    }
    if (candidates.length > 1) {
      throw new FirebirdToolError(
        `Object name "${name}" matches multiple object types (${candidates.map((item) => item.type).join(', ')}); pass an explicit type`,
        { code: 'OBJECT_AMBIGUOUS' },
      )
    }
    return candidates[0]
  }

  async describeObject(connection, name, type) {
    const normalizedType = type ? normalizeType(type) : null
    return this.cached(connection, ['describe', name, normalizedType], async () => {
      const resolved = await this.resolveObject(connection, name, normalizedType)
      const actualName = normalizeName(resolved.row.NAME)
      if (resolved.type === 'table' || resolved.type === 'view') {
        return this.describeRelation(connection, actualName, resolved.type, resolved.row)
      }
      if (resolved.type === 'procedure') {
        return this.describeProcedure(connection, actualName, resolved.row)
      }
      if (resolved.type === 'trigger') {
        return this.describeTrigger(connection, actualName, resolved.row)
      }
      return {
        connection,
        name: actualName,
        type: 'generator',
        id: number(resolved.row.GENERATOR_ID),
        system: flag(resolved.row.SYSTEM_FLAG),
      }
    })
  }

  async describeRelation(connection, name, type, row) {
    const base = {
      connection,
      name,
      type,
      owner: normalizeName(row.OWNER),
      system: flag(row.SYSTEM_FLAG),
      description: text(row.DESCRIPTION),
    }
    const columnsQuery = {
      key: 'columns',
      params: [name],
      sql: `
        SELECT TRIM(rf.RDB$FIELD_NAME) AS NAME,
               rf.RDB$FIELD_POSITION AS "POSITION",
               COALESCE(rf.RDB$NULL_FLAG, 0) AS NOT_NULL,
               CAST(rf.RDB$DEFAULT_SOURCE AS VARCHAR(1024)) AS DEFAULT_SOURCE,
               CAST(rf.RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION,
               TRIM(rf.RDB$FIELD_SOURCE) AS FIELD_SOURCE,
               f.RDB$FIELD_TYPE AS FIELD_TYPE,
               f.RDB$FIELD_SUB_TYPE AS SUB_TYPE,
               f.RDB$FIELD_LENGTH AS FIELD_LENGTH,
               f.RDB$FIELD_SCALE AS FIELD_SCALE,
               f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
               f.RDB$CHARACTER_LENGTH AS "CHAR_LENGTH",
               TRIM(cs.RDB$CHARACTER_SET_NAME) AS CHARSET_NAME
        FROM RDB$RELATION_FIELDS rf
        JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
        LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = f.RDB$CHARACTER_SET_ID
        WHERE rf.RDB$RELATION_NAME = ?
        ORDER BY rf.RDB$FIELD_POSITION
      `,
    }
    const triggersQuery = {
      key: 'triggers',
      params: [name],
      sql: `
        SELECT TRIM(RDB$TRIGGER_NAME) AS NAME,
               RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
               COALESCE(RDB$TRIGGER_SEQUENCE, 0) AS "SEQUENCE",
               COALESCE(RDB$TRIGGER_INACTIVE, 0) AS INACTIVE,
               COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR,
               CAST(RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION
        FROM RDB$TRIGGERS
        WHERE RDB$RELATION_NAME = ?
        ORDER BY RDB$TRIGGER_TYPE, RDB$TRIGGER_SEQUENCE, RDB$TRIGGER_NAME
      `,
    }
    const dependenciesQuery = {
      key: 'dependencies',
      params: [name],
      sql: `
        SELECT TRIM(RDB$DEPENDENT_NAME) AS NAME,
               RDB$DEPENDENT_TYPE AS DEPENDENT_TYPE,
               TRIM(RDB$FIELD_NAME) AS FIELD_NAME
        FROM RDB$DEPENDENCIES
        WHERE RDB$DEPENDED_ON_NAME = ?
        ORDER BY RDB$DEPENDENT_NAME
      `,
    }
    if (type === 'view') {
      const results = await this.batch(connection, [columnsQuery, triggersQuery, dependenciesQuery])
      return {
        ...base,
        columns: requiredList(results, 'columns').map(normalizeColumn),
        triggers: requiredList(results, 'triggers').map(normalizeTrigger),
        dependencies: requiredList(results, 'dependencies').map(normalizeDependency),
      }
    }

    const indexesQuery = {
      key: 'indexes',
      params: [name],
      sql: `
        SELECT TRIM(i.RDB$INDEX_NAME) AS INDEX_NAME,
               COALESCE(i.RDB$UNIQUE_FLAG, 0) AS UNIQUE_FLAG,
               COALESCE(i.RDB$INDEX_TYPE, 0) AS INDEX_TYPE,
               TRIM(rc.RDB$CONSTRAINT_TYPE) AS CONSTRAINT_TYPE,
               TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME,
               s.RDB$FIELD_POSITION AS FIELD_POSITION
        FROM RDB$INDICES i
        JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
        LEFT JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$INDEX_NAME = i.RDB$INDEX_NAME
        WHERE i.RDB$RELATION_NAME = ?
        ORDER BY i.RDB$INDEX_NAME, s.RDB$FIELD_POSITION
      `,
    }
    const fksOutQuery = {
      key: 'fksOut',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS NAME,
               TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME,
               TRIM(rcu.RDB$RELATION_NAME) AS REFERENCED_TABLE,
               TRIM(ru.RDB$CONST_NAME_UQ) AS REFERENCED_CONSTRAINT,
               TRIM(ru.RDB$UPDATE_RULE) AS UPDATE_RULE,
               TRIM(ru.RDB$DELETE_RULE) AS DELETE_RULE
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rc.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME
      `,
    }
    const fksInQuery = {
      key: 'fksIn',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS NAME,
               TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME,
               TRIM(rcu.RDB$RELATION_NAME) AS REFERENCED_TABLE,
               TRIM(ru.RDB$CONST_NAME_UQ) AS REFERENCED_CONSTRAINT,
               TRIM(ru.RDB$UPDATE_RULE) AS UPDATE_RULE,
               TRIM(ru.RDB$DELETE_RULE) AS DELETE_RULE
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rcu.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME
      `,
    }
    const outChildColumns = {
      key: 'outChildColumns',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
               TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME,
               s.RDB$FIELD_POSITION AS FIELD_POSITION
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rc.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION
      `,
    }
    const outParentColumns = {
      key: 'outParentColumns',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
               TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME,
               s.RDB$FIELD_POSITION AS FIELD_POSITION
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
        JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rcu.RDB$INDEX_NAME
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rc.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION
      `,
    }
    const inChildColumns = {
      key: 'inChildColumns',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
               TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME,
               s.RDB$FIELD_POSITION AS FIELD_POSITION
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
        JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rcu.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION
      `,
    }
    const inParentColumns = {
      key: 'inParentColumns',
      params: [name],
      sql: `
        SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
               TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME,
               s.RDB$FIELD_POSITION AS FIELD_POSITION
        FROM RDB$RELATION_CONSTRAINTS rc
        JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
        JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rcu.RDB$INDEX_NAME
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rcu.RDB$RELATION_NAME = ?
        ORDER BY rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION
      `,
    }

    const results = await this.batch(connection, [
      columnsQuery,
      indexesQuery,
      fksOutQuery,
      fksInQuery,
      triggersQuery,
      dependenciesQuery,
      outChildColumns,
      outParentColumns,
      inChildColumns,
      inParentColumns,
    ])

    const outgoingColumns = columnNamesByConstraint(requiredList(results, 'outChildColumns'))
    const outgoingReferenced = columnNamesByConstraint(requiredList(results, 'outParentColumns'))
    const incomingColumns = columnNamesByConstraint(requiredList(results, 'inChildColumns'))
    const incomingReferenced = columnNamesByConstraint(requiredList(results, 'inParentColumns'))

    const outgoing = requiredList(results, 'fksOut').map(relationForeignKey).map((fk) => ({
      ...fk,
      columns: outgoingColumns.get(fk.name) ?? [],
      referencedColumns: outgoingReferenced.get(fk.name) ?? [],
    }))
    const incoming = requiredList(results, 'fksIn').map(relationForeignKey).map((fk) => ({
      ...fk,
      columns: incomingColumns.get(fk.name) ?? [],
      referencedColumns: incomingReferenced.get(fk.name) ?? [],
    }))

    return {
      ...base,
      columns: requiredList(results, 'columns').map(normalizeColumn),
      indexes: assembleIndexes(requiredList(results, 'indexes')),
      foreignKeys: { outgoing, incoming },
      triggers: requiredList(results, 'triggers').map(normalizeTrigger),
      dependencies: requiredList(results, 'dependencies').map(normalizeDependency),
    }
  }

  async describeProcedure(connection, name, row) {
    const results = await this.batch(connection, [
      {
        key: 'parameters',
        params: [name],
        sql: `
          SELECT TRIM(p.RDB$PARAMETER_NAME) AS NAME,
                 p.RDB$PARAMETER_TYPE AS PARAMETER_TYPE,
                 COALESCE(p.RDB$NULL_FLAG, 0) AS NOT_NULL,
                 p.RDB$PARAMETER_NUMBER AS "POSITION",
                 CAST(p.RDB$DESCRIPTION AS VARCHAR(2048)) AS DESCRIPTION,
                 f.RDB$FIELD_TYPE AS FIELD_TYPE,
                 f.RDB$FIELD_SUB_TYPE AS SUB_TYPE,
                 f.RDB$FIELD_LENGTH AS FIELD_LENGTH,
                 f.RDB$FIELD_SCALE AS FIELD_SCALE,
                 f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
                 f.RDB$CHARACTER_LENGTH AS "CHAR_LENGTH",
                 TRIM(cs.RDB$CHARACTER_SET_NAME) AS CHARSET_NAME
          FROM RDB$PROCEDURE_PARAMETERS p
          LEFT JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = p.RDB$FIELD_SOURCE
          LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = f.RDB$CHARACTER_SET_ID
          WHERE p.RDB$PROCEDURE_NAME = ?
          ORDER BY p.RDB$PARAMETER_TYPE, p.RDB$PARAMETER_NUMBER
        `,
      },
      {
        key: 'dependencies',
        params: [name],
        sql: `
          SELECT TRIM(RDB$DEPENDENT_NAME) AS NAME,
                 RDB$DEPENDENT_TYPE AS DEPENDENT_TYPE,
                 TRIM(RDB$FIELD_NAME) AS FIELD_NAME
          FROM RDB$DEPENDENCIES
          WHERE RDB$DEPENDED_ON_NAME = ?
          ORDER BY RDB$DEPENDENT_NAME
        `,
      },
    ])
    const params = requiredList(results, 'parameters').map(normalizeParameter)
    const code = number(row.PROCEDURE_TYPE, 0)
    return {
      connection,
      name,
      type: 'procedure',
      owner: normalizeName(row.OWNER),
      system: flag(row.SYSTEM_FLAG),
      procedureType: procedureType(code),
      selectable: code === 1,
      valid: number(row.VALID_BLR, 1) !== 0,
      description: text(row.DESCRIPTION),
      parameters: {
        input: params.filter((param) => param.mode === 'input'),
        output: params.filter((param) => param.mode === 'output'),
      },
      dependencies: requiredList(results, 'dependencies').map(normalizeDependency),
    }
  }

  async describeTrigger(connection, name, row) {
    const results = await this.batch(connection, [{
      key: 'dependencies',
      params: [name],
      sql: `
        SELECT TRIM(RDB$DEPENDENT_NAME) AS NAME,
               RDB$DEPENDENT_TYPE AS DEPENDENT_TYPE,
               TRIM(RDB$FIELD_NAME) AS FIELD_NAME
        FROM RDB$DEPENDENCIES
        WHERE RDB$DEPENDED_ON_NAME = ?
        ORDER BY RDB$DEPENDENT_NAME
      `,
    }])
    return {
      connection,
      name,
      type: 'trigger',
      relation: normalizeName(row.RELATION_NAME),
      owner: normalizeName(row.OWNER),
      system: flag(row.SYSTEM_FLAG),
      ...triggerDescription(number(row.TRIGGER_TYPE, -1)),
      sequence: number(row.SEQUENCE, 0),
      inactive: flag(row.INACTIVE),
      valid: number(row.VALID_BLR, 1) !== 0,
      description: text(row.DESCRIPTION),
      dependencies: requiredList(results, 'dependencies').map(normalizeDependency),
    }
  }

  async dependents(connection, name) {
    const rows = await this.rows(connection, `
      SELECT TRIM(RDB$DEPENDENT_NAME) AS NAME,
             RDB$DEPENDENT_TYPE AS DEPENDENT_TYPE,
             TRIM(RDB$FIELD_NAME) AS FIELD_NAME
      FROM RDB$DEPENDENCIES
      WHERE RDB$DEPENDED_ON_NAME = ?
      ORDER BY RDB$DEPENDENT_NAME
    `, [name])
    return rows.map(normalizeDependency)
  }

  async incomingForeignKeys(connection, table) {
    const rows = await this.rows(connection, `
      SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS NAME,
             TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME,
             TRIM(rcu.RDB$RELATION_NAME) AS REFERENCED_TABLE,
             TRIM(ru.RDB$CONST_NAME_UQ) AS REFERENCED_CONSTRAINT,
             TRIM(ru.RDB$UPDATE_RULE) AS UPDATE_RULE,
             TRIM(ru.RDB$DELETE_RULE) AS DELETE_RULE
      FROM RDB$RELATION_CONSTRAINTS rc
      JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
      JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
      WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rcu.RDB$RELATION_NAME = ?
      ORDER BY rc.RDB$CONSTRAINT_NAME
    `, [table])
    return rows.map(relationForeignKey)
  }

  async columnUsage(connection, table, column) {
    const results = await this.batch(connection, [
      {
        key: 'dependencies',
        params: [table, column],
        sql: `
          SELECT TRIM(RDB$DEPENDENT_NAME) AS NAME,
                 RDB$DEPENDENT_TYPE AS DEPENDENT_TYPE,
                 TRIM(RDB$FIELD_NAME) AS FIELD_NAME
          FROM RDB$DEPENDENCIES
          WHERE RDB$DEPENDED_ON_NAME = ? AND RDB$FIELD_NAME = ?
          ORDER BY RDB$DEPENDENT_NAME
        `,
      },
      {
        key: 'indexes',
        params: [table, column],
        sql: `
          SELECT TRIM(i.RDB$INDEX_NAME) AS NAME
          FROM RDB$INDICES i
          JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
          WHERE i.RDB$RELATION_NAME = ? AND s.RDB$FIELD_NAME = ?
          ORDER BY i.RDB$INDEX_NAME
        `,
      },
      {
        key: 'foreignKeys',
        params: [table, column, table, column],
        sql: `
          SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS NAME,
                 'child' AS SIDE,
                 TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME
          FROM RDB$RELATION_CONSTRAINTS rc
          JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
          WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rc.RDB$RELATION_NAME = ? AND s.RDB$FIELD_NAME = ?
          UNION ALL
          SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS NAME,
                 'parent' AS SIDE,
                 TRIM(rcu.RDB$RELATION_NAME) AS TABLE_NAME
          FROM RDB$RELATION_CONSTRAINTS rc
          JOIN RDB$REF_CONSTRAINTS ru ON ru.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
          JOIN RDB$RELATION_CONSTRAINTS rcu ON rcu.RDB$CONSTRAINT_NAME = ru.RDB$CONST_NAME_UQ
          JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rcu.RDB$INDEX_NAME
          WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' AND rcu.RDB$RELATION_NAME = ? AND s.RDB$FIELD_NAME = ?
          ORDER BY 1
        `,
      },
    ])
    return {
      connection,
      table,
      column,
      dependencies: requiredList(results, 'dependencies').map(normalizeDependency),
      indexes: requiredList(results, 'indexes').map((row) => normalizeName(row.NAME)).filter(Boolean),
      foreignKeys: requiredList(results, 'foreignKeys').map((row) => ({
        name: normalizeName(row.NAME),
        side: normalizeName(row.SIDE),
        table: normalizeName(row.TABLE_NAME),
      })),
    }
  }

  async checkProcedureExecute(connection, name) {
    const variants = candidateNames(name)
    const placeholders = variants.map(() => '?').join(', ')
    const results = await this.batch(connection, [
      {
        key: 'procedures',
        params: variants,
        sql: `
          SELECT TRIM(RDB$PROCEDURE_NAME) AS NAME,
                 TRIM(RDB$OWNER_NAME) AS OWNER,
                 COALESCE(RDB$PROCEDURE_TYPE, 0) AS PROCEDURE_TYPE,
                 COALESCE(RDB$VALID_BLR, 1) AS VALID_BLR
          FROM RDB$PROCEDURES
          WHERE RDB$PROCEDURE_NAME IN (${placeholders})
          ORDER BY RDB$PROCEDURE_NAME
        `,
      },
      {
        key: 'inputCount',
        params: variants,
        sql: `
          SELECT COUNT(*) AS INPUT_COUNT
          FROM RDB$PROCEDURE_PARAMETERS
          WHERE RDB$PROCEDURE_NAME IN (${placeholders}) AND RDB$PARAMETER_TYPE = 0
        `,
      },
      {
        key: 'grants',
        params: variants,
        sql: `
          SELECT TRIM(RDB$USER) AS GRANTEE,
                 TRIM(RDB$PRIVILEGE) AS PRIVILEGE,
                 COALESCE(RDB$GRANT_OPTION, 0) AS GRANT_OPTION
          FROM RDB$USER_PRIVILEGES
          WHERE RDB$RELATION_NAME IN (${placeholders}) AND TRIM(RDB$PRIVILEGE) = 'EXECUTE'
          ORDER BY RDB$USER
        `,
      },
      {
        key: 'context',
        params: [],
        sql: `
          SELECT TRIM(CURRENT_USER) AS CURRENT_USER_NAME
          FROM RDB$DATABASE
        `,
      },
    ])
    const procedure = pickRow(requiredList(results, 'procedures'), name)
    if (!procedure) {
      return { exists: false, allowed: false, procedure: name, grants: [] }
    }
    const actualName = normalizeName(procedure.NAME)
    const owner = normalizeName(procedure.OWNER)
    const code = number(procedure.PROCEDURE_TYPE, 0)
    const inputCount = number(requiredList(results, 'inputCount')[0]?.INPUT_COUNT, 0)
    const currentUser = normalizeName(requiredList(results, 'context')[0]?.CURRENT_USER_NAME) ?? ''
    let activeRole = null
    try {
      activeRole = this.manager.describe(connection).activeRole
    } catch {
      activeRole = null
    }
    const grants = requiredList(results, 'grants')
      .map((row) => ({
        grantee: normalizeName(row.GRANTEE),
        grantOption: flag(row.GRANT_OPTION),
      }))
      .filter((grant) => grant.grantee)
    const user = currentUser.toUpperCase()
    const role = activeRole ? activeRole.toUpperCase() : null
    const granteeMatches = grants.some((grant) => {
      const grantee = grant.grantee.toUpperCase()
      return grantee === user || grantee === 'PUBLIC' || (role !== null && grantee === role)
    })
    const allowed = user === 'SYSDBA' || (owner !== null && owner.toUpperCase() === user) || granteeMatches
    let reason
    if (!allowed) {
      reason = `User ${currentUser || '(unknown)'} has no EXECUTE privilege on procedure ${actualName}`
      if (role) reason += ` and active role ${activeRole} does not grant it`
      reason += '; grant EXECUTE or connect with a role that has it'
    }
    return {
      exists: true,
      allowed,
      procedure: actualName,
      owner,
      currentUser,
      activeRole,
      procedureType: procedureType(code),
      selectable: code === 1,
      inputCount,
      valid: number(procedure.VALID_BLR, 1) !== 0,
      grants,
      reason,
    }
  }

  async invalidObjects(connection) {
    const rows = await this.rows(connection, `
      SELECT TRIM(RDB$PROCEDURE_NAME) AS NAME, 'procedure' AS KIND
      FROM RDB$PROCEDURES
      WHERE COALESCE(RDB$VALID_BLR, 1) = 0
      UNION ALL
      SELECT TRIM(RDB$TRIGGER_NAME) AS NAME, 'trigger' AS KIND
      FROM RDB$TRIGGERS
      WHERE COALESCE(RDB$VALID_BLR, 1) = 0
      ORDER BY 1
    `)
    return rows.map((row) => ({
      name: normalizeName(row.NAME),
      kind: normalizeName(row.KIND),
    })).filter((row) => row.name)
  }

  async ddlWarnings(connection, target, before = []) {
    let after = []
    try {
      after = await this.dependents(connection, target)
    } catch (error) {
      this.log?.warn(`cannot read dependencies for ${target}: ${safeErrorMessage(error)}`)
    }
    let invalid = []
    try {
      invalid = await this.invalidObjects(connection)
    } catch (error) {
      this.log?.warn(`cannot read invalid objects: ${safeErrorMessage(error)}`)
    }
    const warnings = []
    const seen = new Set()
    for (const dependency of [...before, ...after]) {
      const key = `dep:${dependency.type}:${dependency.name}:${dependency.field ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      let message = `Dependent ${dependency.type} ${dependency.name} references ${target}`
      if (dependency.field) message += ` column ${dependency.field}`
      message += '; verify it is still valid.'
      warnings.push(message)
    }
    for (const object of invalid) {
      const key = `invalid:${object.kind}:${object.name}`
      if (seen.has(key)) continue
      seen.add(key)
      warnings.push(`${object.kind} ${object.name} has an invalid BLR and may need to be recompiled.`)
    }
    return warnings
  }
}

function filterObjects(objects, filter) {
  if (!filter) return objects
  const needle = String(filter).toLowerCase()
  return objects.filter((object) => (
    String(object.name ?? '').toLowerCase().includes(needle)
    || String(object.relation ?? '').toLowerCase().includes(needle)
  ))
}

export { formatField, normalizeType }
