import test from 'node:test'
import assert from 'node:assert/strict'
import type { PromptRequest, PromptResponse } from '@agentclientprotocol/sdk'
import { PiAcpAgent, runPromptWithCancellation } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const promptParams = (sessionId: string): PromptRequest => ({
  sessionId,
  prompt: [{ type: 'text', text: 'hello' }]
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function deferredRestore(agent: PiAcpAgent, conn: FakeAgentSideConnection, proc: FakePiRpcProcess, sessionId: string) {
  const restore = deferred<PiAcpSession>()
  const session = new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  ;((agent as any).restoringSessions as Map<string, Promise<PiAcpSession>>).set(sessionId, restore.promise)
  return { restore, session }
}

test('runPromptWithCancellation: cancellation preserves returned usage and metadata', async () => {
  const response: PromptResponse = {
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    _meta: { captured: true }
  }
  const result = deferred<PromptResponse>()
  const agent = { prompt: () => result.promise, cancel: async () => {} }
  const controller = new AbortController()
  const pending = runPromptWithCancellation(agent, promptParams('s1'), controller.signal)
  controller.abort()
  result.resolve(response)

  assert.deepEqual(await pending, { ...response, stopReason: 'cancelled' })
  assert.equal(response.stopReason, 'end_turn', 'normalization does not mutate the returned response')
})

test('PiAcpAgent.prompt: cancellation preserves returned usage and metadata', async () => {
  const response: PromptResponse = {
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    _meta: { captured: true }
  }
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const started = deferred<void>()
  const result = deferred<PromptResponse>()
  ;(agent as unknown as { runPrompt: () => Promise<PromptResponse> }).runPrompt = () => {
    started.resolve()
    return result.promise
  }
  const controller = new AbortController()
  const pending = agent.prompt(promptParams('s1'), controller.signal)
  await started.promise
  controller.abort()
  result.resolve(response)

  assert.deepEqual(await pending, { ...response, stopReason: 'cancelled' })
  assert.equal(response.stopReason, 'end_turn')
})

test('runPromptWithCancellation: request abort routes into agent.cancel', async () => {
  const cancelled: string[] = []
  let resolvePrompt!: (r: { stopReason: 'cancelled' }) => void

  const agent = {
    prompt: () => new Promise<{ stopReason: 'cancelled' }>(res => (resolvePrompt = res)),
    cancel: async (params: { sessionId: string }) => {
      cancelled.push(params.sessionId)
      resolvePrompt({ stopReason: 'cancelled' })
    }
  }

  const controller = new AbortController()
  const pending = runPromptWithCancellation(agent as unknown as PiAcpAgent, promptParams('s1'), controller.signal)

  controller.abort()

  assert.equal((await pending).stopReason, 'cancelled')
  assert.deepEqual(cancelled, ['s1'])
})

test('runPromptWithCancellation: an already-aborted signal cancels immediately', async () => {
  const cancelled: string[] = []
  let resolvePrompt!: (r: { stopReason: 'cancelled' }) => void

  const agent = {
    prompt: () => new Promise<{ stopReason: 'cancelled' }>(res => (resolvePrompt = res)),
    cancel: async (params: { sessionId: string }) => {
      cancelled.push(params.sessionId)
      resolvePrompt({ stopReason: 'cancelled' })
    }
  }

  const controller = new AbortController()
  controller.abort()

  const res = await runPromptWithCancellation(agent as unknown as PiAcpAgent, promptParams('s1'), controller.signal)

  assert.equal(res.stopReason, 'cancelled')
  assert.deepEqual(cancelled, ['s1'])
})

test('runPromptWithCancellation: request abort remains sticky across deferred restore', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const { restore, session } = deferredRestore(agent, conn, proc, 's-restore-request')
  const controller = new AbortController()

  const pending = runPromptWithCancellation(agent, promptParams('s-restore-request'), controller.signal)
  controller.abort()
  restore.resolve(session)

  assert.deepEqual(await pending, { stopReason: 'cancelled' })
  assert.equal(proc.prompts.length, 0, 'cancelled startup never sent work to pi')
})

test('PiAcpAgent: session/cancel remains sticky across deferred restore', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const { restore, session } = deferredRestore(agent, conn, proc, 's-restore-session')

  const pending = agent.prompt(promptParams('s-restore-session'))
  await agent.cancel({ sessionId: 's-restore-session' })
  restore.resolve(session)

  assert.deepEqual(await pending, { stopReason: 'cancelled' })
  assert.equal(proc.prompts.length, 0, 'cancelled startup never sent work to pi')
})

test('runPromptWithCancellation: abort after settlement does not cancel later turns', async () => {
  let cancelCount = 0

  const agent = {
    prompt: async () => ({ stopReason: 'end_turn' as const }),
    cancel: async () => {
      cancelCount += 1
    }
  }

  const controller = new AbortController()
  const res = await runPromptWithCancellation(agent as unknown as PiAcpAgent, promptParams('s1'), controller.signal)
  assert.equal(res.stopReason, 'end_turn')

  // The listener is removed once the prompt settles; a teardown-time abort of
  // the same signal must not cancel anything.
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(cancelCount, 0)
})

test('PiAcpAgent: abort failure evicts the unavailable session after cancelling its prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abort = async () => {
    proc.abortCount += 1
    throw new Error('abort timed out')
  }
  const session = new PiAcpSession({
    sessionId: 's-unhealthy',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const evicted: Array<{ id: string; session: PiAcpSession }> = []
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === session.sessionId ? session : undefined),
    evictIfCurrent: (id: string, expected: PiAcpSession) => {
      evicted.push({ id, session: expected })
      return true
    }
  }

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await agent.cancel({ sessionId: session.sessionId })

  assert.equal(await pending, 'cancelled')
  assert.deepEqual(evicted, [{ id: session.sessionId, session }])
  assert.equal(proc.disposeCount, 1)
})

test('PiAcpAgent: stale cancel completion does not evict a replacement session', async () => {
  const conn = new FakeAgentSideConnection()
  const firstProc = new FakePiRpcProcess()
  const secondProc = new FakePiRpcProcess()
  const abortStarted = deferred<void>()
  const releaseAbort = deferred<void>()
  firstProc.abort = async () => {
    firstProc.abortCount += 1
    abortStarted.resolve()
    await releaseAbort.promise
    throw new Error('abort timed out')
  }

  const first = new PiAcpSession({
    sessionId: 's-race',
    cwd: process.cwd(),
    mcpServers: [],
    proc: firstProc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const replacement = new PiAcpSession({
    sessionId: first.sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: secondProc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const manager = new SessionManager()
  ;(manager as any).sessions.set(first.sessionId, first)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = manager

  const pending = first.prompt('work')
  firstProc.emit({ type: 'agent_start' })
  const cancellation = agent.cancel({ sessionId: first.sessionId })
  await abortStarted.promise
  ;(manager as any).sessions.set(first.sessionId, replacement)
  releaseAbort.resolve()
  await cancellation
  assert.equal(await pending, 'cancelled')

  assert.equal(manager.maybeGet(first.sessionId), replacement)
  assert.equal(secondProc.disposeCount, 0)
  assert.equal(firstProc.disposeCount, 1)
  manager.close(first.sessionId)
})

test('runPromptWithCancellation: generic cancellation settles the session prompt as cancelled after final updates', async () => {
  const conn = new FakeAgentSideConnection()
  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      return {
        tokens: { input: 10, output: 5, total: 15 },
        contextUsage: { tokens: 7, contextWindow: 100 }
      }
    }
  })
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === 's1' ? session : undefined),
    get: () => session
  }

  const controller = new AbortController()
  const pending = runPromptWithCancellation(agent, promptParams('s1'), controller.signal)

  // Wait until the pi prompt is in flight, then stream an update.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 1)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial output' } })

  const queued = runPromptWithCancellation(agent, promptParams('s1'), new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 1)

  let updatesAtResolve = -1
  const tracked = pending.then(res => {
    updatesAtResolve = conn.updates.length
    return res
  })

  // Generic $/cancel_request → request signal abort → session cancellation.
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.abortCount, 1)

  // pi settles the aborted run; the ACP prompt must resolve cancelled with
  // all streamed updates delivered beforehand.
  proc.emit({ type: 'agent_settled' })

  const res = await tracked
  assert.equal(res.stopReason, 'cancelled')
  assert.deepEqual(res.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedReadTokens: undefined,
    cachedWriteTokens: undefined
  })
  const queuedResponse = await queued
  assert.equal(queuedResponse.stopReason, 'cancelled')
  assert.equal(queuedResponse.usage, undefined, 'never-run queue entries do not inherit active cumulative usage')
  assert.equal(statsCalls, 1)
  assert.equal(proc.prompts.length, 1)

  const delivered = conn.updates.map(u => u.update)
  const deltaIndex = delivered.findIndex(
    u => u.sessionUpdate === 'agent_message_chunk' && (u as any).content?.text === 'partial output'
  )
  assert.ok(deltaIndex >= 0, 'streamed update was delivered')
  assert.ok(updatesAtResolve > deltaIndex, 'updates flushed before the prompt response settled')
  const usageIndex = delivered.findIndex(u => u.sessionUpdate === 'usage_update')
  assert.ok(usageIndex > deltaIndex && usageIndex < updatesAtResolve, 'usage flushes before settlement')
})

test('PiAcpAgent.prompt: cancellation before held dispatch never captures unrelated usage', async () => {
  const conn = new FakeAgentSideConnection()
  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      return { tokens: { input: 10, output: 5, total: 15 } }
    }
  })
  const session = new PiAcpSession({ sessionId: 'held', cwd: '/tmp', proc: proc as any, conn: asAgentConn(conn) })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  proc.emit({ type: 'agent_start' })
  const pending = agent.prompt(promptParams('held'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 0)
  await session.cancel()
  const response = await pending
  assert.equal(response.stopReason, 'cancelled')
  assert.equal(response.usage, undefined)
  assert.equal(statsCalls, 0)
  assert.equal(proc.abortCount, 0)
  proc.emit({ type: 'agent_settled' })
  assert.equal(proc.prompts.length, 0)
})
