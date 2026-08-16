import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent, getCachedUpdateNoticeForTests, resetUpdateNoticeCacheForTests } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn, fakeSessionConfigSync } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-startup-info-cwd-'))

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('PiAcpAgent: quietStartup=true disables startup info generation/emission', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  try {
    const conn = new FakeAgentSideConnection()

    let setStartupInfoCalled = false
    const session = {
      sessionId: 's1',
      cwd: TEST_CWD,
      ...fakeSessionConfigSync(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true
      },
      sendStartupInfoIfPending() {
        // may be called when an update notice is available
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    // Local seam: capture deferred notifications (agent schedules available
    // commands; startup info is no longer scheduled out-of-turn and is
    // flushed on the first prompt).
    const deferred: Array<() => void> = []
    ;(agent as any).scheduleDeferred = (task: () => void) => {
      deferred.push(task)
    }

    const res = await agent.newSession({ cwd: TEST_CWD, mcpServers: [] } as any)

    const startupInfo = res?._meta?.piAcp?.startupInfo ?? null

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/)
      assert.equal(setStartupInfoCalled, true)
    } else {
      assert.equal(setStartupInfoCalled, false)
    }
    // Only the available-commands advertisement is scheduled; the startup
    // banner must not be scheduled out-of-turn (ACP protocol; issue #59).
    assert.equal(deferred.length, 1)
  } finally {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: startup info uses PI_CODING_AGENT_DIR for every global pi resource', async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousPiCommand = process.env.PI_ACP_PI_COMMAND
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-startup-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-startup-cwd-'))
  const skillDir = join(agentDir, 'skills', 'override-skill')
  const promptsDir = join(agentDir, 'prompts')
  const extensionsDir = join(agentDir, 'extensions')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(promptsDir, { recursive: true })
  mkdirSync(extensionsDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# Override skill\n', 'utf8')
  writeFileSync(join(promptsDir, 'override-prompt.md'), 'Override prompt\n', 'utf8')
  writeFileSync(join(extensionsDir, 'override-extension.ts'), 'export {}\n', 'utf8')
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ quietStartup: false, packages: ['npm:override-package'] }),
    'utf8'
  )
  const piStub = join(agentDir, 'pi-stub')
  writeFileSync(piStub, '#!/bin/sh\nprintf "0.80.10\\n"\n', 'utf8')
  chmodSync(piStub, 0o755)

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_ACP_PI_COMMAND = piStub
  resetUpdateNoticeCacheForTests()
  getCachedUpdateNoticeForTests(() => null)

  const session = {
    sessionId: 's-startup',
    cwd,
    ...fakeSessionConfigSync(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
      },
      async getState() {
        return { thinkingLevel: 'off', model: { provider: 'test', id: 'model', reasoning: false } }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    ;(agent as any).sessions = new FakeSessions(session) as any
    ;(agent as any).scheduleDeferred = () => {}

    const response = await agent.newSession({ cwd, mcpServers: [] } as any)
    const startupInfo = String(response._meta?.piAcp?.startupInfo ?? '')
    assert.match(startupInfo, /pi v0\.80\.10/)
    assert.ok(startupInfo.includes(join(skillDir, 'SKILL.md')))
    assert.match(startupInfo, /\/override-prompt/)
    assert.ok(startupInfo.includes(join(extensionsDir, 'override-extension.ts')))
    assert.match(startupInfo, /npm:override-package/)
    assert.ok(!startupInfo.includes(join(homedir(), '.pi', 'agent')), 'no hard-coded default agent path')
  } finally {
    resetUpdateNoticeCacheForTests()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousPiCommand === undefined) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = previousPiCommand
  }
})

test('update notice cache computes once and caches null', () => {
  resetUpdateNoticeCacheForTests()
  let calls = 0
  const compute = () => {
    calls += 1
    return null
  }
  assert.equal(getCachedUpdateNoticeForTests(compute), null)
  assert.equal(getCachedUpdateNoticeForTests(compute), null)
  assert.equal(calls, 1)
  resetUpdateNoticeCacheForTests()
})
