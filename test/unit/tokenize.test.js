import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../../src/sql/tokenize.js'

test('tokenize keeps literals, quoted identifiers, numbers and parameters', () => {
  const tokens = tokenize("SELECT 'it''s' AS \"Full Name\", 1.5e2 FROM t WHERE x = :id AND y = ?")
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.value]),
    [
      ['word', 'SELECT'],
      ['string', "it's"],
      ['word', 'AS'],
      ['ident', 'Full Name'],
      ['punct', ','],
      ['number', '1.5e2'],
      ['word', 'FROM'],
      ['word', 't'],
      ['word', 'WHERE'],
      ['word', 'x'],
      ['punct', '='],
      ['param', 'id'],
      ['word', 'AND'],
      ['word', 'y'],
      ['punct', '='],
      ['param', '?'],
    ],
  )
  assert.equal(tokens[11].named, true)
  assert.equal(tokens[15].named, undefined)
})

test('tokenize drops comments including nested block comments', () => {
  const tokens = tokenize('SELECT /* outer /* inner */ still outer */ 1 -- line\nFROM /*x*/ t')
  assert.deepEqual(tokens.map((token) => token.value), ['SELECT', '1', 'FROM', 't'])
})

test('tokenize assigns parenthesis depth and treats :: as one operator', () => {
  const tokens = tokenize('SELECT (SELECT 1)::VARCHAR(2) FROM T')
  const select = tokens.find((token) => token.upper === 'SELECT' && token.depth === 1)
  assert.equal(select.depth, 1)
  assert.equal(tokens.find((token) => token.value === ')').depth, 0)
  assert.equal(tokens.find((token) => token.value === '::').kind, 'op')
  const number = tokens.find((token) => token.kind === 'number')
  assert.equal(number.depth, 1)
})

test('tokenize fails closed on unterminated literals and comments', () => {
  assert.throws(() => tokenize("SELECT 'oops"), /unterminated string literal/)
  assert.throws(() => tokenize('SELECT "oops'), /unterminated quoted identifier/)
  assert.throws(() => tokenize('SELECT /* oops'), /unterminated block comment/)
  assert.throws(() => tokenize('   '), /non-empty/)
})

test('tokenize handles signed and decimal numbers', () => {
  const tokens = tokenize('SELECT -1, +2.5, .5, 1e-3 FROM T')
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'number').map((token) => token.value),
    ['-1', '+2.5', '.5', '1e-3'],
  )
})
