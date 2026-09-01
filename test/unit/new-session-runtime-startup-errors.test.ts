import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []
  retirementWaits: Array<{ keys: string[]; timeoutMs: number }> = []

  constructor(
    private readonly session: any,
    private readonly retirementGate: Promise<void> = Promise.resolve()
  ) {}

  async create() {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }

  async waitForRetiredProcesses(keys: string[], timeoutMs: number) {
    this.retirementWaits.push({ keys, timeoutMs })
    await this.retirementGate
  }
}

test('PiAcpAgent: newSession returns AUTH_REQUIRED when pi reports an auth error after spawn', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-auth-'))
  const sessionFile = join(root, 'sessions', 'failed.jsonl')
  const sessionMapPath = join(root, 'session-map.json')

  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 's-auth',
      timestamp: '2026-05-07T00:00:00.000Z',
      cwd: process.cwd()
    }) + '\n',
    'utf-8'
  )

  const session = {
    sessionId: 's-auth',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('Authentication required: missing key')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null, sessionFile }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const store = new SessionStore(sessionMapPath)
  store.upsert({ sessionId: 's-auth', cwd: process.cwd(), sessionFile })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = sessions as any
  ;(agent as any).store = store as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32000
  )

  assert.deepEqual(sessions.closeCalls, ['s-auth'])
  assert.deepEqual(
    sessions.retirementWaits.map(wait => wait.keys),
    [['s-auth', sessionFile]]
  )
  assert.equal(existsSync(sessionFile), false)
  assert.equal(store.get('s-auth'), null)
})

test('PiAcpAgent: newSession waits for writer exit before deleting a failed session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-writer-barrier-'))
  const sessionFile = join(root, 'failed.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-barrier', cwd: process.cwd() })}\n`)
  let releaseRetirement!: () => void
  const retirementGate = new Promise<void>(resolve => {
    releaseRetirement = resolve
  })
  const session = {
    sessionId: 's-barrier',
    cwd: process.cwd(),
    proc: {
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ sessionFile })
    }
  }
  const sessions = new FakeSessions(session, retirementGate)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 's-barrier', cwd: process.cwd(), sessionFile })
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions
  ;(agent as any).store = store

  const creating = agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(existsSync(sessionFile), true, 'the file remains while its writer is retiring')
  assert.equal(sessions.retirementWaits.length, 1)

  releaseRetirement()
  await assert.rejects(creating, (error: any) => error?.code === -32000)
  assert.equal(existsSync(sessionFile), false)
})

test('PiAcpAgent: post-create configuration failure rolls back the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-config-rollback-'))
  const sessionFile = join(root, 'failed.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-config', cwd: process.cwd() })}\n`)
  let seeded = false
  const session = {
    sessionId: 's-config',
    cwd: process.cwd(),
    seedSessionConfiguration() {
      seeded = true
    },
    proc: {
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'Model' }] }),
      getAvailableThinkingLevels: async () => {
        throw new Error('thinking discovery failed')
      },
      getState: async () => ({
        sessionId: 's-config',
        sessionFile,
        thinkingLevel: 'off',
        model: { provider: 'test', id: 'model' }
      })
    }
  }
  const sessions = new FakeSessions(session)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 's-config', cwd: process.cwd(), sessionFile })
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions
  ;(agent as any).store = store

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    /thinking discovery failed/
  )
  assert.equal(seeded, false)
  assert.deepEqual(sessions.closeCalls, ['s-config'])
  assert.equal(existsSync(sessionFile), false)
  assert.equal(store.get('s-config'), null)
})

test('PiAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's-internal',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('socket hang up')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = sessions as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32603 && String(e?.message ?? '').includes('socket hang up')
  )

  assert.deepEqual(sessions.closeCalls, ['s-internal'])
})

test('PiAcpAgent: failed-session cleanup unlinks only the trusted store path, never a pi-reported one', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-cleanup-'))
  const sessionsDir = join(root, 'sessions')
  const trustedSessionFile = join(sessionsDir, 'trusted.jsonl')
  const untrustedSessionFile = join(sessionsDir, 'untrusted.jsonl')
  const sessionMapPath = join(root, 'session-map.json')

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(trustedSessionFile, '{}\n', 'utf-8')
  writeFileSync(untrustedSessionFile, '{}\n', 'utf-8')

  const session = {
    sessionId: 's-cleanup',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        // A later, unverified pi response must never decide what is deleted.
        return { thinkingLevel: 'medium', model: null, sessionFile: untrustedSessionFile }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const store = new SessionStore(sessionMapPath)
  store.upsert({ sessionId: 's-cleanup', cwd: process.cwd(), sessionFile: trustedSessionFile })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = sessions as any
  ;(agent as any).store = store as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32000
  )

  assert.deepEqual(sessions.closeCalls, ['s-cleanup'])
  assert.equal(existsSync(trustedSessionFile), true, 'an unvalidated store path is never unlinked')
  assert.equal(existsSync(untrustedSessionFile), true, 'a pi-reported path is never unlinked')
  assert.equal(store.get('s-cleanup'), null)
})
