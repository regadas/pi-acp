import { withSmokeAgent, newSmokeSession, smokePrompt, requireProviderOptIn } from './smoke-client.mjs'

// Manual probe; run npm run build first.
requireProviderOptIn()

await withSmokeAgent(
  async client => {
    const { sessionId } = await newSmokeSession(client)
    await smokePrompt(client, sessionId, '/compact Keep it short')
    if (!client.updates.some(update => update.content?.text?.includes('Compaction completed.')))
      throw new Error('Compaction did not complete')
  },
  { timeoutMs: 600_000 }
)
