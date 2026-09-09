import assert from 'node:assert/strict'
import { withSmokeAgent, newSmokeSession } from './smoke-client.mjs'

// Manual non-provider probe; requires a configured reasoning model and built adapter.
await withSmokeAgent(async client => {
  const { sessionId } = await newSmokeSession(client)
  const result = await client.request('session/set_config_option', {
    sessionId,
    configId: 'thought_level',
    value: 'low'
  })
  assert.ok(result.configOptions.some(option => option.id === 'thought_level' && option.currentValue === 'low'))
})
