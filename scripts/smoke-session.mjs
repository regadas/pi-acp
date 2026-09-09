import { withSmokeAgent, newSmokeSession, smokePrompt } from './smoke-client.mjs'

// Manual probe; run npm run build first.
await withSmokeAgent(async client => {
  const { sessionId } = await newSmokeSession(client)
  await smokePrompt(client, sessionId, '/session')
})
