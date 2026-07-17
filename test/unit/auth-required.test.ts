import test from 'node:test'
import assert from 'node:assert/strict'
import { maybeAuthRequiredError } from '../../src/acp/auth-required.js'

const methods = [{ id: 'pi_terminal_login', name: 'Launch pi in the terminal' }] as any

test('maybeAuthRequiredError: explicit credential problems classify as auth-required', () => {
  for (const message of [
    'Authentication required: missing key',
    'No API key configured for provider anthropic',
    'provider not configured',
    'HTTP 401 Unauthorized',
    'Request failed: 401',
    'unauthenticated request',
    'please log in to continue',
    'invalid credentials'
  ]) {
    const error = maybeAuthRequiredError(new Error(message), methods)
    assert.ok(error, `expected auth-required for: ${message}`)
    assert.equal(error!.code, -32000)
    assert.deepEqual((error!.data as any).authMethods, methods)
  }
})

test('maybeAuthRequiredError: generic permission/entitlement failures stay internal', () => {
  for (const message of [
    "EACCES: permission denied, open '/etc/hosts'",
    'permission denied',
    'HTTP 403 Forbidden',
    '403 quota exceeded for this billing period',
    'model overloaded (429), retry later',
    'request used 2401 tokens', // bounded 401 match: digits inside a number never classify
    'file id 84012 not found'
  ]) {
    assert.equal(maybeAuthRequiredError(new Error(message), methods), null, `expected internal for: ${message}`)
  }
})

test('maybeAuthRequiredError: advertises exactly the negotiated auth methods', () => {
  const error = maybeAuthRequiredError(new Error('missing key'), [])
  assert.ok(error)
  assert.deepEqual((error!.data as any).authMethods, [])
})
