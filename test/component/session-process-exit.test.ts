import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcRequestTimeoutError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: child exit after prompt accepted + agent_start fails the turn instead of hanging', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } })
  await tick()

  proc.emitTermination({ code: 1, stderrTail: 'fatal: out of memory' })

  await assert.rejects(p, (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /exited unexpectedly \(code=1/)
    assert.match(String(e?.message), /out of memory/)
    return true
  })

  // Already-enqueued turn updates must have been delivered before rejection.
  const texts = conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text)
  assert.ok(texts.includes('partial '))
})

test('PiAcpSession: child exit settles queued prompts along with the active turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')
  proc.emit({ type: 'agent_start' })
  await tick()
  assert.equal(proc.prompts.length, 1)

  proc.emitTermination({ code: 1 })

  const results = await Promise.allSettled([first, second, third])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal((result as PromiseRejectedResult).reason?.code, -32603)
  }
  assert.equal(proc.prompts.length, 1, 'queued prompts must not be sent to a dead child')
})

test('PiAcpSession: child exit after client cancellation still resolves cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await session.cancel()

  proc.emitTermination({ code: 0, signal: null, stderrTail: 'permission denied: authentication required' })

  assert.equal(await p, 'cancelled')
})

test('PiAcpSession: adapter-requested (expected) termination settles the turn as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await tick()

  proc.emitTermination({ code: 0, expected: true })

  assert.equal(await p, 'cancelled')
})

test('PiAcpSession: duplicate termination deliveries settle the turn exactly once', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await tick()

  proc.emitTermination({ code: 1 })
  proc.emitTermination({ code: 2 })

  await assert.rejects(p, (e: any) => {
    assert.match(String(e?.message), /code=1/)
    return true
  })

  // A late agent_settled from buffered output must not double-settle either.
  proc.emit({ type: 'agent_settled' })
  await tick()
})

test('PiAcpSession: abort failure disposes the child and settles active and queued turns as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abort = async () => {
    proc.abortCount += 1
    throw new PiRpcRequestTimeoutError('abort', 10)
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })

  await session.cancel()

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(await session.prompt('after-dead-channel'), 'cancelled')

  const updatesAfterSettlement = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(conn.updates.length, updatesAfterSettlement, 'disposed session must ignore late pi output')
})

test('PiAcpSession: prompt timeout rejects, disposes, and suppresses late events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message, attachments = []) => {
    proc.prompts.push({ message, attachments })
    throw new PiRpcRequestTimeoutError('prompt', 10)
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')

  await assert.rejects(first, (error: any) => {
    assert.equal(error?.code, -32603)
    assert.match(String(error?.message), /prompt timed out/)
    return true
  })
  await assert.rejects(second, (error: any) => {
    assert.equal(error?.code, -32603)
    return true
  })
  assert.equal(proc.disposeCount, 1)

  const updatesAfterSettlement = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(conn.updates.length, updatesAfterSettlement)
})

test('PiAcpSession: shutdown still settles when abort rejects (e.g. abort timeout)', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abort = async () => {
    proc.abortCount += 1
    throw new Error('pi abort timed out after 10000ms')
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  await tick()

  const shutdown = session.shutdown()
  proc.emit({ type: 'agent_settled' })

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  await shutdown
  assert.equal(proc.abortCount, 1)
})

for (const history of ['none', 'idle-cancel', 'active-cancel', 'intervening-success']) {
  test(`PiAcpSession: fresh parked and queued work rejects death after ${history}`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)
    if (history === 'idle-cancel') await session.cancel()
    if (history === 'active-cancel' || history === 'intervening-success') {
      const old = session.prompt('old')
      proc.emit({ type: 'agent_start' })
      await session.cancel()
      proc.emit({ type: 'agent_settled' })
      assert.equal(await old, 'cancelled')
      assert.equal(proc.disposed, false)
    }
    if (history === 'intervening-success') {
      proc.state = { isStreaming: false }
      assert.equal(await session.prompt('success'), 'end_turn')
    }
    proc.emit({ type: 'agent_start' })
    let ran = false
    const parked = session.runCommand(async () => {
      ran = true
      return 'unexpected'
    })
    const queuedCommand = session.runCommand(async () => {
      ran = true
      return 'unexpected'
    })
    const queuedPrompt = session.prompt('queued')
    const resultsPromise = Promise.allSettled([parked, queuedCommand, queuedPrompt])
    await tick()
    assert.equal(ran, false)
    proc.emitTermination({ code: 7, stderrTail: 'fatal audit crash' })
    for (const result of await resultsPromise) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.equal(result.reason.code, -32603)
        assert.match(result.reason.message, /code=7.*fatal audit crash/s)
      }
    }
    assert.equal(ran, false)
    session.dispose()
  })
}

test('PiAcpSession: current command cancellation still dominates a subsequent unexpected exit', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const command = session.runCommand(async () => {
    await gate
    return 'late'
  })
  await tick()
  await session.cancel()
  proc.emitTermination({ code: 7 })
  release()
  assert.equal(await command, null)
  session.dispose()
})
