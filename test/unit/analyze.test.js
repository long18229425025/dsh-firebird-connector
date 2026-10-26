import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeSql,
  findDisallowedObject,
  isObjectAllowed,
} from '../../src/sql/analyze.js'

const refs = (analysis) => analysis.objects.map((object) => (
  `${object.schema ? `${object.schema}.` : ''}${object.name}:${object.context}:${object.write ? 'w' : 'r'}`
))

test('classifies queries and extracts FROM/JOIN references', () => {
  const analysis = analyzeSql('SELECT T.ID FROM APP.T AS T JOIN U ON U.ID = T.ID WHERE T.ID = 1')
  assert.equal(analysis.kind, 'query')
  assert.equal(analysis.isQuery, true)
  assert.equal(analysis.mainVerb, 'SELECT')
  assert.deepEqual(refs(analysis), ['APP.T:from:r', 'U:join:r'])
  assert.equal(analysis.hasWhere, true)
})

test('WITH CTE names are skipped only inside their lexical scope', () => {
  const scoped = analyzeSql('WITH X AS (SELECT * FROM T) SELECT * FROM X JOIN Y ON Y.ID = X.ID')
  assert.deepEqual(refs(scoped), ['T:from:r', 'Y:join:r'])
  assert.equal(scoped.ctes.has('X'), true)

  const bypass = analyzeSql('SELECT * FROM (WITH X AS (SELECT * FROM T) SELECT * FROM X) S, X')
  assert.deepEqual(bypass.objects.map((object) => object.name).sort(), ['T', 'X'])
})

test('classifies DML verbs and write targets', () => {
  const update = analyzeSql('UPDATE T SET X = 1 WHERE ID = 1')
  assert.equal(update.kind, 'dml')
  assert.deepEqual(refs(update), ['T:update:w'])

  const del = analyzeSql('DELETE FROM T')
  assert.deepEqual(refs(del), ['T:delete:w'])
  assert.equal(del.hasWhere, false)

  const merge = analyzeSql('MERGE INTO T USING S ON T.ID = S.ID WHEN MATCHED THEN UPDATE SET T.X = S.X')
  assert.deepEqual(refs(merge), ['T:merge:w', 'S:using:r'])

  const insert = analyzeSql('INSERT INTO T SELECT * FROM S')
  assert.deepEqual(refs(insert), ['T:insert:w', 'S:from:r'])
})

test('detects UPDATE OR INSERT upserts and unrestricted DML', () => {
  const upsert = analyzeSql('UPDATE OR INSERT INTO T (ID) VALUES (1)')
  assert.equal(upsert.isUpsert, true)
  assert.equal(upsert.hasWhere, false)
  assert.deepEqual(refs(upsert), ['T:insert:w'])

  const unrestricted = analyzeSql('UPDATE T SET X = 1')
  assert.equal(unrestricted.hasWhere, false)
  assert.equal(unrestricted.isUpsert, false)
})

test('flags writes to RDB$ system tables', () => {
  assert.equal(analyzeSql('INSERT INTO RDB$X (ID) VALUES (1)').writesSystemTable, true)
  assert.equal(analyzeSql('UPDATE RDB$X SET A = 1 WHERE ID = 1').writesSystemTable, true)
  assert.equal(analyzeSql('DELETE FROM RDB$X WHERE ID = 1').writesSystemTable, true)
  assert.equal(analyzeSql('SELECT * FROM RDB$DATABASE').writesSystemTable, false)
})

test('parses DDL actions and targets', () => {
  const create = analyzeSql('CREATE TABLE T (ID INT)')
  assert.equal(create.kind, 'ddl')
  assert.equal(create.isDdl, true)
  assert.equal(create.ddl.objectType, 'table')
  assert.equal(create.ddl.target.name, 'T')
  assert.deepEqual(refs(create), ['T:ddl-target:w'])

  const orAlter = analyzeSql('CREATE OR ALTER PROCEDURE P AS BEGIN EXIT; END')
  assert.equal(orAlter.ddl.action, 'CREATE')
  assert.equal(orAlter.ddl.orAlter, true)
  assert.equal(orAlter.ddl.objectType, 'procedure')

  const index = analyzeSql('CREATE UNIQUE INDEX IDX ON T (C)')
  assert.equal(index.ddl.objectType, 'index')
  assert.equal(index.ddl.onObject.name, 'T')
  assert.deepEqual(refs(index), ['T:on-object:r'])

  const drop = analyzeSql('DROP DATABASE')
  assert.equal(drop.ddl.objectType, 'database')
  assert.equal(drop.ddl.target, null)
})

test('parses DROP COLUMN with and without the COLUMN keyword', () => {
  assert.equal(analyzeSql('ALTER TABLE T DROP COLUMN C').ddl.dropColumn.name, 'C')
  assert.equal(analyzeSql('ALTER TABLE T DROP C').ddl.dropColumn.name, 'C')
  assert.equal(analyzeSql('ALTER TABLE T DROP CONSTRAINT FK').ddl.dropColumn, undefined)
  assert.equal(analyzeSql('ALTER TABLE T DROP NOT NULL').ddl.dropColumn, undefined)
})

test('classifies EXPLAIN with optional PLAN/ANALYZE/FOR keywords', () => {
  for (const sql of [
    'EXPLAIN SELECT * FROM T',
    'EXPLAIN PLAN SELECT * FROM T',
    'EXPLAIN PLAN FOR SELECT * FROM T',
    'EXPLAIN ANALYZE SELECT * FROM T',
  ]) {
    const analysis = analyzeSql(sql)
    assert.equal(analysis.kind, 'explain', sql)
    assert.equal(analysis.explain, true)
    assert.equal(analysis.mainVerb, 'SELECT')
    assert.deepEqual(refs(analysis), ['T:from:r'])
  }
})

test('rejects multiple statements except inside routine bodies', () => {
  assert.throws(() => analyzeSql('SELECT 1; SELECT 2'), /Multiple SQL statements/)
  assert.throws(() => analyzeSql('UPDATE T SET ID = 1; COMMIT'), /Multiple SQL statements/)
  assert.doesNotThrow(() => analyzeSql('CREATE PROCEDURE P AS BEGIN EXIT; END'))
  assert.doesNotThrow(() => analyzeSql('CREATE TRIGGER TR FOR T BEFORE INSERT AS BEGIN EXIT; END'))
})

test('classifies GRANT/REVOKE as privileges and EXECUTE as a call', () => {
  assert.equal(analyzeSql('GRANT SELECT ON TABLE T TO U').kind, 'privilege')
  assert.equal(analyzeSql('REVOKE SELECT ON TABLE T FROM U').kind, 'privilege')
  assert.equal(analyzeSql('EXECUTE PROCEDURE P(1)').kind, 'call')
  assert.equal(analyzeSql('EXECUTE BLOCK AS BEGIN EXIT; END').kind, 'block')
  assert.equal(analyzeSql('EXECUTE BLOCK AS BEGIN EXIT; END').executesBlock, true)
})

test('whitelist matches bare and schema-qualified names without cross-schema leaks', () => {
  assert.equal(isObjectAllowed({ name: 'T' }, ['T']), true)
  assert.equal(isObjectAllowed({ name: 'T' }, []), true)
  assert.equal(isObjectAllowed({ name: 'T', schema: 'APP' }, ['APP.T']), true)
  assert.equal(isObjectAllowed({ name: 'T', schema: 'APP' }, ['T']), true)
  assert.equal(isObjectAllowed({ name: 'T', schema: undefined }, ['OTHER.T']), true)
  assert.equal(isObjectAllowed({ name: 'T', schema: 'APP' }, ['OTHER.T']), false)

  const analysis = analyzeSql('SELECT * FROM T JOIN S ON T.ID = S.ID')
  assert.equal(findDisallowedObject(analysis, ['T']).name, 'S')
  assert.equal(findDisallowedObject(analysis, ['T', 'S']), undefined)
})
