import { withSmokeAgent, newSmokeSession, smokePrompt, requireProviderOptIn } from './smoke-client.mjs'

// Manual provider-generating export probe; a fresh empty session cannot be exported.
requireProviderOptIn()
await withSmokeAgent(
  async client => {
    const { sessionId } = await newSmokeSession(client)
    await smokePrompt(client, sessionId, 'Hello')
    await smokePrompt(client, sessionId, '/export')
    if (!client.updates.some(update => update.content?.type === 'resource_link'))
      throw new Error('Export produced no resource link')
  },
  { timeoutMs: 600_000 }
)
