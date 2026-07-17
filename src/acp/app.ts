import { agent as acpAgent, methods, RequestError, type AgentApp } from '@agentclientprotocol/sdk'
import { PiAcpAgent, runPromptWithCancellation } from './agent.js'
import { ClientConnection } from './client.js'

/**
 * Builds the ACP agent app with exactly the methods this adapter implements
 * and advertises (see `PiAcpAgent.initialize`). The `PiAcpAgent` instance is
 * created per connection in `onConnect` because it needs the
 * connection-scoped client peer handle.
 */
export function createPiAcpAgentApp(opts?: { onAgent?: (agent: PiAcpAgent | null) => void }): AgentApp {
  let active: PiAcpAgent | null = null
  // ACP wire state is connection-scoped. `initializing` closes the race where
  // two concurrent initialize requests both observed a false boolean.
  let initializeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized'

  const getAgent = (): PiAcpAgent => {
    if (!active) throw RequestError.internalError({}, 'pi-acp agent is not connected')
    return active
  }

  const getInitializedAgent = (): PiAcpAgent => {
    const agent = getAgent()
    if (initializeState !== 'initialized') {
      throw RequestError.invalidRequest({}, 'Agent is not initialized: call initialize first')
    }
    return agent
  }

  return acpAgent({ name: 'pi-acp' })
    .onConnect(connection => {
      const agent = new PiAcpAgent(new ClientConnection(connection.client))
      active = agent
      initializeState = 'uninitialized'
      opts?.onAgent?.(agent)

      connection.signal.addEventListener(
        'abort',
        () => {
          if (active === agent) {
            active = null
            initializeState = 'uninitialized'
            opts?.onAgent?.(null)
          }
          agent.dispose()
        },
        { once: true }
      )
    })
    .onRequest(methods.agent.initialize, async ctx => {
      if (initializeState !== 'uninitialized') {
        throw RequestError.invalidRequest({}, 'Agent is already initializing or initialized')
      }

      const agent = getAgent()
      initializeState = 'initializing'
      try {
        const response = await agent.initialize(ctx.params)
        if (active !== agent) {
          throw RequestError.requestCancelled({}, 'ACP connection closed during initialize')
        }
        initializeState = 'initialized'
        return response
      } catch (error) {
        // Do not reset state belonging to a newer connection.
        if (active === agent) initializeState = 'uninitialized'
        throw error
      }
    })
    .onRequest(methods.agent.authenticate, ctx => getInitializedAgent().authenticate(ctx.params))
    .onRequest(methods.agent.session.new, ctx => getInitializedAgent().newSession(ctx.params))
    .onRequest(methods.agent.session.load, ctx => getInitializedAgent().loadSession(ctx.params))
    .onRequest(methods.agent.session.list, ctx => getInitializedAgent().listSessions(ctx.params))
    .onRequest(methods.agent.session.resume, ctx => getInitializedAgent().resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, ctx => getInitializedAgent().closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, ctx => getInitializedAgent().deleteSession(ctx.params))
    .onRequest(methods.agent.session.setMode, ctx => getInitializedAgent().setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, ctx => getInitializedAgent().setSessionConfigOption(ctx.params))
    .onRequest(methods.agent.session.prompt, ctx =>
      runPromptWithCancellation(getInitializedAgent(), ctx.params, ctx.signal)
    )
    .onNotification(methods.agent.session.cancel, ctx => getInitializedAgent().cancel(ctx.params))
}
