import { tokenize, isWord, isIdentifier, nameOf } from './tokenize.js'
import { invalid } from '../errors.js'

const DML_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
const ROUTINE_OBJECTS = new Set(['PROCEDURE', 'TRIGGER', 'FUNCTION'])

const DDL_TYPES = new Map([
  ['TABLE', 'table'],
  ['VIEW', 'view'],
  ['INDEX', 'index'],
  ['PROCEDURE', 'procedure'],
  ['TRIGGER', 'trigger'],
  ['FUNCTION', 'function'],
  ['GENERATOR', 'generator'],
  ['SEQUENCE', 'generator'],
  ['DATABASE', 'database'],
  ['USER', 'user'],
  ['ROLE', 'role'],
  ['EXCEPTION', 'exception'],
  ['DOMAIN', 'domain'],
  ['COLLATION', 'collation'],
  ['PACKAGE', 'package'],
])

const CLAUSE_KEYWORDS = new Set([
  'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL',
  'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'PLAN', 'UNION', 'INTERSECT',
  'MINUS', 'EXCEPT', 'ROWS', 'OFFSET', 'FETCH', 'FOR', 'INTO', 'VALUES',
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SET', 'AS', 'WHEN', 'THEN',
  'ELSE', 'END', 'BEGIN', 'DO', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN',
  'EXISTS', 'BETWEEN', 'LIKE', 'CONTAINING', 'STARTING', 'SIMILAR', 'TO',
  'ESCAPE', 'COLLATE', 'RETURNING', 'WITH', 'RECURSIVE', 'DISTINCT', 'ALL',
  'CASE', 'CAST', 'EXECUTE', 'PROCEDURE', 'BLOCK', 'DECLARE', 'SUSPEND',
  'EXIT', 'CONTINUE', 'WHILE', 'IF', 'AT', 'FIRST', 'SKIP', 'CASCADE',
  'RESTRICT', 'DEFAULT', 'ACTION', 'CONSTRAINT', 'PRIMARY', 'FOREIGN',
  'UNIQUE', 'CHECK', 'REFERENCES', 'GLOBAL', 'TEMPORARY', 'EXTERNAL',
])

const UPDATE_FALSE_TARGETS = new Set([
  'OR', 'ON', 'SET', 'CASCADE', 'RESTRICT', 'NULL', 'DEFAULT', 'NO', 'ACTION',
  'CURRENT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK',
])

const DROP_NON_COLUMN = new Set([
  'CONSTRAINT', 'NOT', 'DEFAULT', 'NULL', 'PRIMARY', 'FOREIGN', 'UNIQUE',
  'CHECK', 'REFERENCES', 'STATISTICS',
])

function isPunct(token, value) {
  return token?.kind === 'punct' && token.value === value
}

function isReserved(token) {
  return token?.kind === 'word' && CLAUSE_KEYWORDS.has(token.upper)
}

function canonicalName(token) {
  if (!isIdentifier(token)) return undefined
  return token.kind === 'ident' ? token.value : token.value.toUpperCase()
}

function matchingParen(tokens, openIndex) {
  if (!isPunct(tokens[openIndex], '(')) return -1
  const depth = tokens[openIndex].depth
  for (let i = openIndex + 1; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], ')') && tokens[i].depth === depth) return i
  }
  return -1
}

function readQualifiedName(tokens, start) {
  if (!isIdentifier(tokens[start]) || isReserved(tokens[start])) return null
  const segments = [tokens[start]]
  let i = start + 1
  while (isPunct(tokens[i], '.') && isIdentifier(tokens[i + 1]) && !isReserved(tokens[i + 1])) {
    segments.push(tokens[i + 1])
    i += 2
  }
  return {
    first: start,
    next: i,
    name: canonicalName(segments[segments.length - 1]),
    schema: segments.length > 1 ? canonicalName(segments[segments.length - 2]) : undefined,
    display: segments.map((token) => token.raw).join('.'),
  }
}

function parseWithClause(tokens, start) {
  let i = start + 1
  if (isWord(tokens[i], 'RECURSIVE')) i += 1
  const names = []
  const entries = []
  for (;;) {
    if (!isIdentifier(tokens[i])) return null
    const nameToken = tokens[i]
    const nameStart = i
    i += 1
    if (isPunct(tokens[i], '(')) {
      const close = matchingParen(tokens, i)
      if (close < 0) return null
      i = close + 1
    }
    if (!isWord(tokens[i], 'AS')) return null
    i += 1
    if (!isPunct(tokens[i], '(')) return null
    const close = matchingParen(tokens, i)
    if (close < 0) return null
    names.push(canonicalName(nameToken))
    entries.push({ name: canonicalName(nameToken), nameStart })
    i = close + 1
    if (isPunct(tokens[i], ',')) {
      i += 1
      continue
    }
    break
  }
  return { end: i, names, entries }
}

/**
 * Collect CTE names with their lexical scope. A CTE declared inside a
 * subquery must never mask an outer physical table with the same name during
 * whitelist checks, so names are only treated as CTEs between their
 * declaration and the end of the enclosing parenthesized scope.
 */
function collectCteScopes(tokens) {
  const scopes = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isWord(tokens[i], 'WITH')) continue
    const parsed = parseWithClause(tokens, i)
    if (!parsed) continue
    const depth = tokens[i].depth
    let scopeEnd = tokens.length
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (tokens[j].depth < depth) {
        scopeEnd = j
        break
      }
    }
    for (const entry of parsed.entries) {
      scopes.push({ name: entry.name, start: entry.nameStart, end: scopeEnd })
    }
  }
  return scopes
}

function findMainIndex(tokens, start) {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.depth !== 0 || token.kind !== 'word') continue
    if (token.upper === 'SELECT' || DML_VERBS.has(token.upper)) return i
  }
  return -1
}

function parseDdl(tokens, verbIndex) {
  const action = tokens[verbIndex].upper
  let i = verbIndex + 1
  let orAlter = false
  let temporary = false

  if (action === 'CREATE' && isWord(tokens[i], 'OR') && isWord(tokens[i + 1], 'ALTER')) {
    orAlter = true
    i += 2
  }
  if (isWord(tokens[i], 'GLOBAL') && isWord(tokens[i + 1], 'TEMPORARY')) {
    temporary = true
    i += 2
  }
  if (isWord(tokens[i], 'UNIQUE')) i += 1
  if (isWord(tokens[i], 'ASCENDING') || isWord(tokens[i], 'DESCENDING')) i += 1
  if (isWord(tokens[i], 'EXTERNAL')) i += 1

  const typeToken = tokens[i]
  if (typeToken?.kind !== 'word') {
    return { action, objectType: null, name: null, orAlter, temporary }
  }
  const objectType = DDL_TYPES.get(typeToken.upper) ?? typeToken.upper.toLowerCase()
  i += 1

  let ifExists = false
  if (isWord(tokens[i], 'IF')) {
    i += isWord(tokens[i + 1], 'NOT') ? 2 : 1
    if (isWord(tokens[i], 'EXISTS')) {
      ifExists = true
      i += 1
    }
  }

  let target = null
  if (objectType !== 'database') {
    target = readQualifiedName(tokens, i)
    if (!target && tokens[i]?.kind === 'string') {
      target = {
        first: i,
        next: i + 1,
        name: tokens[i].value,
        schema: undefined,
        display: tokens[i].raw,
      }
    }
  } else if (tokens[i]?.kind === 'string' || isIdentifier(tokens[i])) {
    target = {
      first: i,
      next: i + 1,
      name: tokens[i].kind === 'string' ? tokens[i].value : canonicalName(tokens[i]),
      schema: undefined,
      display: tokens[i].raw,
    }
  }

  let dropColumn
  if (action === 'ALTER' && objectType === 'table' && target) {
    for (let j = target.next; j < tokens.length; j += 1) {
      if (tokens[j].depth !== 0) continue
      if (!isWord(tokens[j], 'DROP')) continue
      const column = tokens[j + 1]?.kind === 'word' && tokens[j + 1].upper === 'COLUMN'
        ? tokens[j + 2]
        : tokens[j + 1]
      if (!isIdentifier(column)) break
      if (column.kind === 'word' && DROP_NON_COLUMN.has(column.upper)) continue
      dropColumn = {
        name: canonicalName(column),
        display: column.raw,
      }
      break
    }
  }

  let onObject = null
  if ((objectType === 'index' || objectType === 'trigger') && target) {
    for (let j = target.next; j < tokens.length; j += 1) {
      if (tokens[j].depth !== 0) continue
      if (isWord(tokens[j], 'AS') || isWord(tokens[j], 'BEGIN')) break
      const isAnchor = objectType === 'index' ? isWord(tokens[j], 'ON') : isWord(tokens[j], 'ON') || isWord(tokens[j], 'FOR')
      if (!isAnchor) continue
      onObject = readQualifiedName(tokens, j + 1)
      break
    }
  }

  return {
    action,
    objectType,
    target,
    ifExists,
    orAlter,
    temporary,
    dropColumn,
    onObject,
  }
}

function classify(tokens) {
  let i = 0
  let explain = false
  if (isWord(tokens[0], 'EXPLAIN')) {
    explain = true
    i = 1
    while (isWord(tokens[i], 'PLAN') || isWord(tokens[i], 'ANALYZE') || isWord(tokens[i], 'FOR')) i += 1
  }

  let withClause = null
  if (isWord(tokens[i], 'WITH')) {
    withClause = parseWithClause(tokens, i)
    if (!withClause) throw invalid('Malformed WITH clause', 'SYNTAX')
    const mainIndex = findMainIndex(tokens, withClause.end)
    if (mainIndex < 0) throw invalid('WITH clause is not followed by a query or DML statement', 'SYNTAX')
    const verb = tokens[mainIndex].upper
    const kind = explain ? 'explain' : (verb === 'SELECT' ? 'query' : 'dml')
    return {
      kind,
      explain,
      mainIndex,
      startIndex: i,
      withClause,
      firstKeyword: tokens[i]?.upper ?? null,
    }
  }

  const first = tokens[i]
  let kind = 'other'
  let mainIndex = -1
  if (first?.kind === 'word') {
    const upper = first.upper
    if (upper === 'SELECT') {
      kind = explain ? 'explain' : 'query'
      mainIndex = i
    } else if (DML_VERBS.has(upper)) {
      kind = explain ? 'explain' : 'dml'
      mainIndex = i
    } else if (!explain && (upper === 'CREATE' || upper === 'ALTER' || upper === 'DROP' || upper === 'RECREATE')) {
      kind = 'ddl'
    } else if (!explain && (upper === 'GRANT' || upper === 'REVOKE')) {
      kind = 'privilege'
    } else if (!explain && upper === 'EXECUTE') {
      if (isWord(tokens[i + 1], 'PROCEDURE')) kind = 'call'
      else if (isWord(tokens[i + 1], 'BLOCK')) kind = 'block'
    }
  }

  return {
    kind,
    explain,
    mainIndex,
    startIndex: i,
    withClause,
    firstKeyword: first?.upper ?? null,
  }
}

/**
 * Parse one Firebird DSQL statement into the facts policy needs: its kind,
 * written/read object references, WHERE presence, DDL target and system-table
 * writes. Anything ambiguous fails closed as a denial.
 */
export function analyzeSql(sql) {
  let tokens
  try {
    tokens = tokenize(sql)
  } catch (error) {
    throw invalid(`SQL parse error: ${error.message}`, 'SYNTAX')
  }

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (isPunct(last, ';') && last.depth === 0) tokens.pop()
    else break
  }
  const normalizedSql = sql.slice(tokens[0].start, tokens[tokens.length - 1].end)

  const classification = classify(tokens)
  const verbIndex = classification.mainIndex
  const mainVerb = verbIndex >= 0 ? tokens[verbIndex].upper : tokens[0]?.upper ?? null

  let ddl = null
  if (classification.kind === 'ddl') {
    ddl = parseDdl(tokens, classification.startIndex)
  }

  const routineBody = classification.kind === 'block'
    || (ddl && ['CREATE', 'ALTER', 'RECREATE'].includes(ddl.action) && ROUTINE_OBJECTS.has(ddl.objectType?.toUpperCase?.() ?? ''))
  if (tokens.some((token) => isPunct(token, ';') && token.depth === 0)) {
    if (!routineBody) {
      throw invalid('Multiple SQL statements are not allowed', 'MULTI_STATEMENT')
    }
  }

  const cteScopes = collectCteScopes(tokens)
  const ctes = new Set(cteScopes.map((scope) => scope.name))
  const objects = []
  const seen = new Set()
  const writesSystemTable = { value: false }

  const isCteRef = (name) => !name.schema && name.first !== undefined
    && cteScopes.some((scope) => (
      scope.name === name.name && name.first >= scope.start && name.first < scope.end
    ))

  const addNameRef = (name, context, write) => {
    if (!name) return
    if (!write && isCteRef(name)) return
    const key = `${name.schema ?? ''}.${name.name}:${context}:${write ? 'w' : 'r'}`
    if (seen.has(key)) return
    seen.add(key)
    objects.push({
      name: name.name,
      schema: name.schema,
      display: name.display,
      context,
      write,
    })
    if (write && name.name.toUpperCase().startsWith('RDB$')) writesSystemTable.value = true
  }

  const afterAlias = (tokens, start, depth) => {
    let i = start
    if (isWord(tokens[i], 'AS') && isIdentifier(tokens[i + 1])) return i + 2
    if (isIdentifier(tokens[i]) && !isReserved(tokens[i])) return i + 1
    return i
  }

  const captureFromList = (start, depth, context) => {
    let i = start
    while (i < tokens.length) {
      const token = tokens[i]
      if (!token || token.depth !== depth || isPunct(token, ';') || isPunct(token, ')')) break
      if (isReserved(token)) break
      if (isPunct(token, '(')) {
        const close = matchingParen(tokens, i)
        if (close < 0) break
        i = afterAlias(tokens, close + 1, depth)
        if (isPunct(tokens[i], ',') && tokens[i].depth === depth) {
          i += 1
          continue
        }
        break
      }
      const name = readQualifiedName(tokens, i)
      if (!name) break
      addNameRef(name, context, false)
      i = name.next
      if (isPunct(tokens[i], '(') && tokens[i].depth === depth) {
        const close = matchingParen(tokens, i)
        if (close < 0) break
        i = close + 1
      }
      i = afterAlias(tokens, i, depth)
      if (isPunct(tokens[i], ',') && tokens[i].depth === depth) {
        i += 1
        continue
      }
      break
    }
  }

  const pendingSelect = new Set()
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (isPunct(token, ')')) {
      for (const depth of [...pendingSelect]) {
        if (depth > token.depth) pendingSelect.delete(depth)
      }
      continue
    }
    if (token.kind !== 'word') continue

    switch (token.upper) {
      case 'SELECT':
        pendingSelect.add(token.depth)
        break
      case 'FROM':
        if (pendingSelect.has(token.depth)) {
          pendingSelect.delete(token.depth)
          captureFromList(i + 1, token.depth, 'from')
        } else if ((classification.kind === 'dml' || classification.kind === 'explain') && token.depth === 0 && mainVerb !== 'DELETE') {
          captureFromList(i + 1, token.depth, 'from')
        }
        break
      case 'JOIN': {
        const name = readQualifiedName(tokens, i + 1)
        if (name) addNameRef(name, 'join', false)
        break
      }
      case 'INSERT':
        if (isWord(tokens[i + 1], 'INTO')) {
          const name = readQualifiedName(tokens, i + 2)
          if (name) addNameRef(name, 'insert', true)
        }
        break
      case 'UPDATE': {
        const next = tokens[i + 1]
        if (isIdentifier(next) && !(next.kind === 'word' && UPDATE_FALSE_TARGETS.has(next.upper))) {
          const name = readQualifiedName(tokens, i + 1)
          if (name) addNameRef(name, 'update', true)
        }
        break
      }
      case 'DELETE':
        if (isWord(tokens[i + 1], 'FROM')) {
          const name = readQualifiedName(tokens, i + 2)
          if (name) addNameRef(name, 'delete', true)
        }
        break
      case 'MERGE':
        if (isWord(tokens[i + 1], 'INTO')) {
          const name = readQualifiedName(tokens, i + 2)
          if (name) addNameRef(name, 'merge', true)
        }
        break
      case 'USING': {
        const name = readQualifiedName(tokens, i + 1)
        if (name) addNameRef(name, 'using', false)
        break
      }
      case 'REFERENCES': {
        const name = readQualifiedName(tokens, i + 1)
        if (name) addNameRef(name, 'references', false)
        break
      }
      case 'EXECUTE':
        if (isWord(tokens[i + 1], 'PROCEDURE')) {
          const name = readQualifiedName(tokens, i + 2)
          if (name) addNameRef(name, 'execute-procedure', false)
        }
        break
      default:
        break
    }
  }

  if (ddl) {
    if (ddl.onObject) addNameRef(ddl.onObject, 'on-object', false)
    if (ddl.target) {
      if (ddl.target.name?.toUpperCase().startsWith('RDB$')) writesSystemTable.value = true
      if (['table', 'view', 'procedure', 'function'].includes(ddl.objectType)) {
        addNameRef(ddl.target, 'ddl-target', true)
      }
    }
  }

  const executesBlock = classification.kind === 'block'
  const hasWhere = tokens.some((token) => token.depth === 0 && isWord(token, 'WHERE'))
  const isUpsert = mainVerb === 'UPDATE' && tokens.some((token, index) => (
    index > verbIndex && token.depth === 0 && isWord(token, 'OR') && isWord(tokens[index + 1], 'INSERT')
  ))

  return {
    sql: normalizedSql,
    tokens,
    firstKeyword: tokens[0]?.upper ?? null,
    mainVerb,
    kind: classification.kind,
    explain: classification.explain,
    isQuery: classification.kind === 'query' || classification.kind === 'explain',
    isDdl: classification.kind === 'ddl',
    ctes,
    objects,
    writeObjects: objects.filter((object) => object.write),
    writesSystemTable: writesSystemTable.value,
    executesBlock,
    hasWhere,
    isUpsert,
    ddl,
  }
}

const normalizeAllowed = (entry) => String(entry).trim().toUpperCase()

/** Case-insensitive whitelist match; `SCHEMA.TABLE` or a bare object name is accepted. */
export function isObjectAllowed(ref, allowedObjects) {
  if (!allowedObjects || allowedObjects.length === 0) return true
  const bare = ref.name.toUpperCase()
  const full = ref.schema ? `${ref.schema}.${ref.name}`.toUpperCase() : bare
  return allowedObjects.some((entry) => {
    const allowed = normalizeAllowed(entry)
    if (allowed === full || allowed === bare) return true
    // An unqualified reference may resolve to the schema named in the whitelist;
    // a reference to a different explicit schema must not borrow that entry.
    return !ref.schema && allowed.split('.').pop() === bare
  })
}

/** The first object reference outside the whitelist, or undefined. */
export function findDisallowedObject(analysis, allowedObjects) {
  return analysis.objects.find((ref) => !isObjectAllowed(ref, allowedObjects))
}

export { nameOf }
