import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, methods, type Implementation } from '@agentclientprotocol/sdk/unstable'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { WireStream } from '@agentclientprotocol/sdk/experimental/v2'
import { createPiAcpProtocolRouter } from '../../src/acp/app.js'
import { acpStreamPair } from '../helpers/fakes.js'

let oldAgentDir: string | undefined
let oldAcpDir: string | undefined

beforeEach(() => {
  oldAgentDir = process.env.PI_CODING_AGENT_DIR
  oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-v2-negotiation-agent-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-v2-negotiation-store-'))
})

afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
  else process.env.PI_ACP_DIR = oldAcpDir
})

// One wire pair per connection: the client side drives an ACP client app,
// the agent side is routed by the protocol router from the first initialize.
const streamPair = acpStreamPair

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const CLIENT_INFO: Implementation = { name: 'pi-acp-tests', title: 'pi-acp tests', version: '0.0.0' }

test('router: a v2 initialize selects the v2 chain and its method set only', async () => {
  const [agentSide, clientSide] = streamPair()
  createPiAcpProtocolRouter().connect(agentSide as unknown as WireStream)
  const conn = v2
    .client({ name: 'pi-acp-tests' })
    .onNotification(v2.methods.client.session.update, () => {})
    .connect(clientSide as unknown as v2.Stream)

  const response = await withTimeout(
    conn.agent.request(v2.methods.agent.initialize, { protocolVersion: 2, info: CLIENT_INFO }),
    'v2 initialize'
  )
  assert.equal(response.protocolVersion, 2)
  assert.equal(response.info.name, 'pi-acp')
  assert.equal(response.authMethods, undefined)
  assert.deepEqual(response.capabilities, {
    session: {
      prompt: { image: {}, embeddedContext: {} },
      delete: {},
      additionalDirectories: {}
    }
  })

  // The baseline session methods of the advertised surface route.
  assert.deepEqual(
    (await withTimeout(conn.agent.request(v2.methods.agent.session.list, {}), 'v2 session/list')).sessions,
    []
  )

  // v1-only and unadvertised methods are absent from the v2 chain.
  for (const method of ['session/load', 'authenticate', 'auth/login', 'session/fork', 'session/set_mode']) {
    await assert.rejects(
      () => withTimeout(conn.agent.request(method as never, {} as never), method),
      (err: unknown) => (err as { code?: number }).code === -32601,
      `expected method-not-found for ${method} on the v2 chain`
    )
  }

  conn.close()
})

test('router: a client asking for version 1 gets the unchanged v1 chain', async () => {
  const [agentSide, clientSide] = streamPair()
  createPiAcpProtocolRouter().connect(agentSide as unknown as WireStream)
  const conn = client({ name: 'pi-acp-tests' }).connect(clientSide)

  // v1 regression pin: the exact v1 initialize response the v1 chain always gave.
  const response = await withTimeout(
    conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientInfo: CLIENT_INFO }),
    'v1 initialize'
  )
  assert.equal(response.protocolVersion, 1)
  assert.equal(response.agentInfo?.name, 'pi-acp')
  assert.equal(response.agentInfo?.title, 'pi ACP adapter')
  assert.deepEqual(response.authMethods, [])
  assert.deepEqual(response.agentCapabilities, {
    loadSession: true,
    mcpCapabilities: { http: false, sse: false },
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: {
      list: {},
      resume: {},
      close: {},
      delete: {},
      additionalDirectories: {}
    }
  })

  // The v1 chain's registered methods are present and behave as before...
  assert.deepEqual((await withTimeout(conn.agent.request('session/list', {}), 'v1 session/list')).sessions, [])
  // ...including session/load, which v2 folds into session/resume.
  await assert.rejects(
    () =>
      withTimeout(
        conn.agent.request('session/load', { sessionId: 'unknown', cwd: '/tmp', mcpServers: [] }),
        'v1 session/load'
      ),
    (err: unknown) => (err as { code?: number }).code === -32002,
    'v1 session/load is registered (resource-not-found, not method-not-found)'
  )

  // v2-only methods are absent from the v1 chain.
  for (const method of ['auth/login', 'auth/logout', 'providers/list']) {
    await assert.rejects(
      () => withTimeout(conn.agent.request(method as never, {} as never), method),
      (err: unknown) => (err as { code?: number }).code === -32601,
      `expected method-not-found for ${method} on the v1 chain`
    )
  }

  conn.close()
})

test('router: the requested version is honored on the raw wire', async () => {
  // The v2 client app always sends its own protocol version, so unsupported
  // and above-supported versions are probed on the raw wire. Each probe gets
  // its own connection: initialize may be requested once per connection.
  const rawInitialize = async (protocolVersion: number): Promise<unknown> => {
    const [agentSide, clientSide] = streamPair()
    createPiAcpProtocolRouter().connect(agentSide as unknown as WireStream)
    const writer = clientSide.writable.getWriter()
    const reader = clientSide.readable.getReader()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion, info: CLIENT_INFO }
    })
    const response = (await withTimeout(reader.read() as Promise<{ value: unknown }>, `initialize ${protocolVersion}`))
      .value
    void writer.close().catch(() => {})
    return response
  }

  // A version above every supported one negotiates down to v2.
  const down = (await rawInitialize(3)) as {
    result: { protocolVersion: number; capabilities: { session: unknown } }
  }
  assert.equal(down.result.protocolVersion, 2)
  assert.ok(down.result.capabilities.session, 'negotiated down to the v2 chain')

  // A version below every supported one is rejected listing the supported versions.
  const rejected = (await rawInitialize(0)) as {
    error: { code: number; data: { supported: number[] } }
  }
  assert.equal(rejected.error.code, -32022)
  assert.deepEqual(rejected.error.data.supported, [1, 2])
})
