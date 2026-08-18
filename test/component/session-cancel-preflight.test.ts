import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// pi writes its `prompt` acceptance response only after preflight succeeds, and
// that preflight can run extension input hooks and overflow compaction for
// minutes (PROMPT_TIMEOUT_MS is 10 minutes for exactly that reason). `abort`
// only stops an agent *run*, so a cancellation landing in that window can be
// acknowledged while preflight continues -- and pi then starts the very prompt
// the client cancelled. Cancellation before acceptance must therefore fail
// closed by quarantining the channel.

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeSessions {
  readonly evicted: string[] = []

  constructor(private readonly session: PiAcpSession) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
  evictIfCurrent(sessionId: string, expected: PiAcpSession) {
    if (expected !== this.session) return false
    this.evicted.push(sessionId)
    return true
  }
}

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as never,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

/**
 * A pi whose prompt stays in preflight: the raw prompt is on the wire, but no
 * acceptance response (and therefore no `agent_start`) has arrived yet.
 */
function withDelayedPreflight(proc: FakePiRpcProcess) {
  const written = deferred()
  const preflight = deferred()
  let accept: (() => void) | null = null

  proc.prompt = (message: string, images: unknown[] = [], onAccepted?: () => void) => {
    proc.prompts.push({ message, attachments: images })
    accept = onAccepted ?? null
    written.resolve()
    return proc.pendingRequest(preflight.promise)
  }

  return {
    written: written.promise,
    /** Let pi finish preflight and start the run it was asked for. */
    finishPreflight() {
      accept?.()
      preflight.resolve()
      proc.emit({ type: 'agent_start' })
      proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late output' } })
      proc.emit({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'bash', args: { command: 'ls' } })
      proc.emit({
        type: 'tool_execution_end',
        toolCallId: 'late-tool',
        isError: false,
        result: { content: [{ type: 'text', text: 'late tool output' }] }
      })
      proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop' } })
      proc.emit({ type: 'agent_settled' })
    }
  }
}

/**
 * A pi that queues the prompt as a follow-up behind autonomous work before
 * acknowledging it. The prompt is then *accepted* (`promptAccepted`) but owns no
 * pi run (`piRunOwned` stays false) until its own user message is delivered, so
 * `abort` would stop the foreign run and still leave this message to execute.
 */
function withQueuedFollowUp(proc: FakePiRpcProcess) {
  const written = deferred()
  const accepted = deferred()
  let accept: (() => void) | null = null
  let queuedText = ''

  proc.prompt = (message: string, images: unknown[] = [], onAccepted?: () => void) => {
    proc.prompts.push({ message, attachments: images })
    accept = onAccepted ?? null
    queuedText = message
    // pi was already streaming, so it enqueued us as a follow-up and reports
    // the new queue state before writing its acceptance response.
    proc.emit({ type: 'queue_update', steering: [], followUp: [message] })
    return proc.pendingRequest(accepted.promise)
  }

  return {
    written: written.promise,
    /** Acknowledge the queued prompt without giving it ownership of a run. */
    acknowledge() {
      accept?.()
      accepted.resolve()
    },
    /** pi finally delivers the queued follow-up and runs it. */
    deliverQueuedRun() {
      proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: queuedText }] } })
      proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late output' } })
      proc.emit({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'bash', args: { command: 'ls' } })
      proc.emit({
        type: 'tool_execution_end',
        toolCallId: 'late-tool',
        isError: false,
        result: { content: [{ type: 'text', text: 'late tool output' }] }
      })
      proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop' } })
      proc.emit({ type: 'agent_settled' })
    }
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('PiAcpSession: cancelling a prompt still in pi preflight quarantines instead of trusting abort', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const pi = withDelayedPreflight(proc)

  const prompt = session.prompt('hello')
  await pi.written

  await session.cancel()

  assert.equal(
    proc.abortCount,
    0,
    'abort cannot stop a prompt that has no run yet, so cancellation must not rely on it'
  )
  assert.equal(proc.disposeCount, 1, 'the channel is quarantined so pi cannot start the cancelled prompt')
  assert.equal(await prompt, 'cancelled')
  assert.equal(session.isUnavailable(), true, 'the session must be restored on a fresh subprocess')

  // pi finishes preflight after the cancellation and runs the prompt anyway.
  const updatesAtCancel = conn.updates.length
  pi.finishPreflight()
  await tick()

  assert.equal(conn.updates.length, updatesAtCancel, 'no output from the cancelled prompt may escape')
  assert.equal(proc.prompts.length, 1, 'the cancelled prompt is never re-dispatched')
})

test('PiAcpSession: prompts queued behind a preflight cancellation settle as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const pi = withDelayedPreflight(proc)

  const first = session.prompt('first')
  const second = session.prompt('second')
  await pi.written

  await session.cancel()

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.deepEqual(
    proc.prompts.map(item => item.message),
    ['first'],
    'a queued prompt is never dispatched into the quarantined channel'
  )

  pi.finishPreflight()
  await tick()
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpAgent: a preflight cancellation evicts the session so the next request restores it', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const pi = withDelayedPreflight(proc)

  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new FakeSessions(session)
  ;(agent as any).sessions = sessions

  const prompt = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
  await pi.written

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await prompt).stopReason, 'cancelled')
  assert.deepEqual(sessions.evicted, ['s1'])

  pi.finishPreflight()
  await tick()
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: cancelling an accepted prompt still aborts its run instead of quarantining', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  // The default fake acknowledges the prompt synchronously, so pi owns a run
  // that `abort` can actually stop.
  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_start' })

  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 0, 'an accepted prompt is cancelled by abort, not by killing the subprocess')

  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
  assert.equal(session.isUnavailable(), false, 'the healthy session stays usable')
})

test('PiAcpSession: cancelling an accepted prompt pi queued as a follow-up quarantines instead of aborting', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const pi = withQueuedFollowUp(proc)

  const prompt = session.prompt('hello')
  await tick()

  // Accepted, but queued behind autonomous work: it owns no pi run yet.
  pi.acknowledge()
  await tick()

  await session.cancel()

  assert.equal(
    proc.abortCount,
    0,
    'abort would stop the unrelated autonomous run while leaving our queued message to be delivered'
  )
  assert.equal(proc.disposeCount, 1, 'the channel is quarantined so the queued prompt can never execute')
  assert.equal(await prompt, 'cancelled')
  assert.equal(session.isUnavailable(), true, 'the session must be restored on a fresh subprocess')

  // pi delivers the queued follow-up after the cancellation and runs it.
  const updatesAtCancel = conn.updates.length
  pi.deliverQueuedRun()
  await tick()

  assert.equal(conn.updates.length, updatesAtCancel, 'no output from the cancelled follow-up may escape')
  assert.equal(proc.prompts.length, 1, 'the cancelled prompt is never re-dispatched')
})

test('PiAcpAgent: a cancelled queued follow-up evicts the session so the next request restores it', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const pi = withQueuedFollowUp(proc)

  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new FakeSessions(session)
  ;(agent as any).sessions = sessions

  const prompt = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
  await tick()
  pi.acknowledge()
  await tick()

  await agent.cancel({ sessionId: 's1' } as any)

  assert.equal((await prompt).stopReason, 'cancelled')
  assert.deepEqual(sessions.evicted, ['s1'])

  pi.deliverQueuedRun()
  await tick()
  assert.equal(proc.prompts.length, 1)
})
