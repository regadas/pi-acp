import { withSmokeAgent, newSmokeSession, smokePrompt } from './smoke-client.mjs'

await withSmokeAgent(
  async client => {
    const { sessionId } = await newSmokeSession(client)
    await smokePrompt(client, sessionId, '/name pi-acp-smoke')
    client.notify('session/cancel', { sessionId })
  },
  {
    // Placeholders only enumerate models; the built-in prompt never calls a provider.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'pi-acp-smoke-no-call',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'pi-acp-smoke-no-call'
    }
  }
)
console.log('ACP smoke passed: initialize/new/builtin prompt/idle cancel/shutdown')
