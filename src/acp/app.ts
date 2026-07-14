import { agent as acpAgent, methods, RequestError, type AgentApp } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { PiAcpAgent, runPromptWithCancellation } from './agent.js'
import { ClientConnection } from './client.js'

// Legacy Zed model selector method that predates stable session config
// options. Registered as a custom method for older clients; new clients use
// `session/set_config_option`.
const LEGACY_SET_SESSION_MODEL_METHOD = 'session/set_model'

const setSessionModelParams = z.object({
  sessionId: z.string(),
  modelId: z.string()
})

/**
 * Builds the ACP agent app with exactly the methods this adapter implements
 * and advertises (see `PiAcpAgent.initialize`). The `PiAcpAgent` instance is
 * created per connection in `onConnect` because it needs the
 * connection-scoped client peer handle.
 */
export function createPiAcpAgentApp(opts?: { onAgent?: (agent: PiAcpAgent | null) => void }): AgentApp {
  let active: PiAcpAgent | null = null

  const getAgent = (): PiAcpAgent => {
    if (!active) throw RequestError.internalError({}, 'pi-acp agent is not connected')
    return active
  }

  return acpAgent({ name: 'pi-acp' })
    .onConnect(connection => {
      const agent = new PiAcpAgent(new ClientConnection(connection.client))
      active = agent
      opts?.onAgent?.(agent)

      connection.signal.addEventListener(
        'abort',
        () => {
          if (active === agent) {
            active = null
            opts?.onAgent?.(null)
          }
          agent.dispose()
        },
        { once: true }
      )
    })
    .onRequest(methods.agent.initialize, ctx => getAgent().initialize(ctx.params))
    .onRequest(methods.agent.authenticate, ctx => getAgent().authenticate(ctx.params))
    .onRequest(methods.agent.session.new, ctx => getAgent().newSession(ctx.params))
    .onRequest(methods.agent.session.load, ctx => getAgent().loadSession(ctx.params))
    .onRequest(methods.agent.session.list, ctx => getAgent().listSessions(ctx.params))
    .onRequest(methods.agent.session.resume, ctx => getAgent().resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, ctx => getAgent().closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, ctx => getAgent().deleteSession(ctx.params))
    .onRequest(methods.agent.session.setMode, ctx => getAgent().setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, ctx => getAgent().setSessionConfigOption(ctx.params))
    .onRequest(methods.agent.session.prompt, ctx => runPromptWithCancellation(getAgent(), ctx.params, ctx.signal))
    .onNotification(methods.agent.session.cancel, ctx => getAgent().cancel(ctx.params))
    .onRequest(LEGACY_SET_SESSION_MODEL_METHOD, setSessionModelParams, async ctx => {
      await getAgent().unstable_setSessionModel(ctx.params)
      return {}
    })
}
