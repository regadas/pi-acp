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
 * snapshots instead of a per-prompt stop reason. The session is `running`
 * while any prompt of this connection is in flight (counted, not tracked per
 * request: the first admission emits `running`, the last settlement emits the
 * `idle` snapshot), so pipelined prompts produce no false idle between
 * turns. Each prompt echoes its `user_message` and settles with its own final
 * state, flushed only when the last in-flight prompt settles. close/delete
 * await every prompt's finalization — turn settled and final updates flushed
 * — before acknowledging. The engine serializes the turns themselves; prompt
 * handlers are admitted immediately so a following cancel or close reaches
 * the engine in the same tick.
 */
export function createPiAcpV2AgentApp(opts?: { onAgent?: (agent: PiAcpAgent | null) => void }): v2.AgentApp {
  let active: PiAcpAgent | null = null
  let conn: V2ClientConnection | null = null
  let initializeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized'
  /**
   * Each in-flight prompt's wrapper finalization — its turn settled and its
   * final updates flushed. close/delete await them, so the last idle state
   * precedes the acknowledgement.
   */
  const promptTails = new Map<string, Set<Promise<void>>>()
  /** In-flight prompt count per session; the session is foreground-busy while above zero. */
  const promptCounts = new Map<string, number>()
  /** Final state updates of prompts that settled while others still run; flushed when the count reaches zero. */
  const pendingFinals = new Map<string, v2.SessionUpdate[]>()
  /**
   * In-flight close/delete count per session, mirroring the engine's
   * transient fence: a prompt whose insertion a close/delete would prevent
   * answers with request-cancelled, without an echo. The count reaches zero
   * only when the last close/delete settles, so overlapping close/delete
   * operations never drop the fence early.
   */
  const closingCounts = new Map<string, number>()
  /**
   * Close/delete generation per session, bumped when one starts and never
   * cleared: a prompt validating a stored-but-not-live session snapshots it
   * before its await, so a close completing during that window fails the
   * prompt closed instead of restoring behind the acknowledged close.
   */
  const closeGenerations = new Map<string, number>()

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

  const getConnection = (): V2ClientConnection => {
    if (!conn) throw RequestError.internalError({}, 'pi-acp agent is not connected')
    return conn
  }

  const send = async (sessionId: string, update: v2.SessionUpdate): Promise<void> => {
    try {
      await conn?.send(sessionId, update)
    } catch {
      // The client may have gone away; the engine ignores notification errors too.
    }
  }

  /**
   * Settle one prompt: record its final state and, when it was the last
   * in-flight prompt of the session, flush every pending final state. All
   * flush sends are initiated before any is awaited, so a prompt admitted
   * meanwhile cannot interleave between them on the wire.
   */
  const settlePrompt = async (sessionId: string, final: v2.SessionUpdate): Promise<void> => {
    const finals = pendingFinals.get(sessionId) ?? []
    finals.push(final)
    const count = (promptCounts.get(sessionId) ?? 1) - 1
    if (count > 0) {
      promptCounts.set(sessionId, count)
      pendingFinals.set(sessionId, finals)
      return
    }
    promptCounts.delete(sessionId)
    pendingFinals.delete(sessionId)
    const flushes = finals.map(update => send(sessionId, update))
    await Promise.all(flushes)
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
      promptCounts.clear()
      pendingFinals.clear()
      closingCounts.clear()
      closeGenerations.clear()
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
          : // Replay runs inside a replay window so replayed entries become
            // deterministic message upserts (see V2ClientConnection).
            await getConnection().replaying(ctx.params.sessionId, () => agent.loadSession(restore.request))
      // v2 requires a current-state snapshot after any replay and before the
      // response: a prompt of this connection still running is foreground work.
      const state = (promptCounts.get(ctx.params.sessionId) ?? 0) > 0 ? 'running' : 'idle'
      await send(ctx.params.sessionId, { sessionUpdate: 'state_update', state } as v2.SessionUpdate)
      return toV2ResumeSessionResponse(response)
    })
    .onRequest(v2.methods.agent.session.close, async ctx => {
      const agent = getInitializedAgent()
      const sessionId = ctx.params.sessionId
      closingCounts.set(sessionId, (closingCounts.get(sessionId) ?? 0) + 1)
      closeGenerations.set(sessionId, (closeGenerations.get(sessionId) ?? 0) + 1)
      try {
        await agent.closeSession({ sessionId })
        // Every prompt's wrapper finalization — its turn settled and its final
        // updates flushed — precedes this acknowledgement.
        await Promise.all(promptTails.get(sessionId) ?? [])
      } finally {
        const inFlight = (closingCounts.get(sessionId) ?? 1) - 1
        if (inFlight === 0) closingCounts.delete(sessionId)
        else closingCounts.set(sessionId, inFlight)
      }
      return {}
    })
    .onRequest(v2.methods.agent.session.delete, async ctx => {
      const agent = getInitializedAgent()
      const sessionId = ctx.params.sessionId
      closingCounts.set(sessionId, (closingCounts.get(sessionId) ?? 0) + 1)
      closeGenerations.set(sessionId, (closeGenerations.get(sessionId) ?? 0) + 1)
      try {
        await agent.deleteSession({ sessionId })
        await Promise.all(promptTails.get(sessionId) ?? [])
      } finally {
        const inFlight = (closingCounts.get(sessionId) ?? 1) - 1
        if (inFlight === 0) closingCounts.delete(sessionId)
        else closingCounts.set(sessionId, inFlight)
      }
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
      // Validate before anything is emitted: a message whose insertion a
      // closing/delete in flight would prevent answers request-cancelled, and
      // an unknown session answers resource-not-found, both without an echo.
      // The live check is synchronous so a live session's admission happens in
      // this request's own tick; only unknown-session checks yield first.
      if ((closingCounts.get(sessionId) ?? 0) > 0) {
        throw RequestError.requestCancelled({}, `session closed while prompting: ${sessionId}`)
      }
      if (!agent.hasLiveSession(sessionId)) {
        // Stored-but-not-live: the validation await is a race window, so the
        // close generation is snapshotted before it and re-checked after — a
        // close/delete completing during the window owns the session and this
        // prompt fails closed instead of restoring behind its acknowledgement.
        // (A cancel landing in the same window has no turn to reach yet; that
        // narrow loss is a documented residual.)
        const closeGeneration = closeGenerations.get(sessionId) ?? 0
        if (!(await agent.hasStoredSession(sessionId))) {
          throw RequestError.resourceNotFound(sessionId)
        }
        if ((closeGenerations.get(sessionId) ?? 0) !== closeGeneration) {
          throw RequestError.requestCancelled({}, `session closed while prompting: ${sessionId}`)
        }
      }
      const messageId = randomUUID()
      const wasIdle = (promptCounts.get(sessionId) ?? 0) === 0
      promptCounts.set(sessionId, (promptCounts.get(sessionId) ?? 0) + 1)
      // Start the echo and the running snapshot without awaiting them, then
      // admit the prompt to the engine in the same tick: the SDK's write
      // queue keeps the wire order, and an immediately following cancel or
      // close reaches the engine with the prompt already admitted.
      const echo = send(sessionId, { sessionUpdate: 'user_message', messageId, content: ctx.params.prompt })
      const running = wasIdle
        ? send(sessionId, { sessionUpdate: 'state_update', state: 'running' } as v2.SessionUpdate)
        : null
      const turn = runPromptWithCancellation(agent, v1PromptRequest(ctx.params), ctx.signal)
      // Handle the turn's outcome from this tick on: a turn that settles or
      // fails while the sends above are still queued (client backpressure)
      // must never sit unhandled.
      const final = turn.then(
        response =>
          ({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: response.stopReason
          }) as v2.SessionUpdate,
        error =>
          ({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'error',
            error: jsonRpcError(error)
          }) as v2.SessionUpdate
      )
      const tails = promptTails.get(sessionId) ?? new Set<Promise<void>>()
      promptTails.set(sessionId, tails)
      // The wrapper's full finalization — turn settled and its final updates
      // flushed — is what close/delete await before acknowledging.
      const tail = (async () => {
        await echo
        if (running) await running
        await settlePrompt(sessionId, await final)
      })()
      tails.add(tail)
      try {
        await tail
        // Inserted: the request itself never rejects from here on — the turn's
        // outcome, failure included, is reported only through the idle snapshot.
        return { messageId }
      } finally {
        tails.delete(tail)
        if (tails.size === 0) promptTails.delete(sessionId)
      }
    })
    .onNotification(v2.methods.agent.session.cancel, ctx => getInitializedAgent().cancel(ctx.params))
}

function jsonRpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RequestError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
  }
  return { code: RequestError.internalError().code, message: error instanceof Error ? error.message : String(error) }
}
