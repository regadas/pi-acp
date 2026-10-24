import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { WireStream } from '@agentclientprotocol/sdk/experimental/v2'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakePiRpcProcess, acpStreamPair } from '../helpers/fakes.js'
import { createPiAcpProtocolRouter } from '../../src/acp/app.js'
import type { PiAcpAgent } from '../../src/acp/agent.js'

type Update = v2.UpdateSessionNotification

let oldAgentDir: string | undefined
let oldAcpDir: string | undefined

beforeEach(() => {
  oldAgentDir = process.env.PI_CODING_AGENT_DIR
  oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-v2-agent-'))
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-v2-store-'))
})

afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
  else process.env.PI_ACP_DIR = oldAcpDir
})

const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-v2-cwd-'))
const SESSION_FILE = join(tmpdir(), 'pi-acp-v2-sess.jsonl')

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

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A deterministic pi stand-in: every spawn returns the same fake process,
 * whose state reports the identity the adapter requires (the seam the v1
 * component tests use).
 */
function patchSpawn(state: Record<string, unknown>): FakePiRpcProcess & { restore(): void } {
  const proc = new FakePiRpcProcess()
  proc.state = state
  const original = PiRpcProcess.spawn
  const restore = () => {
    ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = original
  }
  ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = async () => proc
  return Object.assign(proc, { restore })
}

/**
 * The production path end to end: a v2 client over a real (in-memory) wire,
 * routed by the protocol router into the v2 chain.
 */
function connectV2(onAgent?: (agent: PiAcpAgent | null) => void) {
  const updates: Update[] = []
  const [agentSide, clientSide] = acpStreamPair()
  createPiAcpProtocolRouter({ onAgent }).connect(agentSide as unknown as WireStream)
  const conn = v2
    .client({ name: 'pi-acp-v2-tests' })
    .onNotification(v2.methods.client.session.update, ctx => {
      updates.push(ctx.params)
    })
    .connect(clientSide as unknown as v2.Stream)
  return {
    conn,
    updates,
    received: (sessionUpdate: string) => updates.filter(update => update.update.sessionUpdate === sessionUpdate)
  }
}

const fakeState = (sessionId: string): Record<string, unknown> => ({
  sessionId,
  sessionFile: SESSION_FILE,
  // A streaming run: the turn stays open until agent_settled, so scripted
  // text deltas stream in-turn and are delivered before the prompt settles —
  // the ordering this suite exists to prove. A false isStreaming would make
  // the engine accept-and-complete the turn before any event, the idle path
  // pi takes for prompts handled without an agent run.
  isStreaming: true,
  model: { provider: 'test', id: 'model', reasoning: true },
  thinkingLevel: 'medium'
})

async function initialize(conn: { agent: v2.ClientContext }): Promise<void> {
  await withTimeout(
    conn.agent.request(v2.methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: 'pi-acp-v2-tests', version: '0.0.0' }
    }),
    'initialize'
  )
}

test('v2 session lifecycle: new, prompt with translated updates, close', async () => {
  const proc = patchSpawn(fakeState('v2-sess-1'))
  proc.availableThinkingLevels = ['low', 'medium', 'high']
  const { conn, updates, received } = connectV2()
  try {
    await initialize(conn)

    const created = await withTimeout(
      conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD }),
      'session/new'
    )
    assert.equal(created.sessionId, 'v2-sess-1')
    // v2 names the option id `configId` (v1 calls it `id`).
    const modelOption = created.configOptions?.find(option => option.configId === 'model')
    assert.ok(modelOption, 'model config option advertised with its v2 id field')
    assert.equal(modelOption?.type, 'select')
    assert.ok(
      created.configOptions?.every(option => !('id' in option)),
      'no v1 id field leaks into the v2 response'
    )

    const prompt = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-sess-1',
      prompt: [{ type: 'text', text: 'hello v2' }]
    })
    await waitFor(() => proc.prompts.length === 1, 'prompt dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'v2 world' } })
    proc.emit({ type: 'agent_settled' })

    const response = await withTimeout(prompt, 'session/prompt')
    assert.equal(typeof response.messageId, 'string')

    // The user message is echoed with the response's messageId...
    const userMessage = received('user_message')[0]
    assert.deepEqual(userMessage?.update, {
      sessionUpdate: 'user_message',
      messageId: response.messageId,
      content: [{ type: 'text', text: 'hello v2' }]
    })

    // ...the turn reports its state and streams its message with grouped ids.
    const kinds = updates.map(update => update.update.sessionUpdate)
    assert.ok(kinds.indexOf('state_update') < kinds.indexOf('agent_message_chunk'), 'running precedes the message')
    const chunks = received('agent_message_chunk')
    assert.equal(chunks.length, 2)
    const chunkIds = chunks.map(chunk => (chunk.update as { messageId: string }).messageId)
    assert.equal(chunkIds[0], chunkIds[1], 'chunks of one message share its id')
    assert.notEqual(chunkIds[0], response.messageId)
    assert.deepEqual(
      chunks.map(chunk => (chunk.update as { content: { type: string; text: string } }).content),
      [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'v2 world' }
      ]
    )

    // The turn settles with an idle state_update carrying the v1 stop reason.
    const idle = received('state_update').find(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idle, 'idle state after the turn')
    assert.equal((idle!.update as { stopReason?: string }).stopReason, 'end_turn')
    assert.ok(updates.indexOf(idle!) > updates.indexOf(chunks[1]!), 'idle follows the turn updates')

    // Commands are advertised with their v2 input tag; commands without
    // arguments advertise no input at all.
    await waitFor(() => received('available_commands_update').length > 0, 'available_commands_update')
    const commands = received('available_commands_update')[0]!.update as {
      availableCommands: Array<{ input?: { type: string; hint: string } }>
    }
    const withInput = commands.availableCommands.filter(command => command.input != null)
    assert.ok(withInput.length > 0, 'builtin commands with inputs are advertised')
    assert.ok(withInput.every(command => command.input?.type === 'text'))
    assert.ok(commands.availableCommands.every(command => command.input == null || command.input?.type === 'text'))

    assert.deepEqual(
      await withTimeout(
        conn.agent.request(v2.methods.agent.session.close, { sessionId: 'v2-sess-1' }),
        'session/close'
      ),
      {}
    )
    assert.equal(proc.disposeCount, 1, 'close frees the pi subprocess')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 resume with replayFrom start replays history through the v2 shapes', async () => {
  const proc = patchSpawn(fakeState('s1'))
  // pi history snapshot: one user and one assistant message on the active branch.
  proc.entrySnapshot = {
    entries: [
      { id: 'e1', parentId: null, timestamp: '', type: 'message', message: { role: 'user', content: 'Hello' } },
      {
        id: 'e2',
        parentId: 'e1',
        timestamp: '',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
      }
    ],
    leafId: 'e2'
  }

  let activeAgent: PiAcpAgent | null = null
  const { conn, updates, received } = connectV2(agent => {
    activeAgent = agent
  })
  try {
    await initialize(conn)
    // The store mapping the restore resolves through (the v1 component tests
    // replace the same seam).
    assert.ok(activeAgent)
    ;(activeAgent as unknown as { store: unknown }).store = {
      get: () => ({
        sessionId: 's1',
        cwd: TEST_CWD,
        sessionFile: SESSION_FILE,
        updatedAt: new Date().toISOString()
      }),
      upsert() {}
    }

    const resumed = await withTimeout(
      conn.agent.request(v2.methods.agent.session.resume, {
        sessionId: 's1',
        cwd: TEST_CWD,
        replayFrom: { type: 'start' }
      }),
      'session/resume'
    )
    assert.ok(resumed.configOptions?.some(option => option.configId === 'model'))

    const userChunks = received('user_message_chunk')
    assert.equal(userChunks.length, 1)
    assert.equal((userChunks[0]!.update as { content: { text: string } }).content.text, 'Hello')

    const agentChunks = received('agent_message_chunk')
    assert.equal(agentChunks.length, 1)
    assert.equal((agentChunks[0]!.update as { content: { text: string } }).content.text, 'Hi there')
    assert.notEqual(
      (userChunks[0]!.update as { messageId: string }).messageId,
      (agentChunks[0]!.update as { messageId: string }).messageId
    )

    // The current-state snapshot follows the replay and precedes the response.
    const idle = received('state_update').find(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idle, 'idle snapshot after resume')
    assert.ok(updates.indexOf(idle!) > updates.indexOf(agentChunks[0]!))
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 set_config_option maps id values and rejects non-id values', async () => {
  const proc = patchSpawn(fakeState('v2-sess-config'))
  proc.availableThinkingLevels = ['low', 'medium', 'high']
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })

    const response = await withTimeout(
      conn.agent.request(v2.methods.agent.session.setConfigOption, {
        sessionId: 'v2-sess-config',
        configId: 'model',
        type: 'id',
        value: 'test/model'
      }),
      'set_config_option'
    )
    assert.deepEqual(proc.models, [{ provider: 'test', modelId: 'model' }])
    assert.equal(response.configOptions.find(option => option.configId === 'model')?.currentValue, 'test/model')
    await waitFor(() => received('config_option_update').length > 0, 'config_option_update')
    const update = received('config_option_update')[0]!.update as {
      configOptions: Array<{ configId: string }>
    }
    assert.ok(update.configOptions.some(option => option.configId === 'model'))

    // Only id values map: the adapter's options are selects.
    await assert.rejects(
      () =>
        withTimeout(
          conn.agent.request(v2.methods.agent.session.setConfigOption, {
            sessionId: 'v2-sess-config',
            configId: 'model',
            type: 'boolean',
            value: true
          }),
          'boolean config value'
        ),
      (err: unknown) => {
        const error = err as { code?: number; message?: string }
        assert.equal(error.code, -32602)
        assert.match(String(error.message), /Expected string value for config option/)
        return true
      }
    )
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 session/new rejects non-empty mcpServers exactly as v1 does', async () => {
  const proc = patchSpawn(fakeState('v2-sess-mcp'))
  const { conn } = connectV2()
  try {
    await initialize(conn)
    await assert.rejects(
      () =>
        withTimeout(
          conn.agent.request(v2.methods.agent.session.new, {
            cwd: TEST_CWD,
            mcpServers: [{ type: 'stdio', name: 'github', command: 'github-mcp-server', args: [] }]
          }),
          'mcp session/new'
        ),
      (err: unknown) => {
        const error = err as { code?: number; message?: string; data?: { reason?: string } }
        assert.equal(error.code, -32602)
        assert.equal(error.data?.reason, 'MCP_SERVERS_UNSUPPORTED')
        assert.match(String(error.message), /does not bridge client-provided MCP servers/)
        assert.match(String(error.message), /Remove mcpServers/)
        return true
      }
    )
    assert.equal(proc.prompts.length, 0, 'no pi work may start for a rejected request')
  } finally {
    conn.close()
    proc.restore()
  }
})
