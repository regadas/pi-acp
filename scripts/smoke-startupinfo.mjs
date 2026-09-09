import assert from 'node:assert/strict'
import { withSmokeAgent, newSmokeSession, smokePrompt } from './smoke-client.mjs'

// Manual non-provider probe; optional startup output belongs to the first prompt.
await withSmokeAgent(async client => {
  const session = await newSmokeSession(client)
  const intro = session._meta?.piAcp?.startupInfo
  assert.ok(intro === null || (typeof intro === 'string' && intro.length > 0))
  assert.ok(!client.updates.some(update => update.sessionUpdate === 'agent_message_chunk'))
  await smokePrompt(client, session.sessionId, '/name pi-acp-startup-smoke')
  const chunks = client.updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
  assert.ok(
    chunks.some(update => update.content?.text?.includes('Session name set')),
    'Expected first-prompt output'
  )
  if (intro !== null) assert.equal(chunks[0]?.content?.text, intro)
})
