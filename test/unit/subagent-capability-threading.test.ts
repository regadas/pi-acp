import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import type { InitializeRequest } from '@agentclientprotocol/sdk/unstable'

/**
 * Agent wired to a real SessionManager/SessionStore with PiRpcProcess.spawn
 * mocked, so both session-creation paths (newSession -> create, resumeSession
 * -> restore -> getOrCreate) run the real capability threading. The pi agent
 * dir is isolated per test so repository discovery never scans real sessions.
 */
async function makeHarness(t: TestContext, clientCapabilities: InitializeRequest['clientCapabilities']) {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-subagent-cap-agent-'))

  const conn = new FakeAgentSideConnection()
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pi-acp-subagent-cap-map-')), 'session-map.json'))
  const sessions = new SessionManager(store)
  const originalSpawn = PiRpcProcess.spawn

  const agent = new PiAcpAgent(asAgentConn(conn), store)
  const agentRecord = agent as unknown as Record<string, unknown>
  agentRecord.sessions = sessions
  ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = async (options: { sessionPath?: string }) => {
    const proc = new FakePiRpcProcess()
    // A restore names the stored session file; a fresh spawn invents an id.
    const sessionId = options.sessionPath ? basename(options.sessionPath, '.jsonl') : crypto.randomUUID()
    proc.state = {
      isStreaming: false,
      sessionId,
      sessionFile: join(TEST_CWD, 'sessions', `${sessionId}.jsonl`),
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'model', reasoning: true }
    }
    return proc
  }

  t.after(() => {
    ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    agent.dispose()
  })

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities
  })

  return { conn, agent, sessions, store }
}

const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-subagent-cap-cwd-'))

function seedStoredSession(store: SessionStore, name: string) {
  const sessionId = `subagent-cap-${name}`
  const sessionFile = join(TEST_CWD, 'sessions', `${sessionId}.jsonl`)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd: TEST_CWD })}\n`, 'utf-8')
  store.upsert({ sessionId, cwd: TEST_CWD, sessionFile, additionalDirectories: [] })
  return sessionId
}

const isWindows = process.platform === 'win32'

const sessionFlag = (session: unknown): boolean | undefined =>
  (session as { supportsSubagentUpdates?: boolean }).supportsSubagentUpdates

test(
  'PiAcpAgent: the negotiated subagents capability reaches every session-creation path',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { agent, sessions, store } = await makeHarness(t, { subagents: {} })
    const storedId = seedStoredSession(store, 'resume')

    const created = await agent.newSession({ cwd: TEST_CWD, mcpServers: [] })
    assert.equal(sessionFlag(sessions.get(created.sessionId)), true, 'newSession thread the capability on')

    await agent.resumeSession({ sessionId: storedId, cwd: TEST_CWD, mcpServers: [] })
    assert.equal(sessionFlag(sessions.get(storedId)), true, 'resumeSession thread the capability on')
  }
)

test(
  'PiAcpAgent: plain clientCapabilities keep every session-creation path off',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { agent, sessions, store } = await makeHarness(t, {})
    const storedId = seedStoredSession(store, 'plain')

    const created = await agent.newSession({ cwd: TEST_CWD, mcpServers: [] })
    assert.equal(sessionFlag(sessions.get(created.sessionId)), false, 'newSession keeps the capability off')

    await agent.resumeSession({ sessionId: storedId, cwd: TEST_CWD, mcpServers: [] })
    assert.equal(sessionFlag(sessions.get(storedId)), false, 'resumeSession keeps the capability off')
  }
)
