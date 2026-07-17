import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, RequestError, methods, type ClientConnection } from '@agentclientprotocol/sdk'
import { createPiAcpAgentApp } from '../../src/acp/app.js'
import type { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

let oldAgentDir: string | undefined
let oldAcpDir: string | undefined
let oldEmbedded: string | undefined
let connection: ClientConnection | null = null

beforeEach(() => {
  oldAgentDir = process.env.PI_CODING_AGENT_DIR
  oldAcpDir = process.env.PI_ACP_DIR
  oldEmbedded = process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-wiring-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-wiring-store-'))
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
})

afterEach(() => {
  connection?.close()
  connection = null
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
  else process.env.PI_ACP_DIR = oldAcpDir
  if (oldEmbedded === undefined) delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
  else process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = oldEmbedded
})

function connect(onAgent?: (agent: PiAcpAgent | null) => void): ClientConnection {
  connection = client({ name: 'pi-acp-tests' }).connect(createPiAcpAgentApp({ onAgent }))
  return connection
}

test('app wiring: initialize advertises exactly the implemented capabilities', async () => {
  const conn = connect()
  const res = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

  assert.equal(res.protocolVersion, 1)
  assert.equal(res.agentInfo?.name, 'pi-acp')
  assert.equal(res.agentCapabilities?.loadSession, true)
  assert.deepEqual(res.agentCapabilities?.mcpCapabilities, { http: false, sse: false })
  assert.deepEqual(res.agentCapabilities?.promptCapabilities, {
    image: true,
    audio: false,
    embeddedContext: false
  })
  assert.deepEqual(res.agentCapabilities?.sessionCapabilities, {
    list: {},
    resume: {},
    close: {},
    delete: {}
  })
})

test('app wiring: unimplemented ACP methods are not registered', async () => {
  const conn = connect()

  for (const method of ['session/fork', 'logout', 'providers/list', 'nes/start']) {
    await assert.rejects(
      () => conn.agent.request(method, { sessionId: 'x', cwd: '/tmp' }),
      (err: unknown) => (err as RequestError).code === -32601,
      `expected method-not-found for ${method}`
    )
  }
})

test('app wiring: connection abort disposes every live session exactly once', async () => {
  let activeAgent: PiAcpAgent | null = null
  const conn = connect(agent => {
    if (agent) activeAgent = agent
  })
  assert.ok(activeAgent)

  const manager = (activeAgent as PiAcpAgent as any).sessions as SessionManager
  const callbackConn = asAgentConn(new FakeAgentSideConnection())
  const procA = new FakePiRpcProcess()
  const procB = new FakePiRpcProcess()

  manager.getOrCreate('session-a', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: callbackConn,
    proc: procA as any,
    fileCommands: []
  })
  manager.getOrCreate('session-b', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: callbackConn,
    proc: procB as any,
    fileCommands: []
  })

  conn.close()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(procA.disposeCount, 1)
  assert.equal(procB.disposeCount, 1)
  assert.equal(manager.maybeGet('session-a'), undefined)
  assert.equal(manager.maybeGet('session-b'), undefined)

  // Repeated close/teardown paths remain idempotent.
  conn.close()
  ;(activeAgent as PiAcpAgent).dispose()
  assert.equal(procA.disposeCount, 1)
  assert.equal(procB.disposeCount, 1)
})

test('app wiring: requests before initialize and duplicate initialize are invalid', async () => {
  const conn = connect()

  // ACP wire state: every non-initialize request is invalid before a
  // successful initialize on this connection.
  await assert.rejects(
    () => conn.agent.request(methods.agent.session.list, {}),
    (err: unknown) => (err as RequestError).code === -32600
  )
  await assert.rejects(
    () => conn.agent.request(methods.agent.authenticate, { methodId: 'pi_terminal_login' }),
    (err: unknown) => (err as RequestError).code === -32600
  )

  const res = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
  assert.equal(res.protocolVersion, 1)

  // Initialization is a one-time state transition per connection.
  await assert.rejects(
    () => conn.agent.request(methods.agent.initialize, { protocolVersion: 1 }),
    (err: unknown) => (err as RequestError).code === -32600
  )

  // After initialize, normal methods route.
  assert.deepEqual((await conn.agent.request(methods.agent.session.list, {})).sessions, [])
})

test('app wiring: concurrent initialize requests admit exactly one transition', async () => {
  let activeAgent: PiAcpAgent | null = null
  const conn = connect(agent => {
    if (agent) activeAgent = agent
  })
  assert.ok(activeAgent)
  const agent = activeAgent as PiAcpAgent

  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const originalInitialize = agent.initialize.bind(agent)
  ;(agent as any).initialize = async (params: any) => {
    calls += 1
    await gate
    return originalInitialize(params)
  }

  const first = conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
  release()

  const results = await Promise.allSettled([first, second])
  assert.equal(calls, 1)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal((rejected.reason as RequestError).code, -32600)
})

test('app wiring: failed initialize resets the connection to uninitialized', async () => {
  let activeAgent: PiAcpAgent | null = null
  const conn = connect(agent => {
    if (agent) activeAgent = agent
  })
  assert.ok(activeAgent)
  const agent = activeAgent as PiAcpAgent
  const originalInitialize = agent.initialize.bind(agent)
  let fail = true
  ;(agent as any).initialize = async (params: any) => {
    if (fail) {
      fail = false
      throw new Error('initialize failed once')
    }
    return originalInitialize(params)
  }

  await assert.rejects(
    () => conn.agent.request(methods.agent.initialize, { protocolVersion: 1 }),
    (error: unknown) => (error as RequestError).code === -32603
  )
  const response = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })
  assert.equal(response.protocolVersion, 1)
})

test('app wiring: advertised session lifecycle methods are registered and routed', async () => {
  const conn = connect()
  await conn.agent.request(methods.agent.initialize, { protocolVersion: 1 })

  // list works against the isolated (empty) session dir.
  const listed = await conn.agent.request(methods.agent.session.list, {})
  assert.deepEqual(listed.sessions, [])

  // close/delete of unknown sessions succeed silently (idempotent).
  assert.deepEqual(await conn.agent.request(methods.agent.session.close, { sessionId: 'unknown' }), {})
  assert.deepEqual(await conn.agent.request(methods.agent.session.delete, { sessionId: 'unknown' }), {})

  // resume of an unknown session fails with resource-not-found, not method-not-found.
  await assert.rejects(
    () => conn.agent.request(methods.agent.session.resume, { sessionId: 'unknown', cwd: '/tmp', mcpServers: [] }),
    (err: unknown) => (err as RequestError).code === -32002
  )

  // The legacy Zed model selector method is gone; model selection goes
  // through the standard session/set_config_option path.
  await assert.rejects(
    () => conn.agent.request('session/set_model', { sessionId: 'unknown', modelId: 'test/alpha' }),
    (err: unknown) => (err as RequestError).code === -32601
  )

  // cancel for an unknown session is a safe no-op notification.
  await conn.agent.notify(methods.agent.session.cancel, { sessionId: 'unknown' })
})
