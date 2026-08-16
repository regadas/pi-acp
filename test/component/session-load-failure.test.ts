import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-load-failure-cwd-'))

class FakeStore {
  readonly deletes: string[] = []

  get(_sessionId: string) {
    return { sessionId: 's1', cwd: TEST_CWD, sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
  delete(sessionId: string) {
    this.deletes.push(sessionId)
  }
}

type MockProcOptions = {
  getTree?: (beforeResponseResolve?: () => void) => Promise<unknown>
}

class MockProc {
  disposed = false
  disposeCount = 0
  abortCount = 0
  private readonly getTreeImpl: NonNullable<MockProcOptions['getTree']>

  constructor(opts?: MockProcOptions) {
    this.getTreeImpl =
      opts?.getTree ??
      (async beforeResponseResolve => {
        beforeResponseResolve?.()
        return { tree: [], leafId: null }
      })
  }

  onEvent() {
    return () => {}
  }
  onTermination() {
    return () => {}
  }
  async whenTerminated() {}
  async abort() {
    this.abortCount += 1
  }
  // Idempotent, like PiRpcProcess.dispose().
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.disposeCount += 1
  }
  getTree(beforeResponseResolve?: () => void) {
    return this.getTreeImpl(beforeResponseResolve)
  }
  async getAvailableModels() {
    return { models: [] }
  }
  async getState() {
    // Restore validation requires pi to report the requested session.
    return { thinkingLevel: 'medium', sessionId: 's1', sessionFile: '/tmp/s.jsonl' }
  }
  async prompt() {}
}

function withMockSpawn<T>(procs: MockProc[], run: () => Promise<T>): Promise<T> {
  const originalSpawn = PiRpcProcess.spawn
  let next = 0
  ;(PiRpcProcess as any).spawn = async () => {
    const proc = procs[next]
    if (!proc) throw new Error('unexpected extra spawn')
    next += 1
    return proc as any
  }
  return run().finally(() => {
    PiRpcProcess.spawn = originalSpawn
  })
}

function makeAgent(conn = new FakeAgentSideConnection()) {
  const agent = new PiAcpAgent(asAgentConn(conn))
  const store = new FakeStore()
  ;(agent as any).store = store
  const manager = (agent as any).sessions as SessionManager
  return { agent, conn, store, manager }
}

const loadParams = { sessionId: 's1', cwd: TEST_CWD, mcpServers: [] }

test('loadSession: get_tree rejection evicts and disposes the freshly restored session', async () => {
  const proc = new MockProc({
    getTree: async () => {
      throw new Error('get_tree exploded')
    }
  })
  const { agent, store, manager } = makeAgent()

  await withMockSpawn([proc], async () => {
    await assert.rejects(() => agent.loadSession(loadParams), /get_tree exploded/)
  })

  assert.equal(manager.maybeGet('s1'), undefined, 'failed load must not leave the session installed')
  assert.equal(proc.disposeCount, 1, 'the pi subprocess of the failed load must be disposed')
  assert.deepEqual(store.deletes, [], 'the durable session store entry must be retained')
})

test('loadSession: malformed tree evicts and disposes the freshly restored session', async () => {
  const proc = new MockProc({
    getTree: async beforeResponseResolve => {
      beforeResponseResolve?.()
      return { tree: [{ entry: { type: 'message', id: 'a', parentId: null }, children: [] }], leafId: 'zzz' }
    }
  })
  const { agent, store, manager } = makeAgent()

  await withMockSpawn([proc], async () => {
    await assert.rejects(() => agent.loadSession(loadParams), /Cannot replay session history/)
  })

  assert.equal(manager.maybeGet('s1'), undefined)
  assert.equal(proc.disposeCount, 1)
  assert.deepEqual(store.deletes, [])
})

test('loadSession: a rejected client replay update evicts and disposes the session', async () => {
  const proc = new MockProc({
    getTree: async beforeResponseResolve => {
      beforeResponseResolve?.()
      return {
        tree: [
          {
            entry: {
              type: 'message',
              id: 'e1',
              parentId: null,
              timestamp: '2026-02-11T00:00:01.000Z',
              message: { role: 'user', content: 'Hello' }
            },
            children: []
          }
        ],
        leafId: 'e1'
      }
    }
  })

  const conn = new FakeAgentSideConnection()
  conn.sessionUpdate = async () => {
    throw new Error('client rejected the update')
  }
  const { agent, store, manager } = makeAgent(conn)

  await withMockSpawn([proc], async () => {
    await assert.rejects(() => agent.loadSession(loadParams), /client rejected the update/)
  })

  assert.equal(manager.maybeGet('s1'), undefined)
  assert.equal(proc.disposeCount, 1)
  assert.deepEqual(store.deletes, [])
})

test('loadSession: a losing load never disposes the replacement load that superseded it', async () => {
  let releaseFirstTree!: () => void
  const firstTreeGate = new Promise<void>(resolve => {
    releaseFirstTree = resolve
  })
  const procA = new MockProc({
    getTree: async beforeResponseResolve => {
      await firstTreeGate
      beforeResponseResolve?.()
      return { tree: [], leafId: null }
    }
  })
  const procB = new MockProc()
  const { agent, store, manager } = makeAgent()

  await withMockSpawn([procA, procB], async () => {
    const firstLoad = agent.loadSession(loadParams)
    // Let the first load restore its session and block inside get_tree.
    await new Promise(resolve => setTimeout(resolve, 0))

    const secondLoad = agent.loadSession(loadParams)
    await secondLoad

    releaseFirstTree()
    await assert.rejects(() => firstLoad, /session closed while loading/)
  })

  const current = manager.maybeGet('s1')
  assert.ok(current, 'the replacement session must stay installed')
  assert.equal(current?.proc, procB as any, 'the winner is the second load')
  assert.equal(procB.disposeCount, 0, 'a losing load must never dispose its replacement')
  assert.equal(procA.disposeCount, 1, 'the superseded load process is disposed exactly once')
  assert.deepEqual(store.deletes, [])
})
