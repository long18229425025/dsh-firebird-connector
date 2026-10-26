import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNoParameters, bindParameters } from '../../src/sql/params.js'

test('binds positional parameters without rewriting SQL', () => {
  const sql = 'SELECT * FROM T WHERE ID = ? AND NAME = ?'
  const bound = bindParameters(sql, [7, 'ANN'])
  assert.equal(bound.sql, sql)
  assert.deepEqual(bound.values, [7, 'ANN'])
  assert.equal(bound.mode, 'positional')
  assert.deepEqual(bound.names, ['#1', '#2'])
})

test('rewrites named parameters to positional markers in token order', () => {
  const bound = bindParameters("SELECT :b, 'keep :b', :a FROM T WHERE X = :B", { a: 1, b: 2 })
  assert.equal(bound.sql, "SELECT ?, 'keep :b', ? FROM T WHERE X = ?")
  assert.deepEqual(bound.values, [2, 1, 2])
  assert.deepEqual(bound.names, ['b', 'a', 'B'])
  assert.equal(bound.mode, 'named')
})

test('looks up prefixed and case-insensitive named parameters', () => {
  assert.deepEqual(bindParameters('SELECT :id', { id: 1 }).values, [1])
  assert.deepEqual(bindParameters('SELECT :id', { ':id': 2 }).values, [2])
  assert.deepEqual(bindParameters('SELECT :id', { ID: 3 }).values, [3])
  assert.throws(() => bindParameters('SELECT :ID', { id: 1, Id: 2 }), /ambiguous/)
})

test('rejects mixed styles, wrong counts and mismatched values', () => {
  assert.throws(() => bindParameters('SELECT ?, :id', [1]), (error) => error.code === 'PARAM_MIXED')
  assert.throws(
    () => bindParameters('SELECT ?, ?', [1]),
    (error) => error.code === 'PARAM_COUNT',
  )
  assert.throws(
    () => bindParameters('SELECT ?', [1, 2]),
    (error) => error.code === 'PARAM_COUNT',
  )
  assert.throws(
    () => bindParameters('SELECT ?', {}),
    (error) => error.code === 'PARAM_STYLE',
  )
  assert.throws(
    () => bindParameters('SELECT :id', [1]),
    (error) => error.code === 'PARAM_STYLE',
  )
})

test('rejects missing and unused named parameters', () => {
  assert.throws(
    () => bindParameters('SELECT :id', { other: 1 }),
    (error) => error.code === 'PARAM_MISSING' || error.code === 'PARAM_UNUSED',
  )
  assert.throws(
    () => bindParameters('SELECT :id', { id: 1, extra: 2 }),
    (error) => error.code === 'PARAM_UNUSED',
  )
  assert.throws(
    () => bindParameters('SELECT 1', [1]),
    (error) => error.code === 'PARAM_UNUSED',
  )
  assert.throws(
    () => bindParameters('SELECT 1', { unknown: 1 }),
    (error) => error.code === 'PARAM_UNUSED',
  )
  assert.deepEqual(bindParameters('SELECT 1', []).values, [])
  assert.deepEqual(bindParameters('SELECT 1', {}).values, [])
  assert.equal(bindParameters('SELECT 1').mode, 'none')
})

test('accepts scalar bindable values and rejects the rest', () => {
  const date = new Date('2026-01-02T03:04:05Z')
  const buffer = Buffer.from('abc')
  const bound = bindParameters('SELECT ?, ?, ?, ?, ?, ?, ?, ?', [
    null, 'x', 1.5, 10n, true, date, buffer, -0,
  ])
  assert.equal(bound.values[0], null)
  assert.equal(bound.values[1], 'x')
  assert.equal(bound.values[3], 10n)
  assert.equal(bound.values[5], date)
  assert.equal(bound.values[6], buffer)

  for (const value of [undefined, Number.NaN, Infinity, {}, [], Symbol('x'), () => 1]) {
    assert.throws(() => bindParameters('SELECT ?', [value]), (error) => error.code === 'PARAM_MISSING' || error.code === 'PARAM_INVALID')
  }
  assert.throws(
    () => bindParameters('SELECT ?', [new Date('invalid')]),
    (error) => error.code === 'PARAM_INVALID',
  )
})

test('rejects bind markers in DDL and privilege SQL', () => {
  assert.doesNotThrow(() => assertNoParameters("CREATE TABLE T (ID INT DEFAULT 1)"))
  assert.throws(
    () => assertNoParameters('CREATE TABLE T (ID INT DEFAULT ?)'),
    (error) => error.code === 'PARAM_FORBIDDEN',
  )
  assert.throws(
    () => assertNoParameters("GRANT SELECT ON TABLE T TO :user"),
    (error) => error.code === 'PARAM_FORBIDDEN',
  )
})
