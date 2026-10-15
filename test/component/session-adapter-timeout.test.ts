import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcRequestTimeoutError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const makeSessionParams = (conn: FakeAgentSideConnection, proc: FakePiRpcProcess) => ({
  cwd: process.cwd(),
  mcpServers: [],
  conn: asAgentConn(conn),
  proc: proc as any,
  fileCommands: []
})

test('PiAcpAgent: an adapter command timeout evicts the quarantined session', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  // /compact times out: the RPC layer quarantines the channel and rejects.
  ;(proc as any).compact = async () => {
    throw new PiRpcRequestTimeoutError('compact', 10)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-compact-timeout'
  const session = manager.getOrCreate(sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: []
  })

  await assert.rejects(
    () => agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/compact' }] } as any),
    (e: unknown) => e instanceof PiRpcRequestTimeoutError
  )

  assert.equal(session.isUnavailable(), true, 'the session is marked unavailable')
  assert.ok(proc.disposeCount >= 1, 'the quarantined process was disposed')
  assert.equal(manager.maybeGet(sessionId), undefined, 'the dead session was evicted for a fresh restore')
})

test('PiAcpAgent: a delivered timeout never disposes a replacement session', async () => {
  const conn = new FakeAgentSideConnection()
  const oldProc = new FakePiRpcProcess()

  // /compact times out; the command's final client-update flush is held so the
  // world can move on underneath it, exactly like a slow ACP client drain.
  let gateNextFlush = false
  let releaseFlush!: () => void
  const flushGate = new Promise<void>(resolve => (releaseFlush = resolve))
  let flushGated!: () => void
  const flushGatedSignal = new Promise<void>(resolve => (flushGated = resolve))
  ;(oldProc as any).compact = async () => {
    gateNextFlush = true
    throw new PiRpcRequestTimeoutError('compact', 10)
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  const manager = (agent as any).sessions as SessionManager
  const sessionId = 's-compact-timeout'
  const oldSession = manager.getOrCreate(sessionId, makeSessionParams(conn, oldProc))
  const originalFlush = (oldSession as any).flushEmits.bind(oldSession)
  ;(oldSession as any).flushEmits = async () => {
    if (gateNextFlush) {
      gateNextFlush = false
      flushGated()
      await flushGate
    }
    return originalFlush()
  }

  const promptPromise = agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/compact' }] } as any)
  await flushGatedSignal

  // While the timed-out command is blocked flushing its updates, the old
  // child exits and a replacement registers under the same session id.
  oldProc.emitTermination()
  const replacementProc = new FakePiRpcProcess()
  const replacement = manager.getOrCreate(sessionId, makeSessionParams(conn, replacementProc))
  assert.notEqual(replacement, oldSession, 'a distinct replacement registered')

  releaseFlush()
  await assert.rejects(
    () => promptPromise,
    (e: unknown) => e instanceof PiRpcRequestTimeoutError
  )

  assert.equal(oldSession.isUnavailable(), true, 'the timed-out original session is disposed')
  assert.equal(
    manager.maybeGet(sessionId),
    replacement,
    'the healthy replacement registered during the flush must survive the delivered timeout'
  )
  assert.equal(replacement.isUnavailable(), false)
  assert.equal(replacementProc.disposeCount, 0, 'no disposal ever touched the replacement process')
})
