import test from 'node:test'
import assert from 'node:assert/strict'
import { MetadataService } from '../../src/metadata.js'

class FakeManager {
  constructor() {
    this.queries = []
    this.batches = 0
    this.relations = []
    this.procedures = []
    this.triggers = []
    this.generators = []
    this.procedureRows = []
    this.inputCount = 0
    this.grants = []
    this.currentUser = 'ALICE'
    this.role = null
  }

  async query(_connection, sql) {
    this.queries.push(sql)
    if (sql.includes('RDB$RELATIONS')) return { rows: this.relations }
    if (sql.includes('RDB$PROCEDURES')) return { rows: this.procedureRows }
    if (sql.includes('RDB$TRIGGERS')) return { rows: this.triggers }
    if (sql.includes('RDB$GENERATORS')) return { rows: this.generators }
    return { rows: [] }
  }

  async batchQuery(_connection, queries) {
    this.batches += 1
    const results = {}
    for (const query of queries) {
      if (query.key === 'procedures') results.procedures = this.procedureRows
      else if (query.key === 'inputCount') results.inputCount = [{ INPUT_COUNT: this.inputCount }]
      else if (query.key === 'grants') results.grants = this.grants
      else if (query.key === 'context') results.context = [{ CURRENT_USER_NAME: this.currentUser }]
      else results[query.key] = []
    }
    return { results }
  }

  describe() {
    return { activeRole: this.role }
  }
}

function service(manager) {
  return new MetadataService({ manager, log: { warn() {} }, ttlMs: 60_000 })
}

test('listObjects maps catalog rows, filters and caches for the TTL', async () => {
  const manager = new FakeManager()
  manager.relations = [
    { NAME: 'T', OWNER: 'SYSDBA', SYSTEM_FLAG: 0, DESCRIPTION: null },
    { NAME: 'OTHER', OWNER: 'SYSDBA', SYSTEM_FLAG: 0, DESCRIPTION: 'hello' },
    { NAME: 'RDB$X', OWNER: 'SYSDBA', SYSTEM_FLAG: 1, DESCRIPTION: null },
  ]
  const metadata = service(manager)
  const first = await metadata.listObjects('dev', 'table')
  assert.equal(first.count, 3)
  assert.deepEqual(first.objects.map((object) => object.name), ['T', 'OTHER', 'RDB$X'])
  assert.equal(first.objects[1].description, 'hello')

  const filtered = await metadata.listObjects('dev', 'table', { filter: 'oth' })
  assert.deepEqual(filtered.objects.map((object) => object.name), ['OTHER'])
  assert.equal(manager.queries.length, 1)

  await metadata.listObjects('dev', 'table')
  assert.equal(manager.queries.length, 1)
  metadata.invalidate('dev')
  await metadata.listObjects('dev', 'table')
  assert.equal(manager.queries.length, 2)

  metadata.invalidate()
  await metadata.listObjects('dev', 'table')
  assert.equal(manager.queries.length, 3)
})

test('describeObject resolves generators and caches the description', async () => {
  const manager = new FakeManager()
  manager.generators = [{ NAME: 'GEN_APP', GENERATOR_ID: 12, SYSTEM_FLAG: 0 }]
  const metadata = service(manager)
  const description = await metadata.describeObject('dev', 'GEN_APP', 'generator')
  assert.equal(description.type, 'generator')
  assert.equal(description.name, 'GEN_APP')
  assert.equal(description.id, 12)

  const queries = manager.queries.length
  await metadata.describeObject('dev', 'GEN_APP', 'generator')
  assert.equal(manager.queries.length, queries)
})

test('resolveObject distinguishes views, tables and ambiguity', async () => {
  const manager = new FakeManager()
  manager.relations = [
    { NAME: 'V', IS_VIEW: 1, OWNER: 'SYSDBA', SYSTEM_FLAG: 0, DESCRIPTION: null },
    { NAME: 'T', IS_VIEW: 0, OWNER: 'SYSDBA', SYSTEM_FLAG: 0, DESCRIPTION: null },
  ]
  manager.procedureRows = [{ NAME: 'T', OWNER: 'SYSDBA', PROCEDURE_TYPE: 1, VALID_BLR: 1 }]
  const metadata = service(manager)

  const view = await metadata.resolveObject('dev', 'V')
  assert.equal(view.type, 'view')
  await assert.rejects(
    () => metadata.resolveObject('dev', 'V', 'table'),
    (error) => error.code === 'OBJECT_TYPE_MISMATCH',
  )
  await assert.rejects(
    () => metadata.resolveObject('dev', 'T'),
    (error) => error.code === 'OBJECT_AMBIGUOUS',
  )
  await assert.rejects(
    () => metadata.resolveObject('dev', 'MISSING'),
    (error) => error.code === 'OBJECT_NOT_FOUND',
  )
})

test('checkProcedureExecute allows SYSDBA, owner, PUBLIC and the active role', async () => {
  const manager = new FakeManager()
  manager.procedureRows = [{
    NAME: 'P',
    OWNER: 'OWNER',
    PROCEDURE_TYPE: 1,
    VALID_BLR: 0,
  }]
  manager.inputCount = 2
  manager.currentUser = 'ALICE'
  const metadata = service(manager)

  const denied = await metadata.checkProcedureExecute('dev', 'P')
  assert.equal(denied.exists, true)
  assert.equal(denied.allowed, false)
  assert.equal(denied.selectable, true)
  assert.equal(denied.valid, false)
  assert.equal(denied.inputCount, 2)
  assert.match(denied.reason, /no EXECUTE privilege/)

  manager.grants = [{ GRANTEE: 'PUBLIC', PRIVILEGE: 'EXECUTE', GRANT_OPTION: 0 }]
  assert.equal((await metadata.checkProcedureExecute('dev', 'P')).allowed, true)

  manager.grants = [{ GRANTEE: 'APP_ROLE', PRIVILEGE: 'EXECUTE', GRANT_OPTION: 1 }]
  manager.role = 'APP_ROLE'
  assert.equal((await metadata.checkProcedureExecute('dev', 'P')).allowed, true)

  manager.role = null
  manager.currentUser = 'OWNER'
  assert.equal((await metadata.checkProcedureExecute('dev', 'P')).allowed, true)

  manager.currentUser = 'SYSDBA'
  assert.equal((await metadata.checkProcedureExecute('dev', 'P')).allowed, true)

  manager.procedureRows = []
  const missing = await metadata.checkProcedureExecute('dev', 'NOPE')
  assert.equal(missing.exists, false)
  assert.equal(missing.allowed, false)
})
