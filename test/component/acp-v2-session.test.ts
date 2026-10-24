import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const fakeState = (sessionId: string, sessionFile: string = SESSION_FILE): Record<string, unknown> => ({
  sessionId,
  sessionFile,
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

test('v2 close fence is transient: close, then resume and prompt work again', async () => {
  // A restore through the real store validates the JSONL header, so the
  // session file carries the header pi itself would have written.
  const fenceFile = join(tmpdir(), 'pi-acp-v2-fence-sess.jsonl')
  writeFileSync(
    fenceFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'v2-fence',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: TEST_CWD
    }) + '\n'
  )
  const proc = patchSpawn(fakeState('v2-fence', fenceFile))
  proc.terminateOnDispose = true
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })
    const first = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-fence',
      prompt: [{ type: 'text', text: 'first' }]
    })
    await waitFor(() => proc.prompts.length === 1, 'first prompt dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } })
    proc.emit({ type: 'agent_settled' })
    await withTimeout(first, 'first prompt')

    assert.deepEqual(
      await withTimeout(conn.agent.request(v2.methods.agent.session.close, { sessionId: 'v2-fence' }), 'close'),
      {}
    )

    // The fence only covered the in-flight close: resume re-establishes the
    // session and the next prompt runs a full turn instead of answering
    // request-cancelled.
    await withTimeout(
      conn.agent.request(v2.methods.agent.session.resume, { sessionId: 'v2-fence', cwd: TEST_CWD }),
      'resume after close'
    )
    const second = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-fence',
      prompt: [{ type: 'text', text: 'second' }]
    })
    await waitFor(() => proc.prompts.length === 2, 'second prompt dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'again' } })
    proc.emit({ type: 'agent_settled' })
    const response = await withTimeout(second, 'prompt after close+resume')
    assert.equal(typeof response.messageId, 'string')
    const idles = received('state_update').filter(update => (update.update as { state: string }).state === 'idle')
    assert.equal((idles[idles.length - 1]!.update as { stopReason?: string }).stopReason, 'end_turn')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 close fence is transient: a never-opened session id does not stay poisoned', async () => {
  const proc = patchSpawn(fakeState('never-opened'))
  proc.terminateOnDispose = true
  let activeAgent: PiAcpAgent | null = null
  const { conn } = connectV2(agent => {
    activeAgent = agent
  })
  try {
    await initialize(conn)
    assert.ok(activeAgent)
    ;(activeAgent as unknown as { store: unknown }).store = {
      get: () => ({
        sessionId: 'never-opened',
        cwd: TEST_CWD,
        sessionFile: SESSION_FILE,
        updatedAt: new Date().toISOString()
      }),
      upsert() {}
    }

    // Closing an id this connection never opened succeeds silently; the
    // fence it sets must not outlive the close.
    assert.deepEqual(
      await withTimeout(
        conn.agent.request(v2.methods.agent.session.close, { sessionId: 'never-opened' }),
        'close of never-opened id'
      ),
      {}
    )

    await withTimeout(
      conn.agent.request(v2.methods.agent.session.resume, { sessionId: 'never-opened', cwd: TEST_CWD }),
      'resume of never-opened id'
    )
    const prompt = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'never-opened',
      prompt: [{ type: 'text', text: 'hello' }]
    })
    await waitFor(() => proc.prompts.length === 1, 'prompt dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
    proc.emit({ type: 'agent_settled' })
    const response = await withTimeout(prompt, 'prompt after never-opened close')
    assert.equal(typeof response.messageId, 'string')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 pipelined prompts: one running, no idle between turns', async () => {
  const proc = patchSpawn(fakeState('v2-pipe'))
  const { conn, updates, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })

    const first = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-pipe',
      prompt: [{ type: 'text', text: 'one' }]
    })
    const second = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-pipe',
      prompt: [{ type: 'text', text: 'two' }]
    })

    await waitFor(() => proc.prompts.length === 1, 'first turn dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first turn' } })
    proc.emit({ type: 'agent_settled' })
    await waitFor(() => proc.prompts.length === 2, 'second turn dispatch')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second turn' } })
    proc.emit({ type: 'agent_settled' })

    const [responseOne, responseTwo] = await Promise.all([
      withTimeout(first, 'first prompt'),
      withTimeout(second, 'second prompt')
    ])
    assert.equal(typeof responseOne.messageId, 'string')
    assert.equal(typeof responseTwo.messageId, 'string')

    const running = received('state_update').filter(update => (update.update as { state: string }).state === 'running')
    assert.equal(running.length, 1, 'one running snapshot while both prompts are in flight')

    // No idle may precede the last turn update: the session only reports idle
    // once every in-flight prompt has settled.
    const lastChunkIndex = updates.map(update => update.update.sessionUpdate).lastIndexOf('agent_message_chunk')
    const falseIdle = received('state_update').find(
      update => (update.update as { state: string }).state === 'idle' && updates.indexOf(update) < lastChunkIndex
    )
    assert.equal(falseIdle, undefined, 'no idle snapshot between pipelined turns')
    const idles = received('state_update').filter(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idles.length > 0, 'the busy period settles with idle snapshots')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 prompt followed immediately by cancel: cancelled, no full turn', async () => {
  const proc = patchSpawn(fakeState('v2-cancel'))
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })

    const prompt = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-cancel',
      prompt: [{ type: 'text', text: 'long work' }]
    })
    await conn.agent.notify(v2.methods.agent.session.cancel, { sessionId: 'v2-cancel' })
    // Real pi settles its aborted run; the deterministic stand-in does the same.
    proc.emit({ type: 'agent_settled' })
    const response = await withTimeout(prompt, 'cancelled prompt')

    // Inserted: the request answers with its messageId, and the turn reports
    // the cancellation as its idle state.
    assert.equal(typeof response.messageId, 'string')
    const idle = received('state_update').find(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idle, 'idle after the cancelled turn')
    assert.equal((idle!.update as { stopReason?: string }).stopReason, 'cancelled')
    assert.equal(received('agent_message_chunk').length, 0, 'no turn output was streamed')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 prompt followed immediately by close: acknowledged without a respawned full turn', async () => {
  const proc = patchSpawn(fakeState('v2-close-race'))
  proc.terminateOnDispose = true
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })

    const prompt = conn.agent.request(v2.methods.agent.session.prompt, {
      sessionId: 'v2-close-race',
      prompt: [{ type: 'text', text: 'long work' }]
    })
    const close = conn.agent.request(v2.methods.agent.session.close, { sessionId: 'v2-close-race' })
    const [response] = await Promise.all([withTimeout(prompt, 'prompt under close'), withTimeout(close, 'close')])

    assert.equal(typeof response.messageId, 'string')
    // The cancelled turn's idle was flushed before the close was acknowledged.
    const idle = received('state_update').find(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idle, 'idle flushed before the close response')
    assert.equal((idle!.update as { stopReason?: string }).stopReason, 'cancelled')
    assert.equal(received('agent_message_chunk').length, 0, 'no full turn ran')
    const promptsAtClose = proc.prompts.length
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(proc.prompts.length, promptsAtClose, 'no session respawn or further dispatch after close')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 prompt of an unknown session rejects before any user_message echo', async () => {
  const proc = patchSpawn(fakeState('v2-unknown'))
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await assert.rejects(
      () =>
        withTimeout(
          conn.agent.request(v2.methods.agent.session.prompt, {
            sessionId: 'no-such-session',
            prompt: [{ type: 'text', text: 'hello' }]
          }),
          'unknown session prompt'
        ),
      (err: unknown) => {
        assert.equal((err as { code?: number }).code, -32002)
        return true
      }
    )
    assert.equal(received('user_message').length, 0, 'no echo for a rejected prompt')
    assert.equal(received('state_update').length, 0, 'no state snapshot for a rejected prompt')
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 turn failure resolves the prompt request and reports the error via idle', async () => {
  const proc = patchSpawn(fakeState('v2-error'))
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })
    // The pi turn itself fails after insertion.
    ;(proc as unknown as { prompt: unknown }).prompt = async () => {
      throw new Error('provider exploded')
    }

    const response = await withTimeout(
      conn.agent.request(v2.methods.agent.session.prompt, {
        sessionId: 'v2-error',
        prompt: [{ type: 'text', text: 'hello' }]
      }),
      'failing prompt'
    )
    assert.equal(typeof response.messageId, 'string', 'an inserted prompt never rejects the request')

    const idle = received('state_update').find(update => (update.update as { state: string }).state === 'idle')
    assert.ok(idle, 'error idle reported')
    const update = idle!.update as { stopReason?: string; error?: { code: number; message: string } }
    assert.equal(update.stopReason, 'error')
    assert.match(update.error?.message ?? '', /provider exploded/)
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 edit tool updates translate the structured diff with a git patch', async () => {
  const proc = patchSpawn(fakeState('v2-diff'))
  const workspace = mkdtempSync(join(tmpdir(), 'pi-acp-v2-diff-'))
  const editedFile = join(workspace, 'file.txt')
  writeFileSync(editedFile, 'old line\n')
  const { conn, received } = connectV2()
  try {
    await initialize(conn)
    await conn.agent.request(v2.methods.agent.session.new, { cwd: TEST_CWD })

    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 't-edit',
      toolName: 'edit',
      args: { path: editedFile, edits: [{ oldText: 'old line', newText: 'new line' }] }
    })
    writeFileSync(editedFile, 'new line\n')
    proc.emit({ type: 'tool_execution_end', toolCallId: 't-edit', toolName: 'edit', result: 'edited', isError: false })

    await waitFor(
      () => received('tool_call_update').some(update => (update.update as { status?: string }).status === 'completed'),
      'completed edit tool call'
    )
    const completed = received('tool_call_update').find(
      update => (update.update as { status?: string }).status === 'completed'
    )
    const content = (completed!.update as { content?: unknown[] }).content
    assert.ok(content?.length, 'diff content preserved')
    const diff = content![0] as {
      type: string
      changes: Array<{ operation: string; path: string }>
      patch?: { format: string; text: string }
    }
    assert.equal(diff.type, 'diff')
    assert.deepEqual(diff.changes, [{ operation: 'modify', path: editedFile }])
    assert.equal(diff.patch?.format, 'git_patch')
    assert.match(diff.patch?.text ?? '', /-old line/)
    assert.match(diff.patch?.text ?? '', /\+new line/)
    // The translated content is valid per the installed v2 schema guard.
    assert.ok(v2.ToolCallContent.isDiff(diff as v2.ToolCallContent))
  } finally {
    conn.close()
    proc.restore()
  }
})

test('v2 replay message ids are deterministic and adjacent same-kind entries stay separate', async () => {
  const proc = patchSpawn(fakeState('s1'))
  proc.terminateOnDispose = true
  // Two adjacent user entries followed by an assistant entry.
  proc.entrySnapshot = {
    entries: [
      { id: 'e1', parentId: null, timestamp: '', type: 'message', message: { role: 'user', content: 'Hello' } },
      { id: 'e2', parentId: 'e1', timestamp: '', type: 'message', message: { role: 'user', content: 'Second' } },
      {
        id: 'e3',
        parentId: 'e2',
        timestamp: '',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
      }
    ],
    leafId: 'e3'
  }

  let activeAgent: PiAcpAgent | null = null
  const { conn, updates } = connectV2(agent => {
    activeAgent = agent
  })
  // Chunk ids captured per replay window, waiting for each window's chunks
  // to arrive so notification delivery lag cannot mix the windows.
  const windowIds = async (replay: () => Promise<unknown>): Promise<Array<[string, string]>> => {
    const from = updates.length
    await withTimeout(replay(), 'replay')
    await waitFor(
      () => updates.slice(from).filter(update => update.update.sessionUpdate.endsWith('_chunk')).length >= 3,
      'replayed chunks'
    )
    return updates
      .slice(from)
      .filter(update => update.update.sessionUpdate.endsWith('_chunk'))
      .map(
        update => [update.update.sessionUpdate, (update.update as { messageId: string }).messageId] as [string, string]
      )
  }
  try {
    await initialize(conn)
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

    const replay = () =>
      conn.agent.request(v2.methods.agent.session.resume, {
        sessionId: 's1',
        cwd: TEST_CWD,
        replayFrom: { type: 'start' }
      })

    const firstIds = await windowIds(replay)
    const secondIds = await windowIds(replay)

    // Replaying the same history twice yields identical ids.
    assert.deepEqual(secondIds, firstIds)
    assert.deepEqual(firstIds, [
      ['user_message_chunk', 'replay:user_message_chunk:0'],
      ['user_message_chunk', 'replay:user_message_chunk:1'],
      ['agent_message_chunk', 'replay:agent_message_chunk:0']
    ])
    // Adjacent same-kind entries never merge: the two user entries carry
    // distinct ids.
    assert.notEqual(firstIds[0]![1], firstIds[1]![1])
  } finally {
    conn.close()
    proc.restore()
  }
})
