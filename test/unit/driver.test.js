import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/config.js'
import { ConnectionManager } from '../../src/driver.js'

test('attachConfig forwards authentication, encryption, role and credentials', async () => {
  const config = loadConfig({
    connections: {
      prod: {
        host: 'db.internal',
        database: '/data/app.fdb',
        accessMode: 'admin',
        charset: 'GBK',
        authPlugin: 'Srp',
        wireCrypt: true,
        userRef: 'firebird/user',
        passwordRef: 'firebird/password',
        role: 'APP_ROLE',
      },
    },
  })
  const audit = { addSecret() {}, redact: (value) => value }
  const credentials = {
    async resolve(name) {
      return { value: name === 'firebird/user' ? 'APP_USER' : 'app-secret' }
    },
  }
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  const manager = new ConnectionManager({ config, credentials, audit, log })
  const connection = config.connections.prod
  const state = manager.states.get('prod')

  const attached = await manager.attachConfig(connection, state, 'APP_ROLE')

  assert.deepEqual(attached, {
    host: 'db.internal',
    port: 3050,
    database: '/data/app.fdb',
    charset: 'GBK',
    authPlugin: 'Srp',
    wireCrypt: true,
    user: 'APP_USER',
    password: 'app-secret',
    role: 'APP_ROLE',
  })
})
