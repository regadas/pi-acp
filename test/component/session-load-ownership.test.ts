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
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-load-ownership-cwd-'))

const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: TEST_CWD, sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
  delete() {}
}

type LoadOwnershipProcOptions = {
  getTree?: (beforeResponseResolve?: () => void) => Promise<unknown>
}

class MockProc {
  disposed = false
  disposeCount = 0
  readonly thinkingLevels: string[] = []
  private readonly getTreeImpl: NonNullable<LoadOwnershipProcOptions['getTree']>
  private thinkingLevel = 'medium'
  private eventHandlers: Array<(ev: any) => void> = []

  constructor(opts?: LoadOwnershipProcOptions) {
    this.getTreeImpl =
      opts?.getTree ??
      (async beforeResponseResolve => {
        beforeResponseResolve?.()
        return { tree: [], leafId: null }
      })
  }

  /** Deliver a live pi event to the installed session, like the real channel. */
  emit(ev: unknown): void {
    for (const handler of this.eventHandlers) handler(ev)
  }

  onEvent(handler: (ev: any) => void) {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(entry => entry !== handler)
    }
  }
  onTermination() {
    return () => {}
  }
  async whenTerminated() {}
  async abort() {}
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
    return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
  }
  async getState() {
    return {
      thinkingLevel: this.thinkingLevel,
      model: { provider: 'test', id: 'alpha', reasoning: true },
      // Restore validation requires pi to report the requested session.
      sessionId: 's1',
      sessionFile: '/tmp/s.jsonl',
      isStreaming: false
    }
  }
  async setThinkingLevel(level: string) {
    this.thinkingLevels.push(level)
    this.thinkingLevel = level
  }
  async getCommands() {
    return { commands: [] }
  }
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

function makeAgent() {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = new FakeStore()
  ;(agent as any).scheduleDeferred = () => {}
  const manager = (agent as any).sessions as SessionManager
  return { agent, conn, manager }
}

const loadParams = { sessionId: 's1', cwd: TEST_CWD, mcpServers: [] }

test('resumeSession waits for an active load and recovers after that load fails', async () => {
  const treeStarted = deferred()
  const releaseTree = deferred()
  const loadProc = new MockProc({
    getTree: async () => {
      treeStarted.resolve()
      await releaseTree.promise
      throw new Error('get_tree exploded mid-load')
    }
  })
  const retryProc = new MockProc()
  const { agent, manager } = makeAgent()

  await withMockSpawn([loadProc, retryProc], async () => {
    const load = agent.loadSession(loadParams)
    await treeStarted.promise

    // The load's restored process is provisional; a concurrent resume must
    // wait for the load to settle instead of sharing it.
    let resumeSettled = false
    const resume = agent.resumeSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] }).then(response => {
      resumeSettled = true
      return response
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(resumeSettled, false, 'resume must not proceed while the load owns the provisional session')

    releaseTree.resolve()
    await assert.rejects(load, /get_tree exploded mid-load/)

    // The failed load evicted and disposed its provisional process; resume
    // recovers by restoring a fresh one instead of using the dead child.
    const response = await resume
    assert.ok(Array.isArray(response.configOptions))
    assert.equal(loadProc.disposeCount, 1, 'the failed load disposed its provisional process')
    assert.equal(manager.maybeGet('s1')?.proc, retryProc as any, 'resume restored a fresh process')
    assert.equal(retryProc.disposeCount, 0)
  })
})

test('loadSession configuration probe errors reject and clean up the restored process', async () => {
  const proc = new MockProc()
  ;(proc as any).getAvailableModels = async () => {
    throw new Error('models unavailable after replay')
  }
  const { agent, manager } = makeAgent()

  await withMockSpawn([proc], async () => {
    await assert.rejects(() => agent.loadSession(loadParams), /models unavailable after replay/)
  })
  assert.equal(proc.disposeCount, 1)
  assert.equal(manager.maybeGet('s1'), undefined)
})

test('resumeSession configuration probe errors reject instead of returning fallback config', async () => {
  const proc = new MockProc()
  ;(proc as any).getAvailableModels = async () => {
    throw new Error('resume models unavailable')
  }
  const { agent } = makeAgent()

  await withMockSpawn([proc], async () => {
    await assert.rejects(
      () => agent.resumeSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] }),
      /resume models unavailable/
    )
  })
})

test('setSessionConfigOption waits for an active load and recovers after that load fails', async () => {
  const treeStarted = deferred()
  const releaseTree = deferred()
  const loadProc = new MockProc({
    getTree: async () => {
      treeStarted.resolve()
      await releaseTree.promise
      throw new Error('get_tree exploded mid-load')
    }
  })
  const retryProc = new MockProc()
  const { agent, manager } = makeAgent()

  await withMockSpawn([loadProc, retryProc], async () => {
    const load = agent.loadSession(loadParams)
    await treeStarted.promise

    let configSettled = false
    const config = agent
      .setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any)
      .then(response => {
        configSettled = true
        return response
      })

    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(configSettled, false, 'config mutation must not run against the load-owned provisional session')
    assert.deepEqual(loadProc.thinkingLevels, [], 'no write may reach the provisional process')

    releaseTree.resolve()
    await assert.rejects(load, /get_tree exploded mid-load/)

    const result = await config
    assert.ok(Array.isArray(result.configOptions))
    assert.deepEqual(loadProc.thinkingLevels, [], 'the torn-down process never received the write')
    assert.deepEqual(retryProc.thinkingLevels, ['high'], 'the mutation applied to the freshly restored process')
    assert.equal(manager.maybeGet('s1')?.proc, retryProc as any)
    assert.equal(loadProc.disposeCount, 1)
  })
})

test('session/load replay and concurrent live updates share one delivery order', async () => {
  // A freshly restored pi child can emit autonomous output while session/load
  // is still replaying history. Both paths must go through the session's
  // single ordered delivery queue: replay must never jump ahead of a live
  // update that was already queued.
  const gate = deferred()
  const conn = new FakeAgentSideConnection()
  const delivered: string[] = []
  let gatedFirstDelivery = false

  conn.sessionUpdate = async msg => {
    const update = msg.update as { sessionUpdate: string; content?: { text?: unknown } }
    const text = typeof update.content?.text === 'string' ? update.content.text : update.sessionUpdate

    // Hold the very first delivery open so later updates must queue behind it.
    if (!gatedFirstDelivery) {
      gatedFirstDelivery = true
      await gate.promise
    }
    delivered.push(text)
  }

  const treeStarted = deferred()
  const releaseTree = deferred()
  const proc = new MockProc({
    getTree: async beforeResponseResolve => {
      treeStarted.resolve()
      await releaseTree.promise
      beforeResponseResolve?.()
      return {
        tree: [
          {
            entry: {
              id: 'e1',
              parentId: null,
              timestamp: '',
              type: 'message',
              message: { role: 'assistant', content: [{ type: 'text', text: 'replayed history' }] }
            },
            children: []
          }
        ],
        leafId: 'e1'
      }
    }
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = new FakeStore()
  ;(agent as any).scheduleDeferred = () => {}

  await withMockSpawn([proc], async () => {
    const load = agent.loadSession(loadParams)
    await treeStarted.promise

    // The session is installed and subscribed: an autonomous extension run
    // streams while replay is still pending. The first emit occupies the
    // gated delivery, the second queues behind it.
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live one' } })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live two' } })
    await tick()

    releaseTree.resolve()
    await tick()
    gate.resolve()
    await load
  })

  const ordered = delivered.filter(text => ['live one', 'live two', 'replayed history'].includes(text))
  assert.deepEqual(
    ordered,
    ['live one', 'live two', 'replayed history'],
    'replay must be delivered through the same queue as live updates, never ahead of a queued one'
  )
})

test('config restore retries when a load begins during the restore TOCTOU window', async () => {
  const releaseFirstSpawn = deferred()
  const firstSpawnStarted = deferred()
  const preLoadProc = new MockProc()
  const loadProc = new MockProc()
  const { agent, manager } = makeAgent()
  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    if (spawnCount === 1) {
      firstSpawnStarted.resolve()
      await releaseFirstSpawn.promise
      return preLoadProc as any
    }
    if (spawnCount === 2) return loadProc as any
    throw new Error('unexpected extra spawn')
  }

  try {
    const config = agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'thought_level',
      value: 'high'
    } as any)
    await firstSpawnStarted.promise

    const load = agent.loadSession(loadParams)
    releaseFirstSpawn.resolve()
    await load
    await config

    assert.deepEqual(preLoadProc.thinkingLevels, [], 'the process superseded by load never receives the write')
    assert.deepEqual(loadProc.thinkingLevels, ['high'], 'config retries against the load-surviving process')
    assert.equal(preLoadProc.disposeCount, 1)
    assert.equal(manager.maybeGet('s1')?.proc, loadProc as any)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
