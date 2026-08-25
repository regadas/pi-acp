import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-resume-cwd-'))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('PiAcpAgent: resumeSession restores a session without replaying history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-resume-store-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_resume.jsonl')
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-resume',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: TEST_CWD
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      })
    ].join('\n') + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  let historyReplayCalls = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    assert.equal(params.cwd, TEST_CWD)
    assert.ok(String(params.sessionPath).endsWith('0000_resume.jsonl'))
    return {
      onEvent: () => () => {},
      onTermination: () => () => {},
      whenTerminated: async () => {},
      getEntries: async () => {
        historyReplayCalls += 1
        return { entries: [], leafId: null }
      },
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
      getState: async () => ({
        thinkingLevel: 'medium',
        model: { provider: 'test', id: 'alpha', reasoning: true },
        // Restore validation requires pi to report the requested session.
        sessionId: 'sess-resume',
        sessionFile: String(params.sessionPath)
      })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    const res = await agent.resumeSession({ sessionId: 'sess-resume', cwd: TEST_CWD, mcpServers: [] })

    // Resume returns current session configuration...
    assert.ok(Array.isArray(res.configOptions) && res.configOptions.length > 0)
    assert.equal(res.configOptions?.find(option => option.id === 'thought_level')?.currentValue, 'medium')
    // ...through standard fields only (no custom root models, no legacy modes)...
    assert.equal('models' in (res as any), false)
    assert.equal('modes' in (res as any), false)

    // ...and MUST NOT replay conversation history before responding.
    assert.equal(historyReplayCalls, 0)
    assert.equal(conn.updates.length, 0)

    // Commands are advertised after the response has been delivered.
    await tick()
    const kinds = conn.updates.map(u => u.update.sessionUpdate)
    assert.deepEqual(kinds, ['available_commands_update'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})

test('PiAcpAgent: closeSession waits for an in-progress resume and releases its process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-close-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-resume-close-store-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_resume.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-resume',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: TEST_CWD
    }) + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  const originalSpawn = PiRpcProcess.spawn
  const proc = new FakePiRpcProcess()
  // Restore validation requires pi to report the requested session.
  proc.state = {
    isStreaming: false,
    sessionId: 'sess-resume',
    sessionFile: join(sessionsDir, '0000_resume.jsonl')
  }
  let releaseSpawn!: () => void
  const spawnGate = new Promise<void>(resolve => {
    releaseSpawn = resolve
  })
  ;(PiRpcProcess as any).spawn = async () => {
    await spawnGate
    return proc as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const manager = (agent as any).sessions as SessionManager
    const resume = agent.resumeSession({ sessionId: 'sess-resume', cwd: TEST_CWD, mcpServers: [] })
    const close = agent.closeSession({ sessionId: 'sess-resume' })

    releaseSpawn()
    await Promise.all([resume, close])

    assert.equal(proc.abortCount, 1)
    assert.equal(proc.disposeCount, 1)
    assert.equal(manager.maybeGet('sess-resume'), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})

test('PiAcpAgent: resumeSession validates cwd and unknown sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-invalid-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-resume-invalid-store-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_resume.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-resume',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: TEST_CWD
    }) + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

    await assert.rejects(
      () => agent.resumeSession({ sessionId: 'sess-resume', cwd: 'relative/path', mcpServers: [] }),
      /absolute path/i
    )

    await assert.rejects(
      () => agent.resumeSession({ sessionId: 'sess-resume', cwd: root, mcpServers: [] }),
      /does not match the session's recorded cwd/i
    )

    await assert.rejects(
      () => agent.resumeSession({ sessionId: 'unknown-session', cwd: TEST_CWD, mcpServers: [] }),
      /resource not found/i
    )
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})

test('PiAcpAgent: an equivalent alias cwd resumes under the recorded cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-resume-alias-'))
  const acpDir = mkdtempSync(join(tmpdir(), 'pi-acp-resume-alias-store-'))
  const workspace = mkdtempSync(join(tmpdir(), 'pi-acp-resume-alias-cwd-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_resume.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-alias',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: workspace
    }) + '\n',
    'utf-8'
  )

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = acpDir

  const spawnCwds: string[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCwds.push(params.cwd)
    return {
      onEvent: () => () => {},
      onTermination: () => () => {},
      whenTerminated: async () => {},
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }),
      getState: async () => ({
        thinkingLevel: 'medium',
        model: { provider: 'test', id: 'alpha', reasoning: true },
        sessionId: 'sess-alias',
        sessionFile: String(params.sessionPath)
      })
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    // Physically the same directory, spelled differently by the client.
    await agent.resumeSession({ sessionId: 'sess-alias', cwd: realpathSync.native(workspace), mcpServers: [] })

    assert.deepEqual(spawnCwds, [workspace], 'the recorded cwd stays authoritative for the pi subprocess')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})
