import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'

test('getAuthMethods: advertises the terminal method only with the standard auth.terminal capability', () => {
  assert.deepEqual(getAuthMethods({ supportsTerminalAuth: false, supportsTerminalAuthMeta: false }), [])
  // Zed's meta flag alone must not resurrect a method the standard capability
  // did not negotiate.
  assert.deepEqual(getAuthMethods({ supportsTerminalAuth: false, supportsTerminalAuthMeta: true }), [])

  const methods = getAuthMethods({ supportsTerminalAuth: true, supportsTerminalAuthMeta: false })
  assert.equal(methods.length, 1)
  const m: any = methods[0]
  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.equal(m.type, 'terminal')
  assert.deepEqual(m.args, ['--terminal-login'])
  assert.ok(!m._meta || !m._meta['terminal-auth'])
})

test('getAuthMethods: includes Zed terminal-auth metadata only when its meta flag is negotiated', () => {
  const methods = getAuthMethods({ supportsTerminalAuth: true, supportsTerminalAuthMeta: true })
  assert.equal(methods.length, 1)
  const m: any = methods[0]

  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.ok(m._meta)
  assert.ok(m._meta['terminal-auth'])
  assert.ok(typeof m._meta['terminal-auth'].command === 'string')
  assert.deepEqual(m._meta['terminal-auth'].args, ['--terminal-login'])
  assert.equal(m._meta['terminal-auth'].label, 'Launch pi')
})

test('getAuthMethods: defaults to no methods without explicit capabilities (no module-global state)', () => {
  assert.deepEqual(getAuthMethods(), [])
  assert.deepEqual(getAuthMethods({}), [])
})
