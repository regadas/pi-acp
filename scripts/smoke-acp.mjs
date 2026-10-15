import { withSmokeAgent, newSmokeSession, smokePrompt } from './smoke-client.mjs'
import { withIsolation, isolatedEnv, SMOKE_CREDENTIAL_PLACEHOLDER } from './isolated-env.mjs'

await withIsolation('pi-acp-smoke-', async dirs =>
  withSmokeAgent(
    async client => {
      const { sessionId } = await newSmokeSession(client, dirs.workspace)
      await smokePrompt(client, sessionId, '/name pi-acp-smoke')
      client.notify('session/cancel', { sessionId })
    },
    {
      // Placeholders only enumerate models; the built-in prompt never calls a provider.
      env: {
        ...isolatedEnv(process.env, dirs),
        ANTHROPIC_API_KEY: SMOKE_CREDENTIAL_PLACEHOLDER,
        OPENAI_API_KEY: SMOKE_CREDENTIAL_PLACEHOLDER
      }
    }
  )
)
console.log('ACP smoke passed: initialize/new/builtin prompt/idle cancel/shutdown')
