const WORD_START = /[A-Za-z_]/
const WORD_PART = /[A-Za-z0-9_$#]/

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9'
}

function readQuoted(sql, start, quote, kind) {
  let value = ''
  let i = start + 1
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        value += quote
        i += 2
        continue
      }
      return {
        token: { kind, value, raw: sql.slice(start, i + 1), start, end: i + 1 },
        next: i + 1,
      }
    }
    value += ch
    i += 1
  }
  throw new SyntaxError(`unterminated ${kind === 'string' ? 'string literal' : 'quoted identifier'}`)
}

function readNumber(sql, start) {
  let i = start
  if (sql[i] === '+' || sql[i] === '-') i += 1
  while (isDigit(sql[i])) i += 1
  if (sql[i] === '.') {
    i += 1
    while (isDigit(sql[i])) i += 1
  }
  if (sql[i] === 'e' || sql[i] === 'E') {
    let j = i + 1
    if (sql[j] === '+' || sql[j] === '-') j += 1
    if (isDigit(sql[j])) {
      i = j + 1
      while (isDigit(sql[i])) i += 1
    }
  }
  return i
}

/**
 * Tokenize Firebird SQL without mistaking string/comment/quoted-identifier
 * contents for syntax. Comments are dropped. The parser is intentionally
 * conservative and fails closed on unterminated literals or comments.
 */
export function tokenize(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new SyntaxError('SQL must be a non-empty string')
  }
  const tokens = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (isSpace(ch)) {
      i += 1
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      if (depth !== 0) throw new SyntaxError('unterminated block comment')
      continue
    }
    if (ch === "'") {
      const read = readQuoted(sql, i, "'", 'string')
      tokens.push(read.token)
      i = read.next
      continue
    }
    if (ch === '"') {
      const read = readQuoted(sql, i, '"', 'ident')
      tokens.push(read.token)
      i = read.next
      continue
    }
    if (ch === '?') {
      tokens.push({ kind: 'param', value: '?', raw: '?', start: i, end: i + 1 })
      i += 1
      continue
    }
    if (ch === ':') {
      if (sql[i + 1] === ':') {
        tokens.push({ kind: 'op', value: '::', raw: '::', start: i, end: i + 2 })
        i += 2
        continue
      }
      let j = i + 1
      if (WORD_START.test(sql[j] ?? '')) {
        j += 1
        while (j < sql.length && WORD_PART.test(sql[j])) j += 1
        const name = sql.slice(i + 1, j)
        tokens.push({
          kind: 'param',
          value: name,
          raw: sql.slice(i, j),
          named: true,
          start: i,
          end: j,
        })
        i = j
        continue
      }
      tokens.push({ kind: 'punct', value: ':', raw: ':', start: i, end: i + 1 })
      i += 1
      continue
    }
    if (isDigit(ch) || ((ch === '+' || ch === '-') && isDigit(sql[i + 1])) || (ch === '.' && isDigit(sql[i + 1]))) {
      const end = readNumber(sql, i)
      tokens.push({
        kind: 'number',
        value: sql.slice(i, end),
        raw: sql.slice(i, end),
        start: i,
        end,
      })
      i = end
      continue
    }
    if (WORD_START.test(ch)) {
      let j = i + 1
      while (j < sql.length && WORD_PART.test(sql[j])) j += 1
      const raw = sql.slice(i, j)
      tokens.push({ kind: 'word', value: raw, upper: raw.toUpperCase(), raw, start: i, end: j })
      i = j
      continue
    }
    const two = sql.slice(i, i + 2)
    if (['<=', '>=', '<>', '!=', '||', '=>', '->'].includes(two)) {
      tokens.push({ kind: 'op', value: two, raw: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    tokens.push({ kind: 'punct', value: ch, raw: ch, start: i, end: i + 1 })
    i += 1
  }
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ')') depth = Math.max(0, depth - 1)
    token.depth = depth
    if (token.kind === 'punct' && token.value === '(') depth += 1
  }
  return tokens
}

export function significantTokens(sql) {
  return tokenize(sql)
}

export function isWord(token, word) {
  return token?.kind === 'word' && token.upper === word
}

export function isIdentifier(token) {
  return token?.kind === 'word' || token?.kind === 'ident'
}

export function nameOf(token) {
  if (!isIdentifier(token)) return undefined
  return token.kind === 'ident' ? token.value : token.value.toUpperCase()
}
