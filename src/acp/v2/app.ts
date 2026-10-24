import { RequestError } from '@agentclientprotocol/sdk/unstable'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { randomUUID } from 'node:crypto'
import { PiAcpAgent, runPromptWithCancellation } from '../agent.js'
import { V2ClientConnection } from './client.js'
import {
  toV2InitializeResponse,
  toV2ListSessionsResponse,
  toV2NewSessionResponse,
  toV2ResumeSessionResponse,
  toV2SetSessionConfigOptionResponse,
  v1InitializeRequest,
  v1NewSessionRequest,
  v1PromptRequest,
  v1RestoreSessionRequest,
  v1SetSessionConfigOptionRequest
} from './translate.js'

/**
 * Builds the experimental ACP v2 agent app: only the methods this adapter can
 * back on pi RPC (see the v2 entry in docs/adapter-reference.md). Requests are
 * translated to the v1 engine (one implementation serves both versions) and
 * engine messages back to the client are translated by
 * {@link V2ClientConnection}.
 *
 * v2 reports a session's foreground state as aggregate `state_update`
 * snapshots instead of a per-prompt stop reason: each prompt handler echoes
 * its `user_message`, reports `running`, and settles with the `idle` stop
 * reason of the engine's turn. Handler emissions are serialized per session,
 * in request order, so each turn's updates stay contiguous.
 */
export function createPiAcpV2AgentApp(opts?: { onAgent?: (agent: PiAcpAgent | null) => void }): v2.AgentApp {
  let active: PiAcpAgent | null = null
  let conn: V2ClientConnection | null = null
  let initializeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized'
  const promptTails = new Map<string, Promise<void>>()
  const promptInFlight = new Set<string>()
  /** Sessions this connection closed; a later prompt of theirs was never inserted, so v2 answers it with request-cancelled. */
  const closingSessions = new Set<string>()

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

  const send = async (sessionId: string, update: v2.SessionUpdate): Promise<void> => {
    try {
      await conn?.send(sessionId, update)
    } catch {
      // The client may have gone away; the engine ignores notification errors too.
    }
  }

  return v2
    .agent({ name: 'pi-acp' })
    .onConnect(connection => {
      const client = new V2ClientConnection(connection.client)
      const agent = new PiAcpAgent(client)
      conn = client
      active = agent
      initializeState = 'uninitialized'
      promptTails.clear()
      promptInFlight.clear()
      closingSessions.clear()
      opts?.onAgent?.(agent)

      connection.signal.addEventListener(
        'abort',
        () => {
          if (active === agent) {
            active = null
            conn = null
            initializeState = 'uninitialized'
            opts?.onAgent?.(null)
          }
          agent.dispose()
        },
        { once: true }
      )
    })
    .onRequest(v2.methods.agent.initialize, async ctx => {
      if (initializeState !== 'uninitialized') {
        throw RequestError.invalidRequest({}, 'Agent is already initializing or initialized')
      }

      const agent = getAgent()
      initializeState = 'initializing'
      try {
        const response = await agent.initialize(v1InitializeRequest(ctx.params))
        if (active !== agent) {
          throw RequestError.requestCancelled({}, 'ACP connection closed during initialize')
        }
        initializeState = 'initialized'
        return toV2InitializeResponse(response)
      } catch (error) {
        // Do not reset state belonging to a newer connection.
        if (active === agent) initializeState = 'uninitialized'
        throw error
      }
    })
    .onRequest(v2.methods.agent.session.new, async ctx =>
      toV2NewSessionResponse(await getInitializedAgent().newSession(v1NewSessionRequest(ctx.params)))
    )
    .onRequest(v2.methods.agent.session.list, async ctx =>
      toV2ListSessionsResponse(await getInitializedAgent().listSessions(ctx.params))
    )
    .onRequest(v2.methods.agent.session.resume, async ctx => {
      const agent = getInitializedAgent()
      const restore = v1RestoreSessionRequest(ctx.params)
      const response =
        restore.method === 'resume'
          ? await agent.resumeSession(restore.request)
          : await agent.loadSession(restore.request)
      // v2 requires a current-state snapshot after any replay and before the
      // response: a prompt of this connection still running is foreground work.
      const state = promptInFlight.has(ctx.params.sessionId) ? 'running' : 'idle'
      await send(ctx.params.sessionId, { sessionUpdate: 'state_update', state } as v2.SessionUpdate)
      return toV2ResumeSessionResponse(response)
    })
    .onRequest(v2.methods.agent.session.close, async ctx => {
      const agent = getInitializedAgent()
      closingSessions.add(ctx.params.sessionId)
      await agent.closeSession({ sessionId: ctx.params.sessionId })
      // Let cancelled prompts emit their final updates and idle state before
      // the close is acknowledged.
      await promptTails.get(ctx.params.sessionId)
      return {}
    })
    .onRequest(v2.methods.agent.session.delete, async ctx => {
      const agent = getInitializedAgent()
      closingSessions.add(ctx.params.sessionId)
      await agent.deleteSession({ sessionId: ctx.params.sessionId })
      await promptTails.get(ctx.params.sessionId)
      return {}
    })
    .onRequest(v2.methods.agent.session.setConfigOption, async ctx =>
      toV2SetSessionConfigOptionResponse(
        await getInitializedAgent().setSessionConfigOption(v1SetSessionConfigOptionRequest(ctx.params))
      )
    )
    .onRequest(v2.methods.agent.session.prompt, async ctx => {
      const agent = getInitializedAgent()
      const sessionId = ctx.params.sessionId
      // The engine turns prompts of a session it closed into cancelled
      // responses; v2 distinguishes them: a message closing prevented from
      // being inserted is answered with request-cancelled, without an echo.
      if (closingSessions.has(sessionId)) {
        throw RequestError.requestCancelled({}, `session closed while prompting: ${sessionId}`)
      }
      const messageId = randomUUID()
      // The engine serializes the turns themselves; the handler starts
      // immediately so its prompt is admitted (and drained by a close) at
      // arrival. The tail only lets close/delete await every pending
      // handler's final idle emission before acknowledging.
      const run = (async (): Promise<v2.PromptResponse> => {
        promptInFlight.add(sessionId)
        try {
          await send(sessionId, { sessionUpdate: 'user_message', messageId, content: ctx.params.prompt })
          await send(sessionId, { sessionUpdate: 'state_update', state: 'running' })
          const response = await runPromptWithCancellation(agent, v1PromptRequest(ctx.params), ctx.signal)
          await send(sessionId, {
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: response.stopReason
          } as v2.SessionUpdate)
          return { messageId }
        } catch (error) {
          await send(sessionId, {
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'error',
            error: jsonRpcError(error)
          } as v2.SessionUpdate)
          throw error
        } finally {
          promptInFlight.delete(sessionId)
        }
      })()
      const previousTail = promptTails.get(sessionId) ?? Promise.resolve()
      const tail = previousTail.then(() =>
        run.then(
          () => undefined,
          () => undefined
        )
      )
      promptTails.set(sessionId, tail)
      void tail.then(() => {
        if (promptTails.get(sessionId) === tail) promptTails.delete(sessionId)
      })
      return run
    })
    .onNotification(v2.methods.agent.session.cancel, ctx => getInitializedAgent().cancel(ctx.params))
}

function jsonRpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RequestError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
  }
  return { code: RequestError.internalError().code, message: error instanceof Error ? error.message : String(error) }
}
