import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('session usage publishes authoritative cumulative totals and finite context', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => ({
    tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, total: 19 },
    cost: 0.25,
    contextUsage: { tokens: 7, contextWindow: 100 }
  })
  const session = new PiAcpSession({ sessionId: 'usage', cwd: '/tmp', proc, conn: asAgentConn(conn) })
  assert.deepEqual(await session.publishUsageAndGet(), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 19,
    cachedReadTokens: 3,
    cachedWriteTokens: 2
  })
  assert.deepEqual(conn.updates[0]?.update, {
    sessionUpdate: 'usage_update',
    used: 7,
    size: 100,
    cost: { amount: 0.25, currency: 'USD' }
  })
})

test('usage notification failure does not reject captured prompt usage', async () => {
  const conn = new FakeAgentSideConnection()
  conn.sessionUpdate = async () => {
    throw new Error('client disconnected')
  }
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => ({
    tokens: { input: 1, output: 2, total: 3 },
    contextUsage: { tokens: 2, contextWindow: 10 }
  })
  const session = new PiAcpSession({ sessionId: 'best-effort', cwd: '/tmp', proc, conn: asAgentConn(conn) })

  assert.equal((await session.publishUsageAndGet())?.totalTokens, 3)
})

test('deferred usage rechecks staleness inside the session update chain', async () => {
  const conn = new FakeAgentSideConnection()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const deliver = conn.sessionUpdate.bind(conn)
  let deliveries = 0
  conn.sessionUpdate = async message => {
    deliveries += 1
    if (deliveries === 1) await gate
    await deliver(message)
  }
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => ({
    tokens: { input: 1, output: 2, total: 3 },
    contextUsage: { tokens: 2, contextWindow: 10 }
  })
  const session = new PiAcpSession({ sessionId: 'stale', cwd: '/tmp', proc, conn: asAgentConn(conn) })
  const ahead = session.sendSessionUpdate({
    sessionId: 'stale',
    update: { sessionUpdate: 'session_info_update', title: 'ahead' }
  } as any)
  await new Promise(resolve => setTimeout(resolve, 0))

  let stale = false
  const usage = session.publishUsageAndGet({ isStale: () => stale })
  stale = true
  release()
  await ahead
  assert.equal((await usage)?.totalTokens, 3)
  assert.equal(
    conn.updates.some(update => update.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('post-compaction null context is omitted while cumulative usage remains', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => ({
    tokens: { input: 1, output: 2, total: 3 },
    contextUsage: { tokens: null, contextWindow: 100 }
  })
  const session = new PiAcpSession({ sessionId: 'compacted', cwd: '/tmp', proc, conn: asAgentConn(conn) })
  assert.equal((await session.publishUsageAndGet())?.totalTokens, 3)
  assert.equal(conn.updates.length, 0)
})
