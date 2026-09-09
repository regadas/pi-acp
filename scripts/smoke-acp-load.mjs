import assert from 'node:assert/strict'
import { withSmokeAgent, newSmokeSession, smokePrompt, requireProviderOptIn } from './smoke-client.mjs'

// Manual provider-generating persistence/replay probe; run npm run build first.
requireProviderOptIn()
const sessionId = await withSmokeAgent(
  async client => {
    const { sessionId } = await newSmokeSession(client)
    await smokePrompt(client, sessionId, 'Hello')
    return sessionId
  },
  { timeoutMs: 600_000 }
)
await withSmokeAgent(async client => {
  await client.request('initialize', { protocolVersion: 1 })
  const result = await client.request('session/load', {
    sessionId,
    cwd: process.cwd(),
    mcpServers: []
  })
  assert.ok(!('models' in result))
  assert.ok(
    client.updates.some(update => update.sessionUpdate === 'agent_message_chunk'),
    'Expected assistant replay'
  )
})
console.log('OK session/load smoke:', sessionId)
