import test from 'node:test'
import assert from 'node:assert/strict'

test('adapter startup does not synthesize project resource inventory', () => {
  assert.equal(process.env.PI_ACP_STARTUP_RESOURCE_SCAN, undefined)
})
