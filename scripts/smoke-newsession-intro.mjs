import assert from 'node:assert/strict'
import { withSmokeAgent, newSmokeSession } from './smoke-client.mjs'

// Manual non-provider probe: new-session intro is metadata, not an out-of-turn message.
await withSmokeAgent(async client => {
  const session = await newSmokeSession(client)
  // Current production sessions explicitly report no banner (null).
  const intro = session._meta?.piAcp?.startupInfo
  assert.ok(intro === null || (typeof intro === 'string' && intro.length > 0))
  assert.ok(!client.updates.some(update => update.sessionUpdate === 'agent_message_chunk'))
})
