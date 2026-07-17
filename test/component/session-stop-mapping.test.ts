import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { SessionManager } from '../../src/acp/session-manager.js'
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

test('PiAcpSession: done reason length maps to max_tokens at agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length', message: {} } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'max_tokens')
})

test('PiAcpSession: only the latest done reason counts (length then stop is end_turn)', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length', message: {} } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop', message: {} } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
})

test("PiAcpSession: a fresh turn does not inherit the previous turn's length stop", async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length', message: {} } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'max_tokens')

  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: assistant error event fails the turn at agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: '429 quota exceeded' } }
  })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(p, (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /429 quota exceeded/)
    return true
  })
})

test('PiAcpSession: aborted error without a client cancellation fails the turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted', error: {} } })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(p, (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /aborted the run unexpectedly/)
    return true
  })
})

test('PiAcpSession: aborted error after a client cancellation resolves cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted', error: {} } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'cancelled')
})

test('PiAcpSession: final retry failure replaces provisional errors and rejects at agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'transient 529' } }
  })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 1 })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'still overloaded' } }
  })
  proc.emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: '529 overloaded_error: Overloaded' })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(p, (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /Automatic retry failed: 529 overloaded_error/)
    assert.doesNotMatch(String(e?.message), /transient 529/)
    return true
  })

  const texts = conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text)
  assert.ok(texts.includes('Automatic retry failed: 529 overloaded_error: Overloaded'))
  assert.ok(!texts.includes('Retry finished, resuming.'), 'a failed retry must not claim it resumed')
})

test('PiAcpSession: recovered retry clears the provisional assistant error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'transient 529' } }
  })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop', message: {} } })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
  const texts = conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text)
  assert.ok(texts.includes('Retry finished, resuming.'))
})

test('PiAcpSession: an unknown future done reason does not erase a provisional failure', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'provider failed' } }
  })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'future_reason', message: {} } })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(p, (error: any) => {
    assert.match(String(error?.message), /provider failed/)
    return true
  })
})

test('PiAcpSession: successful overflow compaction recovery clears the provisional error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'error', reason: 'error', error: { errorMessage: 'context overflow' } }
  })
  proc.emit({ type: 'compaction_start', reason: 'overflow' })
  proc.emit({ type: 'compaction_end', aborted: false, willRetry: true })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'stop', message: {} } })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await p, 'end_turn')
})

test('PiAcpSession: non-auth prompt RPC failure rejects instead of resolving end_turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async () => {
    throw new Error('pi prompt failed: socket hang up')
  }
  const session = makeSession(conn, proc)

  await assert.rejects(session.prompt('hello'), (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /socket hang up/)
    return true
  })
})

test('PiAcpSession: failed acceptance probe quarantines the process and suppresses late output', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => {
    throw new Error('pi get_state timed out after 30000ms')
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('hello')
  const second = session.prompt('queued')
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before failure' } })

  const results = await Promise.allSettled([first, second])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal((result as PromiseRejectedResult).reason?.code, -32603)
    assert.match(String((result as PromiseRejectedResult).reason?.message), /get_state timed out/)
  }
  assert.equal(proc.disposeCount, 1)
  assert.equal(session.isUnavailable(), true)
  assert.ok(
    conn.updates.some(
      update =>
        update.update.sessionUpdate === 'agent_message_chunk' &&
        (update.update as { content?: { text?: string } }).content?.text === 'before failure'
    ),
    'updates queued before the probe failure must flush before rejection'
  )

  const updatesAfterSettlement = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late output' } })
  proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(conn.updates.length, updatesAfterSettlement)

  const manager = new SessionManager()
  ;(manager as any).sessions.set(session.sessionId, session)
  const freshProc = new FakePiRpcProcess()
  const restored = manager.getOrCreate(session.sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    proc: freshProc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  assert.notEqual(restored, session)
  assert.equal(restored.proc, freshProc)
  manager.close(session.sessionId)
})
