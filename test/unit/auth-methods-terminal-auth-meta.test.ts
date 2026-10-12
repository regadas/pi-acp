import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID, terminalAuthLaunchSpec } from '../../src/acp/auth.js'

test('getAuthMethods: advertises the terminal method only with the standard auth.terminal capability', () => {
  assert.deepEqual(getAuthMethods({ supportsTerminalAuth: false, supportsTerminalAuthMeta: false }), [])
  // The meta flag alone must not resurrect a method the standard capability
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

test('getAuthMethods: includes terminal-auth metadata only when its meta flag is negotiated', () => {
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

test('terminalAuthLaunchSpec advertises the actual node/bun runtime and entry', () => {
  for (const argv0 of [
    '/usr/local/bin/node',
    'node',
    '/home/u/.bun/bin/bun',
    'bun.exe',
    'node.exe',
    '/usr/bin/nodejs',
    '/usr/bin/node-22',
    'node-22.exe'
  ]) {
    assert.deepEqual(terminalAuthLaunchSpec([argv0, '/opt/pi-acp/dist/index.js']), {
      command: argv0,
      args: ['/opt/pi-acp/dist/index.js', '--terminal-login']
    })
  }
})

test('terminalAuthLaunchSpec falls back to pi-acp for other launch forms', () => {
  // The npm bin shim: argv[1] is the invoked command, not a .js entry.
  assert.deepEqual(terminalAuthLaunchSpec(['/usr/local/bin/pi-acp', '/usr/local/bin/pi-acp']), {
    command: 'pi-acp',
    args: ['--terminal-login']
  })
  // A runtime-like name that is not exactly node/bun, and a non-JS entry.
  assert.deepEqual(terminalAuthLaunchSpec(['/usr/bin/envnode', '/x/index.js']), {
    command: 'pi-acp',
    args: ['--terminal-login']
  })
  // Version-suffix matching stays bounded: non-numeric suffixes do not qualify.
  assert.deepEqual(terminalAuthLaunchSpec(['/opt/tools/node-wrapper', '/x/index.js']), {
    command: 'pi-acp',
    args: ['--terminal-login']
  })
  assert.deepEqual(terminalAuthLaunchSpec(['/usr/bin/node', '/repo/src/index.ts']), {
    command: 'pi-acp',
    args: ['--terminal-login']
  })
})
