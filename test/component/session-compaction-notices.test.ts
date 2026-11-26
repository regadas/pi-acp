import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { replaySessionHistory } from '../../src/acp/history-replay.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

let oldAgentDir: string | undefined
let oldAcpDir: string | undefined
let testCwd: string

beforeEach(() => {
  oldAgentDir = process.env.PI_CODING_AGENT_DIR
  oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-1a-agent-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-1a-store-'))
  testCwd = mkdtempSync(join(tmpdir(), 'pi-acp-1a-cwd-'))
})

afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
  else process.env.PI_ACP_DIR = oldAcpDir
})

test('PR 1A: initialize threads compaction and notices capability flags to new and restored sessions', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const sessionFile = join(testCwd, 's-caps.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-caps', cwd: testCwd })}\n`, 'utf8')
  const store = new SessionStore(join(process.env.PI_ACP_DIR!, 'session-map.json'))
  store.upsert({ sessionId: 's-caps', cwd: testCwd, sessionFile })

  const procs: FakePiRpcProcess[] = []
  ;(PiRpcProcess as any).spawn = async () => {
    const proc = new FakePiRpcProcess()
    proc.terminateOnDispose = true
    proc.state = { sessionId: 's-caps', sessionFile, model: { provider: 'test', id: 'm1' }, thinkingLevel: 'off' }
    procs.push(proc)
    return proc
  }

  try {
    // Empty capability objects `{}` enable both.
    const connOn = new FakeAgentSideConnection()
    const agentOn = new PiAcpAgent(asAgentConn(connOn), store)
    await agentOn.initialize({
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {}, notices: {} } }
    })
    await agentOn.newSession({ cwd: testCwd, mcpServers: [] })
    procs[0]!.emit({ type: 'compaction_start', reason: 'threshold' })
    procs[0]!.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000 })
    await tick()
    assert.ok(connOn.updates.some(u => u.update.sessionUpdate === 'compaction_update'))
    assert.ok(connOn.updates.some(u => u.update.sessionUpdate === 'notice'))

    // Restored session also inherits negotiated flags.
    await agentOn.closeSession({ sessionId: 's-caps' })
    connOn.updates.length = 0
    await agentOn.resumeSession({ sessionId: 's-caps', cwd: testCwd, mcpServers: [] })
    procs[1]!.emit({ type: 'compaction_start', reason: 'threshold' })
    procs[1]!.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 500 })
    await tick()
    assert.ok(connOn.updates.some(u => u.update.sessionUpdate === 'compaction_update'))
    assert.ok(connOn.updates.some(u => u.update.sessionUpdate === 'notice'))
    agentOn.dispose()

    // Explicit `null` or omitted flags keep both off (plain fallback).
    const connOff = new FakeAgentSideConnection()
    const agentOff = new PiAcpAgent(asAgentConn(connOff), store)
    await agentOff.initialize({
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: null, notices: null } }
    })
    await agentOff.resumeSession({ sessionId: 's-caps', cwd: testCwd, mcpServers: [] })
    procs[2]!.emit({ type: 'compaction_start', reason: 'threshold' })
    procs[2]!.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 500 })
    await tick()
    assert.equal(
      connOff.updates.some(u => u.update.sessionUpdate === 'compaction_update'),
      false
    )
    assert.equal(
      connOff.updates.some(u => u.update.sessionUpdate === 'notice'),
      false
    )
    assert.ok(connOff.updates.some(u => u.update.sessionUpdate === 'agent_message_chunk'))
    agentOff.dispose()
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PR 1A: negotiated notices emit structured sanitized notices without replying to notify and never replay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's-notices',
    cwd: testCwd,
    proc: proc as any,
    conn: asAgentConn(conn),
    supportsNotices: true
  })

  const first = session.prompt('first')
  proc.emit({ type: 'agent_start' })
  // Queued notice + cancel queue-cleared notice
  const second = session.prompt('second')
  await tick()

  // Retry & summarization notices + notify extension UI (no reply!)
  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: 'Bearer sk-secret-token-12345678 /Users/alice/private/config.json'
  })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
  proc.emit({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 1000 })
  proc.emit({ type: 'summarization_retry_attempt_start' })
  proc.emit({ type: 'summarization_retry_finished' })
  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    notifyType: 'warning',
    message: 'Rate limit approaching\nBearer sk-topsecret123456'
  })
  proc.emit({
    type: 'auto_retry_end',
    success: false,
    attempt: 3,
    finalError: 'Failed with api_key=supersecret at /Users/bob/app/secret.ts'
  })
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  await tick()

  assert.deepEqual(proc.extensionUiResponses, [], 'notify must never send an extension_ui_response')
  const notices = conn.updates
    .map(u => u.update)
    .filter((u): u is Extract<typeof u, { sessionUpdate: 'notice' }> => u.sessionUpdate === 'notice')
  assert.ok(notices.length >= 8)
  for (const notice of notices) {
    assert.ok(notice.title.trim().length > 0, 'notice title must be non-empty plain text')
    const combined = `${notice.title} ${notice.description ?? ''}`
    assert.equal(combined.includes('sk-secret-token'), false, 'secrets must be redacted from notices')
    assert.equal(combined.includes('sk-topsecret'), false, 'secrets must be redacted from notify')
    assert.equal(combined.includes('supersecret'), false, 'api_key values must be redacted')
    assert.equal(combined.includes('/Users/bob/app'), false, 'filesystem paths must be sanitized in error notices')
  }
  const notifyNotice = notices.find(n => n.title === 'Rate limit approaching')
  assert.equal(notifyNotice?.severity, 'warning')
  const failedRetry = notices.find(n => n.title === 'Automatic retry failed')
  assert.equal(failedRetry?.severity, 'error')

  // Notices are never replayed during history replay.
  conn.updates.length = 0
  proc.entrySnapshot = {
    entries: [
      { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'hi' } },
      { type: 'compaction', id: 'e2', parentId: 'e1', summary: 'old summary' }
    ],
    leafId: 'e2'
  }
  await replaySessionHistory({
    session,
    cwd: testCwd,
    supportsTerminalOutputMeta: false,
    assertActive() {},
    sendUpdate: update => session.sendSessionUpdate(update)
  })
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'notice'),
    false
  )
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'compaction_update'),
    false
  )
  session.dispose()
})

test('PR 1A: negotiated compaction emits chunk before terminal update, keeps overflow ID, and terminalizes once on abort/exit', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's-compact',
    cwd: testCwd,
    proc: proc as any,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })

  // Overflow retry retains same compactionId, emits single summary chunk before terminal update (never summary field).
  proc.emit({ type: 'compaction_start', reason: 'overflow' })
  proc.emit({ type: 'compaction_start', reason: 'overflow' })
  proc.emit({
    type: 'compaction_end',
    reason: 'overflow',
    result: { summary: 'Kept essential API decisions.' },
    aborted: false,
    willRetry: true
  })
  await tick()

  const firstSeq = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update' || u.sessionUpdate === 'compaction_summary_chunk')
  const firstId = (firstSeq[0] as any)?.compactionId as string
  assert.match(firstId, /^compaction-[0-9a-f-]{36}$/)
  assert.deepEqual(firstSeq, [
    { sessionUpdate: 'compaction_update', compactionId: firstId, status: 'in_progress' },
    {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: firstId,
      content: { type: 'text', text: 'Kept essential API decisions.' }
    },
    { sessionUpdate: 'compaction_update', compactionId: firstId, status: 'completed' }
  ])
  assert.equal('summary' in (firstSeq[2] as Record<string, unknown>), false, 'never send both summary and chunk')

  // Failure sanitizes error and emits no summary chunk.
  conn.updates.length = 0
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    errorMessage: 'Provider error Bearer sk-leak12345678 in /Users/dev/secret/file.ts',
    aborted: false
  })
  await tick()
  const failSeq = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_update')
  assert.equal(failSeq.length, 2)
  const secondId = (failSeq[0] as any).compactionId as string
  assert.match(secondId, /^compaction-[0-9a-f-]{36}$/)
  assert.notEqual(secondId, firstId)
  assert.equal((failSeq[1] as any).compactionId, secondId)
  assert.equal((failSeq[1] as any).status, 'failed')
  assert.equal((failSeq[1] as any).error.includes('sk-leak'), false)
  assert.equal((failSeq[1] as any).error.includes('/Users/dev'), false)

  // Open compaction terminalizes at most once on process exit, ignoring any late compaction_end.
  conn.updates.length = 0
  const turn = assert.rejects(session.prompt('hi'), /pi process exited unexpectedly/)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emitTermination({ expected: false, code: 1 })
  proc.emit({ type: 'compaction_end', reason: 'threshold', result: { summary: 'late' }, aborted: false })
  await turn
  await tick()

  const exitSeq = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update' || u.sessionUpdate === 'compaction_summary_chunk')
  assert.equal(exitSeq.length, 2)
  assert.equal((exitSeq[0] as any).status, 'in_progress')
  assert.equal((exitSeq[1] as any).status, 'failed')
  session.dispose()
})

for (const mode of ['negotiated', 'fallback'] as const) {
  test(`PR 1A: manual /compact deduplicates event-before-RPC, RPC-before-event, and eventless paths (${mode})`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess() as any
    const session = new PiAcpSession({
      sessionId: 's-manual',
      cwd: testCwd,
      proc,
      conn: asAgentConn(conn),
      supportsCompactionUpdates: mode === 'negotiated'
    })
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

    // 1) Events arrive BEFORE RPC resolves.
    proc.compact = async () => {
      proc.emit({ type: 'compaction_start', reason: 'manual' })
      proc.emit({
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'Summary A', tokensBefore: 100 },
        aborted: false
      })
      return { summary: 'Summary A', tokensBefore: 100 }
    }
    assert.equal(
      (await agent.prompt({ sessionId: 's-manual', prompt: [{ type: 'text', text: '/compact keep A' }] })).stopReason,
      'end_turn'
    )
    await tick()

    if (mode === 'negotiated') {
      const updates = conn.updates
        .map(u => u.update)
        .filter(u => u.sessionUpdate === 'compaction_update' || u.sessionUpdate === 'compaction_summary_chunk')
      assert.equal(updates.filter(u => u.sessionUpdate === 'compaction_summary_chunk').length, 1)
      assert.equal(updates.filter(u => u.sessionUpdate === 'compaction_update' && u.status === 'completed').length, 1)
      assert.equal(
        conn.updates.some(u => u.update.sessionUpdate === 'agent_message_chunk'),
        false
      )
    } else {
      const chunks = conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk')
      assert.equal(chunks.length, 1, 'legacy manual /compact must emit once, never duplicate')
      assert.match((chunks[0]!.update as any).content.text, /Summary A/)
      assert.match((chunks[0]!.update as any).content.text, /Tokens before: 100/)
    }

    // 2) RPC resolves BEFORE trailing compaction_end arrives.
    conn.updates.length = 0
    proc.compact = async () => {
      proc.emit({ type: 'compaction_start', reason: 'manual' })
      return { summary: 'Summary B', tokensBefore: 200 }
    }
    assert.equal(
      (await agent.prompt({ sessionId: 's-manual', prompt: [{ type: 'text', text: '/compact' }] })).stopReason,
      'end_turn'
    )
    proc.emit({
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Summary B', tokensBefore: 200 },
      aborted: false
    })
    await tick()

    if (mode === 'negotiated') {
      assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'compaction_summary_chunk').length, 1)
      assert.equal(
        conn.updates.filter(
          u => u.update.sessionUpdate === 'compaction_update' && (u.update as any).status === 'completed'
        ).length,
        1
      )
    } else {
      assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').length, 1)
    }

    // 3) Eventless RPC response (no compaction_start/compaction_end at all).
    conn.updates.length = 0
    proc.compact = async () => ({ summary: 'Summary C', tokensBefore: 300 })
    assert.equal(
      (await agent.prompt({ sessionId: 's-manual', prompt: [{ type: 'text', text: '/compact' }] })).stopReason,
      'end_turn'
    )
    await tick()

    if (mode === 'negotiated') {
      const seq = conn.updates
        .map(u => u.update)
        .filter(u => u.sessionUpdate === 'compaction_update' || u.sessionUpdate === 'compaction_summary_chunk')
      assert.equal(seq.length, 3)
      assert.equal((seq[0] as any).status, 'in_progress')
      assert.equal((seq[1] as any).content.text, 'Summary C')
      assert.equal((seq[2] as any).status, 'completed')
    } else {
      const chunks = conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk')
      assert.equal(chunks.length, 1)
      assert.match((chunks[0]!.update as any).content.text, /Summary C/)
    }

    session.dispose()
  })
}

test('PR 1A: manual /compact cancelled under backpressure during summary delivery emits a single terminal cancelled update', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseSummary!: () => void
  const summaryGate = new Promise<void>(resolve => {
    releaseSummary = resolve
  })
  const origUpdate = conn.sessionUpdate.bind(conn)
  let summaryBlocked!: () => void
  const onSummaryBlocked = new Promise<void>(resolve => {
    summaryBlocked = resolve
  })
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'compaction_summary_chunk') {
      summaryBlocked()
      await summaryGate
    }
    await origUpdate(notification)
  }

  const proc = new FakePiRpcProcess() as any
  proc.compact = async () => ({ summary: 'Summary under backpressure', tokensBefore: 500 })
  const session = new PiAcpSession({
    sessionId: 's-bp',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  const compactPromise = agent.prompt({ sessionId: 's-bp', prompt: [{ type: 'text', text: '/compact' }] })
  await onSummaryBlocked
  const cancelPromise = session.cancel()
  releaseSummary()
  await cancelPromise
  const res = await compactPromise
  await tick()

  assert.equal(res.stopReason, 'cancelled')
  const compactionUpdates = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update') as Array<{ status: string; compactionId: string }>
  assert.deepEqual(
    compactionUpdates.map(u => u.status),
    ['in_progress', 'cancelled'],
    'cancelled /compact must close with a single cancelled update and never stay in_progress or emit completed'
  )
  session.dispose()
})

test('PR 1A: manual /compact cancelled while completed update is queued behind blocked emit still emits cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseBlocker!: () => void
  const blockerGate = new Promise<void>(resolve => {
    releaseBlocker = resolve
  })
  let blockerHit!: () => void
  const onBlockerHit = new Promise<void>(resolve => {
    blockerHit = resolve
  })
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'compaction_update' && notification.update.status === 'in_progress') {
      blockerHit()
      await blockerGate
    }
    await origUpdate(notification)
  }

  const proc = new FakePiRpcProcess() as any
  // Emit compaction_start (unawaited on lastEmit and blocked by blockerGate) and return immediately
  // so finishManualCompaction genuinely queues `completed` behind the blocked `in_progress`.
  proc.compact = async () => {
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    return { tokensBefore: 100 }
  }
  const session = new PiAcpSession({
    sessionId: 's-bp-completed',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  const compactPromise = agent.prompt({ sessionId: 's-bp-completed', prompt: [{ type: 'text', text: '/compact' }] })
  await onBlockerHit
  // Allow finishManualCompaction to run and queue the terminal `completed` update onto lastEmit.
  await tick()
  const cancelPromise = session.cancel()
  releaseBlocker()
  await cancelPromise
  const res = await compactPromise
  await tick()

  assert.equal(res.stopReason, 'cancelled')
  const compactionUpdates = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update') as Array<{ status: string }>
  assert.deepEqual(
    compactionUpdates.map(u => u.status),
    ['in_progress', 'cancelled'],
    'must emit cancelled (never strand in in_progress or emit completed)'
  )
  session.dispose()
})

test('PR 1A: automatic compaction_end queued behind blocked summary emits cancelled on request-scoped cancel after completionStarted', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseSummary!: () => void
  const summaryGate = new Promise<void>(resolve => {
    releaseSummary = resolve
  })
  let summaryBlocked!: () => void
  const onSummaryBlocked = new Promise<void>(resolve => {
    summaryBlocked = resolve
  })
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'compaction_summary_chunk') {
      summaryBlocked()
      await summaryGate
    }
    await origUpdate(notification)
  }

  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's-auto-req-cancel',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  const controller = new AbortController()
  const promptPromise = agent.prompt(
    { sessionId: 's-auto-req-cancel', prompt: [{ type: 'text', text: 'do work' }] },
    controller.signal
  )
  await tick()

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: { summary: 'Auto compaction summary' },
    aborted: false
  })
  await onSummaryBlocked
  // agent_settled enters completeTurn (completionStarted = true), waiting on flushEmits behind the blocked summary.
  proc.emit({ type: 'agent_settled' })
  await tick()

  // Request-scoped cancel arrives after completionStarted.
  controller.abort()
  releaseSummary()
  const res = await promptPromise
  await tick()

  assert.equal(res.stopReason, 'cancelled')
  const compactionUpdates = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update') as Array<{ status: string }>
  assert.deepEqual(
    compactionUpdates.map(u => u.status),
    ['in_progress', 'cancelled'],
    'request-scoped cancel after completionStarted must transition queued automatic compaction_end to cancelled'
  )
  session.dispose()
})

test('PR 1A: event-before-RPC compaction_end cancelled while summary is blocked emits cancelled, not completed', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseSummary!: () => void
  const summaryGate = new Promise<void>(resolve => {
    releaseSummary = resolve
  })
  let summaryBlocked!: () => void
  const onSummaryBlocked = new Promise<void>(resolve => {
    summaryBlocked = resolve
  })
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'compaction_summary_chunk') {
      summaryBlocked()
      await summaryGate
    }
    await origUpdate(notification)
  }

  const proc = new FakePiRpcProcess() as any
  let resolveCompact!: (value: unknown) => void
  proc.compact = async () => {
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    proc.emit({
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Blocked summary' },
      aborted: false
    })
    return new Promise(resolve => {
      resolveCompact = resolve
    })
  }
  const session = new PiAcpSession({
    sessionId: 's-ev-bp',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  const compactPromise = agent.prompt({ sessionId: 's-ev-bp', prompt: [{ type: 'text', text: '/compact' }] })
  await onSummaryBlocked
  const cancelPromise = session.cancel()
  releaseSummary()
  resolveCompact({ summary: 'Blocked summary' })
  await cancelPromise
  const res = await compactPromise
  await tick()

  assert.equal(res.stopReason, 'cancelled')
  const compactionUpdates = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update') as Array<{ status: string }>
  assert.deepEqual(
    compactionUpdates.map(u => u.status),
    ['in_progress', 'cancelled'],
    'event-before-RPC cancelled mid-summary must emit cancelled, not completed'
  )
  session.dispose()
})

test('PR 1A: trailing manual compaction_end clears suppression so a later standalone manual compaction_end still presents', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.compact = async () => ({ summary: 'Manual summary' })
  const session = new PiAcpSession({
    sessionId: 's-trailing',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  await agent.prompt({ sessionId: 's-trailing', prompt: [{ type: 'text', text: '/compact' }] })
  // Trailing manual compaction_end from the already-presented RPC is deduped and clears suppression.
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Manual summary' }, aborted: false })
  await tick()
  assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'compaction_summary_chunk').length, 1)

  // A later standalone manual compaction_end (without compaction_start) must NOT be swallowed.
  proc.emit({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: 'Second standalone manual' },
    aborted: false
  })
  await tick()
  const chunks = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_summary_chunk') as Array<{
    content: { text: string }
  }>
  assert.deepEqual(
    chunks.map(c => c.content.text),
    ['Manual summary', 'Second standalone manual']
  )
  session.dispose()
})

test('PR 1A: notices and compaction errors redact quoted, escaped, unicode-escaped, suffixed, and multiline credentials', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's-redact',
    cwd: testCwd,
    proc: proc as any,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true,
    supportsNotices: true
  })

  proc.emit({
    type: 'auto_retry_end',
    success: false,
    attempt: 2,
    finalError:
      'Bad auth: api_key="secret123" token=\'abc456\' {"apiKey":"supersecret","access_\\u0074oken":"eyJunicode"} ' +
      '{\\"api_key\\":\\"escapedxyz\\"} api_key=\\"escval99\\" aws_secret_access_key="awssec" private_key=privabc'
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'n-multiline',
    method: 'notify',
    notifyType: 'error',
    message: 'Auth error\napi_key="multiline_secret_1\nmultiline_secret_2"\nafter'
  })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    errorMessage: 'HTTP 401 {"client_secret":"my-secret","password":"pw-value","auth_token_v2":"tokv2"}'
  })
  await tick()

  const notices = conn.updates
    .map(u => u.update)
    .filter((u): u is Extract<typeof u, { sessionUpdate: 'notice' }> => u.sessionUpdate === 'notice')
  const compactFail = conn.updates
    .map(u => u.update)
    .find(u => u.sessionUpdate === 'compaction_update' && (u as any).status === 'failed') as { error?: string }

  const allNoticeText = notices.map(n => `${n.title} ${n.description ?? ''}`).join(' ')
  for (const leaked of [
    'secret123',
    'abc456',
    'supersecret',
    'eyJunicode',
    'escapedxyz',
    'escval99',
    'awssec',
    'privabc',
    'multiline_secret_1',
    'multiline_secret_2'
  ]) {
    assert.equal(allNoticeText.includes(leaked), false, `notice leaked ${leaked}: ${allNoticeText}`)
  }
  for (const leaked of ['my-secret', 'pw-value', 'tokv2']) {
    assert.equal((compactFail.error ?? '').includes(leaked), false, `compaction error leaked ${leaked}`)
  }
  session.dispose()
})

test('PR 1A: compactionIds remain unique across closed and resumed PiAcpSession instances for the same sessionId', async () => {
  const conn = new FakeAgentSideConnection()
  const proc1 = new FakePiRpcProcess()
  const session1 = new PiAcpSession({
    sessionId: 'same-session-id',
    cwd: testCwd,
    proc: proc1 as any,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  proc1.emit({ type: 'compaction_start', reason: 'threshold' })
  proc1.emit({ type: 'compaction_end', reason: 'threshold', result: { summary: 's1' }, aborted: false })
  await tick()
  session1.dispose()

  const proc2 = new FakePiRpcProcess()
  const session2 = new PiAcpSession({
    sessionId: 'same-session-id',
    cwd: testCwd,
    proc: proc2 as any,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  proc2.emit({ type: 'compaction_start', reason: 'threshold' })
  proc2.emit({ type: 'compaction_end', reason: 'threshold', result: { summary: 's2' }, aborted: false })
  await tick()
  session2.dispose()

  const ids = conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<typeof u, { sessionUpdate: 'compaction_update' }> =>
        u.sessionUpdate === 'compaction_update' && u.status === 'in_progress'
    )
    .map(u => u.compactionId)
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1], 'resumed session must never reuse an earlier compactionId')
})

test('PR 1A: /compact after a prior cancelled prompt completes cleanly without inheriting stale cancelRequested', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.compact = async () => ({ summary: 'Clean summary after prior cancel', tokensBefore: 400 })
  const session = new PiAcpSession({
    sessionId: 's-after-cancel',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  // 1) Cancel an ordinary prompt on the healthy session (sets session.cancelRequested = true).
  const firstPrompt = session.prompt('cancel me')
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await firstPrompt, 'cancelled')
  await tick()

  // 2) Run /compact on the same session: must complete with summary, NOT cancelled.
  conn.updates.length = 0
  const compactRes = await agent.prompt({
    sessionId: 's-after-cancel',
    prompt: [{ type: 'text', text: '/compact' }]
  })
  await tick()

  assert.equal(compactRes.stopReason, 'end_turn')
  const seq = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'compaction_update' || u.sessionUpdate === 'compaction_summary_chunk')
  assert.equal(seq.length, 3)
  assert.equal((seq[0] as any).status, 'in_progress')
  assert.equal((seq[1] as any).content.text, 'Clean summary after prior cancel')
  assert.equal((seq[2] as any).status, 'completed')
  session.dispose()
})

test('PR 1A: eventless manual /compact RPC failure emits synthetic in_progress -> failed card with sanitized error', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.compact = async () => {
    throw new Error('Compaction rejected with api_key=supersecret at /Users/dev/project/secret.ts')
  }
  const session = new PiAcpSession({
    sessionId: 's-eventless-fail',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  await assert.rejects(
    () => agent.prompt({ sessionId: 's-eventless-fail', prompt: [{ type: 'text', text: '/compact' }] }),
    /Compaction rejected/
  )
  await tick()

  const updates = conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<typeof u, { sessionUpdate: 'compaction_update' }> => u.sessionUpdate === 'compaction_update'
    )
  assert.deepEqual(
    updates.map(u => u.status),
    ['in_progress', 'failed']
  )
  assert.equal(updates[0]!.compactionId, updates[1]!.compactionId)
  assert.ok(updates[1]!.error)
  assert.equal(updates[1]!.error!.includes('supersecret'), false)
  assert.equal(updates[1]!.error!.includes('/Users/dev'), false)

  // A late trailing compaction_end after an eventless RPC failure must be suppressed (no duplicate failed card).
  proc.emit({ type: 'compaction_end', reason: 'manual', errorMessage: 'late duplicate error', aborted: false })
  await tick()
  const afterLate = conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<typeof u, { sessionUpdate: 'compaction_update' }> => u.sessionUpdate === 'compaction_update'
    )
  assert.equal(afterLate.length, 2, 'late trailing compaction_end after eventless failure must not emit duplicate card')
  session.dispose()
})

test('PR 1A: unexpected Pi crash during /compact after a prior cancelled prompt emits failed, not cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's-crash-after-cancel',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  // 1) Cancel an earlier prompt so session.cancelRequested is stale-true.
  const firstPrompt = session.prompt('cancel first')
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await firstPrompt, 'cancelled')
  await tick()

  // 2) Start /compact, emit compaction_start, then crash Pi unexpectedly.
  conn.updates.length = 0
  proc.compact = async () => {
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    return await new Promise((_resolve, reject) => {
      proc.onTermination(() => reject(new Error('pi process exited unexpectedly (code 1)')))
    })
  }
  const compactPromise = agent.prompt({
    sessionId: 's-crash-after-cancel',
    prompt: [{ type: 'text', text: '/compact' }]
  })
  await tick()
  proc.emitTermination({ expected: false, code: 1 })
  await assert.rejects(() => compactPromise, /pi process exited unexpectedly/)
  await tick()

  const updates = conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<typeof u, { sessionUpdate: 'compaction_update' }> => u.sessionUpdate === 'compaction_update'
    )
  assert.deepEqual(
    updates.map(u => u.status),
    ['in_progress', 'failed'],
    'unexpected crash during /compact must emit failed even after an earlier cancelled prompt'
  )
  assert.ok(updates[1]!.error, 'failed compaction card must include sanitized error text')
  session.dispose()
})

test('PR 1A: queued compaction_end completion under backpressure switches to failed when Pi crashes before drain', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseInProgress!: () => void
  const inProgressGate = new Promise<void>(resolve => {
    releaseInProgress = resolve
  })
  let inProgressHit!: () => void
  const onInProgressHit = new Promise<void>(resolve => {
    inProgressHit = resolve
  })
  const origUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    if (notification.update.sessionUpdate === 'compaction_update' && notification.update.status === 'in_progress') {
      inProgressHit()
      await inProgressGate
    }
    await origUpdate(notification)
  }

  const proc = new FakePiRpcProcess() as any
  proc.compact = async () => {
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Queued summary' } })
    return await new Promise((_resolve, reject) => {
      proc.onTermination(() => reject(new Error('pi process exited unexpectedly (code 1)')))
    })
  }
  const session = new PiAcpSession({
    sessionId: 's-bp-crash',
    cwd: testCwd,
    proc,
    conn: asAgentConn(conn),
    supportsCompactionUpdates: true
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, peek: () => session }

  const compactPromise = agent.prompt({ sessionId: 's-bp-crash', prompt: [{ type: 'text', text: '/compact' }] })
  await onInProgressHit
  proc.emitTermination({ expected: false, code: 1 })
  releaseInProgress()
  await assert.rejects(() => compactPromise, /pi process exited unexpectedly/)
  await tick()

  const summaryChunks = conn.updates.map(u => u.update).filter(u => u.sessionUpdate === 'compaction_summary_chunk')
  assert.equal(summaryChunks.length, 0, 'stale summary chunk must not ship after crash')
  const updates = conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<typeof u, { sessionUpdate: 'compaction_update' }> => u.sessionUpdate === 'compaction_update'
    )
  assert.deepEqual(
    updates.map(u => u.status),
    ['in_progress', 'failed'],
    'queued terminal compaction callback must honor crash failure instead of emitting completed'
  )
  assert.ok(updates[1]!.error, 'failed compaction card must include sanitized crash error')
  session.dispose()
})
