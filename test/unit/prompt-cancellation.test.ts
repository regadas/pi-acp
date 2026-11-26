import test from 'node:test'
import assert from 'node:assert/strict'
import type { PromptRequest, PromptResponse } from '@agentclientprotocol/sdk/unstable'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { getSessionConfiguration } from '../../src/acp/session-config.js'
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
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  ;((agent as any).restoringSessions as Map<string, Promise<PiAcpSession>>).set(sessionId, restore.promise)
  return { restore, session }
}

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

test('PiAcpAgent.prompt: request abort remains sticky across deferred restore', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const { restore, session } = deferredRestore(agent, conn, proc, 's-restore-request')
  const controller = new AbortController()

  const pending = agent.prompt(promptParams('s-restore-request'), controller.signal)
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

test('PiAcpAgent.prompt: abort after settlement does not cancel later turns', async t => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  const controller = new AbortController()
  const first = agent.prompt(promptParams('s1'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_settled' })
  assert.equal((await first).stopReason, 'end_turn')

  const second = agent.prompt(promptParams('s1'))
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.disposeCount, 0)
  proc.emit({ type: 'agent_settled' })
  assert.equal((await second).stopReason, 'end_turn')
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
    proc: proc as any,
    conn: asAgentConn(conn)
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
    proc: firstProc as any,
    conn: asAgentConn(conn)
  })
  const replacement = new PiAcpSession({
    sessionId: first.sessionId,
    cwd: process.cwd(),
    proc: secondProc as any,
    conn: asAgentConn(conn)
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

test('PiAcpAgent.prompt: generic cancellation settles the session prompt as cancelled after final updates', async () => {
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
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === 's1' ? session : undefined),
    get: () => session
  }

  const controller = new AbortController()
  const pending = agent.prompt(promptParams('s1'), controller.signal)

  // Wait until the pi prompt is in flight, then stream an update with owned usage.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 1)
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial output' }
  })

  const queued = agent.prompt(promptParams('s1'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.prompts.length, 1)

  let updatesAtResolve = -1
  const tracked = pending.then(res => {
    updatesAtResolve = conn.updates.length
    return res
  })

  // Generic $/cancel_request aborts this active owner and clears its queue.
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(proc.abortCount, 1)

  // pi settles the aborted run; the ACP prompt must resolve cancelled with
  // all streamed updates delivered beforehand, using owned-turn usage without
  // issuing a get_session_stats RPC.
  proc.emit({ type: 'agent_settled' })

  const res = await tracked
  assert.equal(res.stopReason, 'cancelled')
  assert.deepEqual(res.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15
  })
  const queuedResponse = await queued
  assert.equal(queuedResponse.stopReason, 'cancelled')
  assert.equal(queuedResponse.usage, undefined, 'never-run queue entries do not inherit active cumulative usage')
  assert.equal(statsCalls, 0, 'cancelled turns must not query get_session_stats')
  assert.equal(proc.prompts.length, 1)

  const delivered = conn.updates.map(u => u.update)
  const deltaIndex = delivered.findIndex(
    u => u.sessionUpdate === 'agent_message_chunk' && (u as any).content?.text === 'partial output'
  )
  assert.ok(deltaIndex >= 0, 'streamed update was delivered')
  assert.ok(updatesAtResolve > deltaIndex, 'updates flushed before the prompt response settled')
})

test('PiAcpAgent.prompt: abort while a completed turn flushes usage preserves the next request', async t => {
  const conn = new FakeAgentSideConnection()
  const usageStarted = deferred<void>()
  const usageResult = deferred<unknown>()
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: () => {
      usageStarted.resolve()
      return usageResult.promise
    }
  })
  const session = new PiAcpSession({
    sessionId: 'completing',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }
  const controller = new AbortController()
  const first = agent.prompt(promptParams('completing'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_settled' })
  await usageStarted.promise
  const second = agent.prompt({ sessionId: 'completing', prompt: [{ type: 'text', text: 'next' }] })
  await new Promise(resolve => setImmediate(resolve))

  controller.abort()
  usageResult.resolve({ tokens: { input: 1, output: 2, total: 3 } })
  const firstRes = await first
  assert.equal(firstRes.stopReason, 'cancelled')
  assert.equal(
    firstRes.usage,
    undefined,
    'aborted turn must not return cumulative getSessionStats totals when no owned usage was emitted'
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['hello', 'next']
  )
  assert.equal(proc.abortCount, 0)
  proc.emit({ type: 'agent_settled' })
  assert.equal((await second).stopReason, 'end_turn')
})

test('PiAcpAgent.prompt: cancellation during flushEmits skips getSessionStats completely and returns owned usage', async t => {
  const conn = new FakeAgentSideConnection()
  const flushBlocked = deferred<void>()
  const releaseFlush = deferred<void>()
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'agent_message_chunk') {
      flushBlocked.resolve()
      await releaseFlush.promise
    }
    await origUpdate(notification)
  }

  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      return { tokens: { input: 999, output: 999, total: 1998 } }
    }
  })
  const session = new PiAcpSession({
    sessionId: 'flush-cancel',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }

  const controller = new AbortController()
  const pending = agent.prompt(promptParams('flush-cancel'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 14, output: 6, totalTokens: 20 } },
    assistantMessageEvent: { type: 'text_delta', delta: 'streaming' }
  })
  proc.emit({ type: 'agent_settled' })
  await flushBlocked.promise

  // Abort arrives while completeTurn is awaiting flushEmits().
  controller.abort()
  releaseFlush.resolve()

  const res = await pending
  assert.equal(res.stopReason, 'cancelled')
  assert.equal(statsCalls, 0, 'cancelling during flushEmits must skip getSessionStats completely')
  assert.deepEqual(res.usage, { inputTokens: 14, outputTokens: 6, totalTokens: 20 })
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

test('PiAcpAgent.prompt: abort between runPrompt returning and prompt settling uses ownedUsage, never cumulative statsUsage', async t => {
  const conn = new FakeAgentSideConnection()
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => ({
      tokens: { input: 500, output: 200, total: 700 },
      contextUsage: { tokens: 100, contextWindow: 1000 }
    })
  })
  const session = new PiAcpSession({
    sessionId: 'late-outer-cancel',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }

  const controller = new AbortController()
  // Fire abort right as runPrompt's finally block detaches its abort listener
  // (the exact boundary between runPrompt resolving and prompt settling).
  const origRemove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    origRemove(...args)
    controller.abort()
  }) as AbortSignal['removeEventListener']

  const pending = agent.prompt(promptParams('late-outer-cancel'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', usage: { input: 12, output: 8, totalTokens: 20 } }
  })
  proc.emit({ type: 'agent_settled' })

  const res = await pending
  assert.equal(res.stopReason, 'cancelled')
  assert.deepEqual(
    res.usage,
    { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    'late cancel at prompt() boundary must return ownedUsage, never cumulative getSessionStats totals'
  )
})

test('PiAcpAgent.prompt: abort while a built-in slash command flushes queued updates settles cancelled with undefined usage and preserves queued prompts', async t => {
  const conn = new FakeAgentSideConnection()
  const flushBlocked = deferred<void>()
  const releaseFlush = deferred<void>()
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text' &&
      notification.update.content.text === 'flush-gate'
    ) {
      flushBlocked.resolve()
      await releaseFlush.promise
    }
    await origUpdate(notification)
  }

  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      // Queue an unawaited emit during the second getSessionStats (publishUsageAndGet)
      // so finishAdapterPromptTurn() blocks in flushEmits() after the command body finishes.
      if (statsCalls === 2) {
        proc.emit({ type: 'extension_ui_request', id: 'n-flush', method: 'notify', message: 'flush-gate' })
      }
      return {
        totalMessages: 2,
        tokens: { input: 500, output: 200, total: 700 }
      }
    }
  })
  const session = new PiAcpSession({
    sessionId: 'builtin-flush-cancel',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  session.seedSessionConfiguration(await getSessionConfiguration(proc as unknown as PiAcpSession['proc']))
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }

  const controller = new AbortController()
  const commandPending = agent.prompt(
    { sessionId: 'builtin-flush-cancel', prompt: [{ type: 'text', text: '/session' }] },
    controller.signal
  )
  // Queue a regular prompt behind the built-in command.
  const queuedPending = agent.prompt({
    sessionId: 'builtin-flush-cancel',
    prompt: [{ type: 'text', text: 'after-command' }]
  })

  await flushBlocked.promise
  // Let run(ctx) and syncSessionConfiguration settle so runCommand is parked inside
  // finishAdapterPromptTurn() before aborting.
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  releaseFlush.resolve()

  const commandRes = await commandPending
  assert.equal(commandRes.stopReason, 'cancelled')
  assert.equal(commandRes.usage, undefined, 'cancelled built-in command must never return cumulative statsUsage')

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['after-command'],
    'request-scoped cancel during built-in flush must not clear queued prompts'
  )
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal((await queuedPending).stopReason, 'end_turn')
})

test('PiAcpAgent.prompt: request-scoped abort during failed turn update flush returns ownedUsage without querying getSessionStats', async t => {
  const conn = new FakeAgentSideConnection()
  const flushBlocked = deferred<void>()
  const releaseFlush = deferred<void>()
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'agent_message_chunk') {
      flushBlocked.resolve()
      await releaseFlush.promise
    }
    await origUpdate(notification)
  }

  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      return { tokens: { input: 999, output: 999, total: 1998 } }
    }
  })
  const session = new PiAcpSession({
    sessionId: 'failed-turn-flush-abort',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }

  const controller = new AbortController()
  const pending = agent.prompt(promptParams('failed-turn-flush-abort'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 18, output: 7, totalTokens: 25 } },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial before fail' }
  })
  // Trigger a turn failure (failTurn starts flushing updates behind flushBlocked).
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'upstream 500' })
  proc.emit({ type: 'agent_settled' })
  await flushBlocked.promise

  // Request-scoped abort lands while failTurn is awaiting flushEmits().
  controller.abort()
  releaseFlush.resolve()

  const res = await pending
  assert.equal(res.stopReason, 'cancelled')
  assert.equal(statsCalls, 0, 'failed turn aborted during flush must skip getSessionStats')
  assert.deepEqual(res.usage, { inputTokens: 18, outputTokens: 7, totalTokens: 25 })
})

test('PiAcpAgent.prompt: request-scoped abort during failTurn second flush still returns ownedUsage with zero getSessionStats calls', async t => {
  const conn = new FakeAgentSideConnection()
  const firstFlushBlocked = deferred<void>()
  const releaseFirstFlush = deferred<void>()
  const secondFlushBlocked = deferred<void>()
  const releaseSecondFlush = deferred<void>()
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text' &&
      notification.update.content.text === 'partial before fail'
    ) {
      firstFlushBlocked.resolve()
      await releaseFirstFlush.promise
    }
    if (
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text' &&
      notification.update.content.text.startsWith('Queued message')
    ) {
      secondFlushBlocked.resolve()
      await releaseSecondFlush.promise
    }
    await origUpdate(notification)
  }

  let statsCalls = 0
  const proc = Object.assign(new FakePiRpcProcess(), {
    getSessionStats: async () => {
      statsCalls += 1
      return { tokens: { input: 999, output: 999, total: 1998 } }
    }
  })
  const session = new PiAcpSession({
    sessionId: 'failed-turn-second-flush-abort',
    cwd: process.cwd(),
    proc: proc as unknown as PiAcpSession['proc'],
    conn: asAgentConn(conn)
  })
  t.after(() => session.dispose())
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { restoreSession: () => Promise<PiAcpSession> }).restoreSession = async () => session
  ;(agent as unknown as { sessions: { maybeGet: () => PiAcpSession } }).sessions = { maybeGet: () => session }

  const controller = new AbortController()
  const pending = agent.prompt(promptParams('failed-turn-second-flush-abort'), controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    message: { role: 'assistant', usage: { input: 22, output: 9, totalTokens: 31 } },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial before fail' }
  })
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'upstream 502' })
  proc.emit({ type: 'agent_settled' })
  await firstFlushBlocked.promise

  // Enqueue a second prompt while the first flush is blocked; its queued notice
  // will be drained by failTurn's second flush AFTER pendingTurn is cleared.
  const queued = session.prompt('queued-behind-fail').catch(() => 'rejected')
  releaseFirstFlush.resolve()
  await secondFlushBlocked.promise

  // Abort lands during failTurn's second flush (pendingTurn is already null).
  controller.abort()
  releaseSecondFlush.resolve()

  const res = await pending
  await queued
  assert.equal(res.stopReason, 'cancelled')
  assert.equal(statsCalls, 0, 'abort during failTurn second flush must never query getSessionStats')
  assert.deepEqual(res.usage, { inputTokens: 22, outputTokens: 9, totalTokens: 31 })
})
