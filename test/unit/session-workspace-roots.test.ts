import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const isWindows = process.platform === 'win32'

type SpawnCall = { cwd: string; sessionPath?: string; additionalDirectories?: string[] }

/**
 * Agent wired to a real SessionStore/SessionManager in a temp dir, with
 * PiRpcProcess.spawn mocked so each child is a FakePiRpcProcess owning the
 * requested session identity. `events` records child ordering.
 */
function makeAgent(sessionId: string, sessionFile: string, opts?: { onSpawn?: (proc: FakePiRpcProcess) => void }) {
  const conn = new FakeAgentSideConnection()
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-ws-agent-'))
  const store = new SessionStore(join(dir, 'session-map.json'))
  const spawnCalls: SpawnCall[] = []
  const spawnedProcs: FakePiRpcProcess[] = []
  const events: string[] = []
  const originalSpawn = PiRpcProcess.spawn

  const agent = new PiAcpAgent(asAgentConn(conn)) as unknown as Record<string, unknown>
  agent.store = store
  agent.sessions = new SessionManager(store)

  const spawn = async (params: { cwd: string; sessionPath?: string; additionalDirectories?: string[] }) => {
    spawnCalls.push(params)
    events.push('spawn')
    const proc = new FakePiRpcProcess()
    spawnedProcs.push(proc)
    opts?.onSpawn?.(proc)
    proc.terminateOnDispose = true
    proc.state = {
      isStreaming: false,
      sessionId,
      sessionFile,
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'model' }
    }
    proc.dispose = (options?: { expected?: boolean }) => {
      events.push('dispose')
      FakePiRpcProcess.prototype.dispose.call(proc, options)
    }
    return proc
  }
  ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = spawn

  return {
    conn,
    agent: agent as unknown as PiAcpAgent,
    store,
    spawnCalls,
    spawnedProcs,
    events,
    restoreSpawn: () => {
      ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = originalSpawn
    }
  }
}

function seedSession(cwd: string, sessionId: string, sessionFile: string): string {
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', id: sessionId, cwd }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-10-16T00:00:00.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n',
    'utf-8'
  )
  return sessionFile
}

test('PiAcpAgent: session/new passes additional roots to the child and persists them', { skip: isWindows }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-ws-new-'))
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-ws-new-extra-'))
  const sessionFile = seedSession(cwd, 'ws-new-session', join(cwd, 'sessions', 'ws-new-session.jsonl'))
  const harness = makeAgent('ws-new-session', sessionFile)
  t.after(() => {
    harness.restoreSpawn()
    harness.agent.dispose()
  })

  const response = await harness.agent.newSession({ cwd, mcpServers: [], additionalDirectories: [extra] })
  assert.ok(response.sessionId)
  assert.deepEqual(
    harness.spawnCalls.map(call => call.additionalDirectories),
    [[extra]]
  )
  assert.deepEqual(harness.store.get('ws-new-session')?.additionalDirectories, [extra])
})

test('PiAcpAgent: session/load replaces additional roots, including clearing them', { skip: isWindows }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-ws-load-'))
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-ws-load-extra-'))
  const sessionFile = seedSession(cwd, 'ws-load-session', join(cwd, 'sessions', 'ws-load-session.jsonl'))
  const harness = makeAgent('ws-load-session', sessionFile)
  harness.store.upsert({ sessionId: 'ws-load-session', cwd, sessionFile, additionalDirectories: [extra] })
  t.after(() => {
    harness.restoreSpawn()
    harness.agent.dispose()
  })

  await harness.agent.loadSession({ sessionId: 'ws-load-session', cwd, mcpServers: [], additionalDirectories: [] })
  assert.deepEqual(
    harness.spawnCalls.map(call => call.additionalDirectories),
    [undefined],
    'cleared roots spawn no env'
  )
  assert.deepEqual(harness.store.get('ws-load-session')?.additionalDirectories, [])

  await harness.agent.loadSession({ sessionId: 'ws-load-session', cwd, mcpServers: [], additionalDirectories: [extra] })
  assert.deepEqual(
    harness.spawnCalls.map(call => call.additionalDirectories),
    [undefined, [extra]]
  )
  assert.deepEqual(harness.store.get('ws-load-session')?.additionalDirectories, [extra])
})

test(
  'PiAcpAgent: session/resume reuses a live child with the same roots and replaces it when they change',
  {
    skip: isWindows
  },
  async t => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-ws-resume-'))
    const first = mkdtempSync(join(tmpdir(), 'pi-acp-ws-resume-one-'))
    const second = mkdtempSync(join(tmpdir(), 'pi-acp-ws-resume-two-'))
    const sessionFile = seedSession(cwd, 'ws-resume-session', join(cwd, 'sessions', 'ws-resume-session.jsonl'))
    const harness = makeAgent('ws-resume-session', sessionFile)
    harness.store.upsert({ sessionId: 'ws-resume-session', cwd, sessionFile, additionalDirectories: [first] })
    t.after(() => {
      harness.restoreSpawn()
      harness.agent.dispose()
    })

    await harness.agent.resumeSession({
      sessionId: 'ws-resume-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [first]
    })
    assert.equal(harness.spawnCalls.length, 1, 'requested roots restore the live child')
    assert.deepEqual(harness.spawnCalls[0]!.additionalDirectories, [first])
    assert.deepEqual(harness.store.get('ws-resume-session')?.additionalDirectories, [first])

    await harness.agent.resumeSession({
      sessionId: 'ws-resume-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [first]
    })
    assert.equal(harness.spawnCalls.length, 1, 'unchanged roots reuse the live child')

    await harness.agent.resumeSession({
      sessionId: 'ws-resume-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [second]
    })
    assert.equal(harness.spawnCalls.length, 2, 'changed roots retire and replace the child')
    assert.deepEqual(harness.spawnCalls[1]!.additionalDirectories, [second])
    assert.deepEqual(harness.events, ['spawn', 'dispose', 'spawn'], 'the old child exits before its replacement spawns')
    assert.deepEqual(harness.store.get('ws-resume-session')?.additionalDirectories, [second])

    // Omitted roots are a full replacement: they clear the active roots.
    await harness.agent.resumeSession({ sessionId: 'ws-resume-session', cwd, mcpServers: [] })
    assert.equal(harness.spawnCalls.length, 3)
    assert.equal(harness.spawnCalls[2]!.additionalDirectories, undefined, 'omitted roots spawn no env')
    assert.deepEqual(harness.store.get('ws-resume-session')?.additionalDirectories, [])
  }
)

test('PiAcpAgent: session/list reports the complete ordered roots for stored and discovered sessions', async t => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-ws-list-agent-'))
  process.env.PI_CODING_AGENT_DIR = agentDir
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-ws-list-'))
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-ws-list-extra-'))
  const sessionsDir = join(agentDir, 'sessions')
  const mapped = seedSession(cwd, 'ws-list-mapped', join(sessionsDir, 'mapped.jsonl'))
  seedSession(cwd, 'ws-list-discovered', join(sessionsDir, 'discovered.jsonl'))
  const harness = makeAgent('ws-list-mapped', mapped)
  harness.store.upsert({ sessionId: 'ws-list-mapped', cwd, sessionFile: mapped, additionalDirectories: [extra] })
  t.after(() => {
    harness.restoreSpawn()
    harness.agent.dispose()
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  })

  const listed = await harness.agent.listSessions({ cwd })
  assert.deepEqual(
    listed.sessions.map(session => [session.sessionId, session.additionalDirectories]),
    [
      ['ws-list-discovered', []],
      ['ws-list-mapped', [extra]]
    ]
  )
})

test('PiAcpAgent: initialize advertises the additionalDirectories capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.additionalDirectories, {})
})

function seedRaceHarness(
  t: TestContext,
  roots: readonly string[],
  opts?: { onSpawn?: (proc: FakePiRpcProcess) => void }
) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-'))
  const sessionFile = seedSession(cwd, 'ws-race-session', join(cwd, 'sessions', 'ws-race-session.jsonl'))
  const harness = makeAgent('ws-race-session', sessionFile, opts)
  harness.store.upsert({
    sessionId: 'ws-race-session',
    cwd,
    sessionFile,
    additionalDirectories: [...roots]
  })
  t.after(() => {
    harness.restoreSpawn()
    harness.agent.dispose()
  })
  return { cwd, sessionFile, harness }
}

/**
 * Park the live child's shutdown so the changed-root resume sits deterministically
 * inside its awaited teardown window: the old child is already retired from the
 * manager, but the replacement has not started yet.
 */
function parkTeardown(harness: ReturnType<typeof makeAgent>) {
  const agentAny = harness.agent as unknown as Record<string, any>
  const live = (agentAny.sessions as SessionManager).get('ws-race-session')
  const originalShutdown = live.shutdown.bind(live)
  let release!: () => void
  let parked!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const parkedSignal = new Promise<void>(resolve => {
    parked = resolve
  })
  live.shutdown = () => {
    parked()
    return gate.then(() => originalShutdown())
  }
  return { release, parkedSignal }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test(
  'PiAcpAgent: a close admitted during a changed-root resume teardown is not overridden',
  { skip: isWindows },
  async t => {
    const { cwd, harness } = seedRaceHarness(t, [mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-one-'))])
    const second = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-two-'))
    await harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [...(harness.store.get('ws-race-session')!.additionalDirectories ?? [])]
    })
    assert.equal(harness.spawnCalls.length, 1)

    const { release, parkedSignal } = parkTeardown(harness)
    const resume = harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [second]
    })
    await parkedSignal

    const closing = harness.agent.closeSession({ sessionId: 'ws-race-session' })
    await tick()
    release()

    await assert.rejects(resume, /while restoring/)
    await closing
    assert.equal(harness.spawnCalls.length, 1, 'a fenced close leaves no replacement child')
    assert.equal((harness.agent as unknown as Record<string, any>).sessions.maybeGet('ws-race-session'), undefined)
  }
)

test(
  'PiAcpAgent: a delete admitted during a changed-root resume teardown is not overridden',
  { skip: isWindows },
  async t => {
    const { cwd, sessionFile, harness } = seedRaceHarness(t, [mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-one-'))])
    const second = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-two-'))
    await harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [...(harness.store.get('ws-race-session')!.additionalDirectories ?? [])]
    })
    assert.equal(harness.spawnCalls.length, 1)

    // Keep the delete transaction in flight (admission marker set, store and
    // session file untouched) so the racing replacement sees exactly the state
    // a real interleaving would: deletion decided, not yet executed.
    const agentAny = harness.agent as unknown as Record<string, any>
    const realRepository = agentAny.sessionRepository()
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>(resolve => {
      releaseDelete = resolve
    })
    agentAny.repository = {
      store: harness.store,
      find: (...args: unknown[]) => realRepository.find(...(args as Parameters<typeof realRepository.find>)),
      list: (...args: unknown[]) => realRepository.list(...(args as Parameters<typeof realRepository.list>[])),
      upsert: (entry: Parameters<typeof realRepository.upsert>[0]) => realRepository.upsert(entry),
      tombstone: (id: string) => realRepository.tombstone(id),
      stored: (id: string) => realRepository.stored(id),
      delete: async (id: string) => {
        await deleteGate
        return realRepository.delete(id)
      }
    }

    const { release, parkedSignal } = parkTeardown(harness)
    const resume = harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [second]
    })
    await parkedSignal

    const deleting = harness.agent.deleteSession({ sessionId: 'ws-race-session' })
    await tick()
    release()

    await assert.rejects(resume, /session is being deleted|while restoring/)
    releaseDelete()
    await deleting
    assert.equal(harness.spawnCalls.length, 1, 'a fenced delete leaves no replacement child')
    assert.equal(harness.store.get('ws-race-session'), null, 'the deletion tombstones the session')
    assert.equal(existsSync(sessionFile), false, 'the deletion unlinks the session file')
  }
)

test(
  'PiAcpAgent: a load admitted during a changed-root resume supersedes it and keeps its provisional child',
  { skip: isWindows },
  async t => {
    const first = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-one-'))
    const second = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-two-'))
    // Gate every spawned child's getEntries so the load parks deterministically
    // mid-replay; the last gated child is always the load's own restore.
    let releaseLoad!: () => void
    const loadGate = new Promise<void>(resolve => {
      releaseLoad = resolve
    })
    let loadParked!: () => void
    const loadParkedSignal = new Promise<void>(resolve => {
      loadParked = resolve
    })
    let loadChild: FakePiRpcProcess | undefined
    const { cwd, harness } = seedRaceHarness(t, [first], {
      onSpawn: proc => {
        proc.getEntries = async () => {
          loadChild = proc
          loadParked()
          await loadGate
          return proc.entrySnapshot
        }
      }
    })
    await harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [first]
    })
    assert.equal(harness.spawnCalls.length, 1)

    const { release, parkedSignal } = parkTeardown(harness)
    const resume = harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [second]
    })
    await parkedSignal

    const load = harness.agent.loadSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [first]
    })
    await tick()
    release()
    // Attach before awaiting the load: the resume's rejection must never spend a
    // turn unhandled while the load is still working.
    const resumeOutcome = assert.rejects(resume, /while restoring/)

    await loadParkedSignal
    assert.equal(loadChild!.disposed, false, 'the load provisional child is never destroyed mid-flight')
    releaseLoad()

    await resumeOutcome
    await load
    const finalChild = (harness.agent as unknown as Record<string, any>).sessions.maybeGet('ws-race-session')
    assert.ok(finalChild, 'the load owns the surviving session')
    assert.deepEqual(finalChild.additionalDirectories, [first], 'the load roots stay active')
  }
)

test('PiAcpAgent: invalid additional roots reject before any live-session teardown', { skip: isWindows }, async t => {
  const { cwd, harness } = seedRaceHarness(t, [mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-one-'))])
  await harness.agent.resumeSession({
    sessionId: 'ws-race-session',
    cwd,
    mcpServers: [],
    additionalDirectories: [...(harness.store.get('ws-race-session')!.additionalDirectories ?? [])]
  })
  assert.equal(harness.spawnCalls.length, 1)

  await assert.rejects(
    harness.agent.resumeSession({
      sessionId: 'ws-race-session',
      cwd,
      mcpServers: [],
      additionalDirectories: [join(cwd, 'missing-root')]
    }),
    (error: unknown) => {
      const requestError = error as { data?: { reason?: string } }
      assert.equal(requestError.data?.reason, 'ADDITIONAL_DIRECTORY_NOT_FOUND')
      return true
    }
  )
  assert.equal(harness.spawnCalls.length, 1)
  assert.deepEqual(harness.events, ['spawn'], 'the live child is neither disposed nor replaced')
  assert.ok(
    (harness.agent as unknown as Record<string, any>).sessions.maybeGet('ws-race-session'),
    'the live session survives invalid requested roots'
  )
})

test('PiAcpAgent: prompt auto-restore spawns with the stored additional roots', { skip: isWindows }, async t => {
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-ws-race-one-'))
  const { harness } = seedRaceHarness(t, [extra], {
    onSpawn: proc => {
      const original = proc.prompt.bind(proc)
      proc.prompt = async (...args: Parameters<typeof original>) => {
        const settled = original(...args)
        proc.emit({ type: 'agent_start' })
        proc.emit({ type: 'turn_end' })
        proc.emit({ type: 'agent_end' })
        proc.emit({ type: 'agent_settled' })
        return settled
      }
    }
  })

  const result = await harness.agent.prompt({
    sessionId: 'ws-race-session',
    prompt: [{ type: 'text', text: 'hello again' }]
  })
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(harness.spawnCalls.length, 1)
  assert.deepEqual(
    harness.spawnCalls[0]!.additionalDirectories,
    [extra],
    'the automatic restore passes the stored roots to the child'
  )
  assert.deepEqual(
    harness.store.get('ws-race-session')?.additionalDirectories,
    [extra],
    'the restore preserves the stored roots'
  )
})
