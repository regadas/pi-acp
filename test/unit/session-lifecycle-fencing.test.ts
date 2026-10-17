import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const isWindows = process.platform === 'win32'
const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * Agent wired to a real SessionManager/SessionStore, with PiRpcProcess.spawn
 * mocked so every child is a tracked FakePiRpcProcess owning the requested
 * session identity. The pi agent dir is isolated per test so repository
 * discovery never scans real user sessions.
 */
function makeHarness(
  t: TestContext,
  sessionId: string,
  sessionFile: string,
  opts?: { onSpawn?: (proc: FakePiRpcProcess) => void }
) {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-agent-'))

  const conn = new FakeAgentSideConnection()
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-map-')), 'session-map.json'))
  const sessions = new SessionManager(store)
  const spawned: FakePiRpcProcess[] = []
  const originalSpawn = PiRpcProcess.spawn

  const agent = new PiAcpAgent(asAgentConn(conn)) as unknown as Record<string, unknown>
  agent.store = store
  agent.sessions = sessions
  ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = async () => {
    const proc = new FakePiRpcProcess()
    spawned.push(proc)
    proc.terminateOnDispose = true
    proc.state = {
      isStreaming: false,
      sessionId,
      sessionFile,
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'model', reasoning: true }
    }
    opts?.onSpawn?.(proc)
    return proc
  }

  t.after(() => {
    ;(PiRpcProcess as unknown as { spawn: unknown }).spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    ;(agent as unknown as { dispose(): void }).dispose()
  })

  return { conn, agent: agent as unknown as PiAcpAgent, store, sessions, spawned }
}

function seedHarness(t: TestContext, name: string, opts?: { onSpawn?: (proc: FakePiRpcProcess) => void }) {
  const sessionId = `fence-${name}`
  const cwd = mkdtempSync(join(tmpdir(), `pi-acp-lifecycle-${name}-`))
  const sessionFile = join(cwd, 'sessions', `${sessionId}.jsonl`)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd })}\n`, 'utf-8')
  const harness = makeHarness(t, sessionId, sessionFile, opts)
  harness.store.upsert({ sessionId, cwd, sessionFile, additionalDirectories: [] })
  return { sessionId, cwd, ...harness }
}

const configUpdatesOf = (conn: FakeAgentSideConnection) =>
  conn.updates.filter(
    update => (update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'config_option_update'
  )

test(
  'PiAcpAgent: config writes queued behind an in-flight write never reopen a closing session',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, conn, agent, sessions, spawned } = seedHarness(t, 'close-queued')
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawned.length, 1)

    // Park the first write's config publication so the remaining writes sit
    // queued behind it when the close is admitted.
    let releasePublish!: () => void
    const publishGate = new Promise<void>(resolve => {
      releasePublish = resolve
    })
    let publishParked!: () => void
    const publishParkedSignal = new Promise<void>(resolve => {
      publishParked = resolve
    })
    let gated = false
    const deliver = conn.sessionUpdate.bind(conn)
    conn.sessionUpdate = async update => {
      if (
        !gated &&
        (update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'config_option_update'
      ) {
        gated = true
        publishParked()
        await publishGate
      }
      await deliver(update)
    }

    const writes = ['high', 'low', 'medium'].map(value =>
      agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value })
    )
    await publishParkedSignal

    const closing = agent.closeSession({ sessionId })
    await tick()
    releasePublish()
    await closing

    const results = await Promise.allSettled(writes)
    assert.equal(results[0]!.status, 'fulfilled', 'the in-flight write settles within the close')
    for (const result of results.slice(1)) {
      assert.equal(result?.status, 'rejected', 'a write queued before the close must not run after it')
      if (result?.status === 'rejected') {
        assert.match(String(result.reason?.message ?? ''), /session closed while configuring/)
      }
    }

    assert.equal(spawned.length, 1, 'no child is spawned for queued writes after the close')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )
    assert.equal(sessions.maybeGet(sessionId), undefined, 'no session is re-registered after the close')
    assert.equal(configUpdatesOf(conn).length, 1, 'only the in-flight write publishes; queued writes stay silent')
  }
)

test(
  'PiAcpAgent: a config write fenced by a close mid-restore fails closed without reopening',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    let releaseState!: () => void
    const stateGate = new Promise<void>(resolve => {
      releaseState = resolve
    })
    let stateParked!: () => void
    const stateParkedSignal = new Promise<void>(resolve => {
      stateParked = resolve
    })
    const { sessionId, conn, agent, sessions, spawned } = seedHarness(t, 'close-restore', {
      onSpawn: proc => {
        // Park the write's restore at its identity probe: the child exists
        // but is not registered yet when the close is admitted.
        const getState = proc.getState.bind(proc)
        let gated = false
        proc.getState = async () => {
          if (!gated) {
            gated = true
            stateParked()
            await stateGate
          }
          return getState()
        }
      }
    })

    const write = agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' })
    const writeOutcome = assert.rejects(write, /session closed while configuring/)
    await stateParkedSignal

    const closing = agent.closeSession({ sessionId })
    await tick()
    releaseState()
    await closing
    await writeOutcome

    assert.equal(spawned.length, 1, 'the fenced write never spawns a replacement child')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )
    assert.equal(sessions.maybeGet(sessionId), undefined, 'the fenced write re-registers nothing')
    assert.equal(configUpdatesOf(conn).length, 0, 'a fenced write publishes no config update')
  }
)

test(
  'PiAcpAgent: a config write admitted while a close is in flight fails closed at admission',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, conn, agent, sessions, spawned } = seedHarness(t, 'close-admission')
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })

    // Park the close inside the live session's teardown so the admission
    // marker is observably in flight when the config write arrives.
    const live = sessions.get(sessionId)
    const originalShutdown = live.shutdown.bind(live)
    let releaseShutdown!: () => void
    let shutdownParked!: () => void
    const shutdownGate = new Promise<void>(resolve => {
      releaseShutdown = resolve
    })
    const shutdownParkedSignal = new Promise<void>(resolve => {
      shutdownParked = resolve
    })
    live.shutdown = () => {
      shutdownParked()
      return shutdownGate.then(() => originalShutdown())
    }

    const closing = agent.closeSession({ sessionId })
    await shutdownParkedSignal

    const write = agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' })
    const writeOutcome = assert.rejects(write, /session closed while configuring/)
    releaseShutdown()
    await closing
    await writeOutcome

    assert.equal(spawned.length, 1, 'the write never queues a restore behind the in-flight close')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )
    assert.equal(sessions.maybeGet(sessionId), undefined, 'the rejected write re-registers nothing')
    assert.equal(configUpdatesOf(conn).length, 0, 'the rejected write publishes nothing')
  }
)

test(
  'PiAcpAgent: a config write admitted after a completed close still restores the session',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, conn, agent, sessions, spawned } = seedHarness(t, 'close-new-write')
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    await agent.closeSession({ sessionId })
    assert.equal(sessions.maybeGet(sessionId), undefined)

    const result = await agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' })
    const thought = result.configOptions.find(option => option.id === 'thought_level') as { currentValue?: string }
    assert.equal(thought.currentValue, 'high')
    assert.equal(spawned.length, 2, 'the post-close write restores a fresh child')
    assert.equal(configUpdatesOf(conn).length, 1)
  }
)

test(
  'PiAcpAgent: a config write gated on a load never re-opens the session during a close',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    // Gate the load's restore at its identity probe: the load is admitted and
    // tracked, but its child is not registered yet.
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeParked!: () => void
    const probeParkedSignal = new Promise<void>(resolve => {
      probeParked = resolve
    })
    let spawnIndex = 0
    const { sessionId, cwd, conn, agent, sessions, spawned } = seedHarness(t, 'close-gated-load', {
      onSpawn: proc => {
        const index = ++spawnIndex
        if (index !== 1) return
        const getState = proc.getState.bind(proc)
        let gated = false
        proc.getState = async () => {
          if (!gated) {
            gated = true
            probeParked()
            await probeGate
          }
          return getState()
        }
      }
    })

    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const loadOutcome = assert.rejects(load, /session closed while loading/)
    await probeParkedSignal

    // The write parks on the active load inside restoreSessionAwaitingLoads;
    // a close admitted during that wait must fence it before it restores.
    const write = agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' })
    const writeOutcome = assert.rejects(write, /session closed while configuring/)
    await tick()

    const closing = agent.closeSession({ sessionId })
    await tick()
    releaseProbe()

    await loadOutcome
    await writeOutcome
    await closing

    assert.equal(spawned.length, 1, 'no replacement child is ever spawned for the gated write')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )
    assert.equal(sessions.maybeGet(sessionId), undefined, 'no session is re-registered after the close')
    assert.equal(configUpdatesOf(conn).length, 0, 'the gated write publishes nothing')
  }
)

test(
  'PiAcpAgent: a wrong-cwd session/load rejects before touching the live session or its active prompt',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => {
      releasePrompt = resolve
    })
    let promptParked!: () => void
    const promptParkedSignal = new Promise<void>(resolve => {
      promptParked = resolve
    })
    const { sessionId, cwd, agent, sessions, spawned } = seedHarness(t, 'load-wrong-cwd', {
      onSpawn: proc => {
        const original = proc.prompt.bind(proc)
        proc.prompt = async (...args: Parameters<typeof original>) => {
          promptParked()
          await promptGate
          const settled = original(...args)
          proc.emit({ type: 'agent_start' })
          proc.emit({ type: 'turn_end' })
          proc.emit({ type: 'agent_end' })
          proc.emit({ type: 'agent_settled' })
          return settled
        }
      }
    })
    const wrongDir = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-wrong-'))
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawned.length, 1)

    const prompted = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await promptParkedSignal

    const load = agent.loadSession({ sessionId, cwd: wrongDir, mcpServers: [] })
    const loadOutcome = assert.rejects(load, /does not match/)
    await tick()
    releasePrompt()
    const promptResult = await prompted
    await loadOutcome

    assert.equal(promptResult.stopReason, 'end_turn', 'the active prompt is not cancelled by the rejected load')
    assert.equal(spawned.length, 1, 'the live child is neither replaced nor restored')
    assert.equal(spawned[0]!.disposed, false, 'the live child survives the rejected load')
    assert.ok(sessions.maybeGet(sessionId), 'the live session stays registered')
  }
)

test(
  'PiAcpAgent: a wrong-cwd session/load against a stored session rejects without restoring',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, agent, spawned } = seedHarness(t, 'load-stored-wrong-cwd')
    const wrongDir = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-wrong-'))
    await assert.rejects(agent.loadSession({ sessionId, cwd: wrongDir, mcpServers: [] }), /does not match/)
    assert.equal(spawned.length, 0, 'the rejected load spawns no child')
  }
)

test(
  'PiAcpAgent: a valid load against a stale stored cwd is admitted and repairs the mapping from the session header',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const sessionId = 'fence-load-stale-map'
    const staleDir = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-stale-'))
    const headerDir = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-header-'))
    const sessionFile = join(headerDir, 'sessions', `${sessionId}.jsonl`)
    mkdirSync(dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd: headerDir })}\n`, 'utf-8')
    const harness = makeHarness(t, sessionId, sessionFile)
    // The raw store mapping records a stale cwd; only the JSONL header is
    // authoritative for the session's real cwd.
    harness.store.upsert({ sessionId, cwd: staleDir, sessionFile, additionalDirectories: [] })

    await harness.agent.loadSession({ sessionId, cwd: headerDir, mcpServers: [] })

    assert.equal(harness.spawned.length, 1, 'the valid load restores the session')
    assert.equal(harness.store.get(sessionId)?.cwd, headerDir, 'the stale mapping is repaired from the header')
  }
)

test(
  'PiAcpAgent: a wrong-cwd load during an unmapped session discovery does not cancel the valid load',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const sessionId = 'fence-load-unmapped-race'
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-unmapped-'))
    let nativeFile = ''
    const harness = makeHarness(t, sessionId, 'unset', {
      onSpawn: proc => {
        proc.state = { ...proc.state, sessionFile: nativeFile }
      }
    })
    const wrongDir = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-wrong-'))

    // Native pi layout: the unmapped session file lives under the cwd-encoded
    // directory inside pi's agent dir, so repository discovery (not the
    // adapter mapping) is what establishes its authoritative cwd.
    const encoded = resolve(cwd)
      .replace(/^[/\\]+/, '')
      .replace(/[/\\:]/g, '-')
    const nativeDir = join(process.env.PI_CODING_AGENT_DIR!, 'sessions', `--${encoded}--`)
    mkdirSync(nativeDir, { recursive: true })
    nativeFile = join(nativeDir, `${sessionId}.jsonl`)
    writeFileSync(nativeFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd })}\n`, 'utf-8')

    // Park the first (valid) load inside repository discovery, before it can
    // write the mapping: a wrong-cwd load arriving in that window must be
    // rejected against the authoritative header instead of cancelling it.
    const agentAny = harness.agent as unknown as Record<string, any>
    const realRepository = agentAny.sessionRepository()
    let releaseFind!: () => void
    const findGate = new Promise<void>(resolve => {
      releaseFind = resolve
    })
    let findParked!: () => void
    const findParkedSignal = new Promise<void>(resolve => {
      findParked = resolve
    })
    let parked = false
    agentAny.repository = {
      store: harness.store,
      find: async (...args: unknown[]) => {
        if (!parked) {
          parked = true
          findParked()
          await findGate
        }
        return realRepository.find(...(args as Parameters<typeof realRepository.find>))
      },
      list: (...args: unknown[]) => realRepository.list(...(args as Parameters<typeof realRepository.list>[])),
      upsert: (entry: Parameters<typeof realRepository.upsert>[0]) => realRepository.upsert(entry),
      tombstone: (id: string) => realRepository.tombstone(id),
      stored: (id: string) => realRepository.stored(id),
      delete: async (id: string) => realRepository.delete(id)
    }

    const validLoad = harness.agent.loadSession({ sessionId, cwd, mcpServers: [] })
    await findParkedSignal
    const wrongLoad = harness.agent.loadSession({ sessionId, cwd: wrongDir, mcpServers: [] })
    const wrongOutcome = assert.rejects(wrongLoad, /does not match/)
    await tick()
    releaseFind()

    await validLoad
    await wrongOutcome
    assert.equal(harness.spawned.length, 1, 'only the valid load restores a child')
    assert.ok(harness.sessions.maybeGet(sessionId), 'the valid load keeps its session registered')
    assert.equal(harness.store.get(sessionId)?.cwd, cwd, 'the valid load establishes the mapping')
  }
)

/**
 * Park a chosen repository `find` call (by ordinal) and the first `delete`
 * call: a session/load's validation lookup or a session/delete's unlink then
 * blocks until the test releases it. Every restore performs its own `find`,
 * so which ordinal is a load's validation lookup is test-controlled.
 */
function parkedRepository(
  harness: { agent: PiAcpAgent; store: SessionStore },
  opts: { parkFindAt?: number[]; parkDelete?: boolean } = {}
) {
  const agentAny = harness.agent as unknown as Record<string, any>
  const real = agentAny.sessionRepository()
  const gate = () => {
    let release!: () => void
    let parked!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    const parkedSignal = new Promise<void>(resolve => {
      parked = resolve
    })
    return { promise, release, parkedSignal, parked }
  }
  const findGates = new Map<number, ReturnType<typeof gate>>()
  for (const ordinal of opts.parkFindAt ?? []) findGates.set(ordinal, gate())
  const deleteGate = gate()
  let findCalls = 0
  let deleteCalls = 0
  agentAny.repository = {
    store: harness.store,
    find: async (...args: unknown[]) => {
      findCalls += 1
      const gate = findGates.get(findCalls)
      if (gate) {
        gate.parked()
        await gate.promise
      }
      return real.find(...(args as Parameters<typeof real.find>))
    },
    list: (...args: unknown[]) => real.list(...(args as Parameters<typeof real.list>[])),
    upsert: (entry: Parameters<typeof real.upsert>[0]) => real.upsert(entry),
    tombstone: (id: string) => real.tombstone(id),
    stored: (id: string) => real.stored(id),
    delete: async (id: string) => {
      deleteCalls += 1
      if (opts.parkDelete && deleteCalls === 1) {
        deleteGate.parked()
        await deleteGate.promise
      }
      return real.delete(id)
    }
  }
  return {
    findParked: (ordinal: number) => findGates.get(ordinal)!.parkedSignal,
    releaseFind: (ordinal: number) => findGates.get(ordinal)!.release(),
    findCalls: () => findCalls,
    deleteParked: deleteGate.parkedSignal,
    releaseDelete: () => deleteGate.release()
  }
}

const wrongCwd = () => mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-wrong-'))

test(
  'PiAcpAgent: a resume parked on a load validation gate never spawns behind an acknowledged close',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned, store } = seedHarness(t, 'close-gated-resume')
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1] })

    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const loadOutcome = assert.rejects(load, /session closed while loading|superseded by a concurrent load or close/)
    await gates.findParked(1)

    // The resume is admitted while the load's validation is still parked, so
    // it waits on the validation gate before it is registered anywhere.
    const resume = agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    await tick()

    const close = agent.closeSession({ sessionId })
    gates.releaseFind(1)

    await Promise.all([resume, close])
    await loadOutcome

    assert.equal(
      spawned.length,
      1,
      'the resume may restore during the close wait (coalescing), but nothing may spawn afterwards'
    )
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the acknowledged close leaves no child alive'
    )
    assert.equal(sessions.maybeGet(sessionId), undefined, 'no session is registered behind the acknowledged close')
  }
)

test(
  'PiAcpAgent: a resume parked on a load validation gate fails closed during an in-progress delete',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned, store } = seedHarness(t, 'delete-gated-resume')
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1], parkDelete: true })

    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const loadOutcome = assert.rejects(load, /superseded by a concurrent load or close|session is being deleted/)
    await gates.findParked(1)

    const resume = agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    const resumeOutcome = assert.rejects(resume, /session is being deleted/)
    await tick()

    const deleting = agent.deleteSession({ sessionId })
    gates.releaseFind(1)
    await resumeOutcome

    gates.releaseDelete()
    assert.deepEqual(await deleting, {})
    await loadOutcome

    assert.equal(spawned.length, 0, 'no writer may cross the delete transaction retirement or unlink')
    assert.equal(sessions.maybeGet(sessionId), undefined, 'nothing is registered behind the delete')
  }
)

test(
  'PiAcpAgent: same-turn load validations serialize behind the current validation span',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, store } = seedHarness(t, 'serial-lookups')
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1] })

    const validLoad = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const wrongLoad = agent.loadSession({ sessionId, cwd: wrongCwd(), mcpServers: [] })
    await gates.findParked(1)
    await tick()

    // The second load's lookup must not start while the first validation
    // span is in flight: the gate tail is published synchronously (chained on
    // the previous span), so an arrival can never overwrite a pending tail
    // and start its lookup past it.
    assert.equal(gates.findCalls(), 1, 'the second validation lookup must wait for the first span to land')

    gates.releaseFind(1)
    await assert.rejects(wrongLoad, /does not match/)
    await validLoad
  }
)

test(
  'PiAcpAgent: an older valid load never supersedes a later resume; the later resume wins',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const extra = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-extra-root-'))
    const { sessionId, cwd, agent, sessions, spawned, store } = seedHarness(t, 'load-then-resume')
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1] })

    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    await gates.findParked(1)

    // The resume arrives after the load, so arrival ordering makes it the
    // newer request even though the older load admits while it waits.
    const resume = agent.resumeSession({ sessionId, cwd, mcpServers: [], additionalDirectories: [extra] })
    await tick()

    gates.releaseFind(1)
    await load
    const resumed = await resume

    assert.ok(Array.isArray(resumed.configOptions), 'the later resume wins over the older load')
    assert.equal(spawned.length >= 1, true)
    const live = sessions.maybeGet(sessionId)
    assert.ok(live, 'the resume keeps a session registered')
    assert.deepEqual(live!.additionalDirectories, [extra], "the resume's newer roots replace the older load's")
    const liveProc = live!.proc as unknown as FakePiRpcProcess
    assert.ok(
      spawned.every(proc => proc.disposed || proc === liveProc),
      'no orphaned child survives the ordering'
    )
    sessions.close(sessionId)
  }
)

test(
  'PiAcpAgent: two same-turn valid loads resolve later-wins, not first-wins',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned, store } = seedHarness(t, 'two-valid-loads')
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1, 2] })

    const first = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const second = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    await gates.findParked(1)

    // The earlier load validates and admits while the later one is parked on
    // the chained validation tail; only then does the later lookup start.
    gates.releaseFind(1)
    await gates.findParked(2)
    gates.releaseFind(2)

    const outcomes = await Promise.allSettled([first, second])
    assert.equal(outcomes[1]!.status, 'fulfilled', 'the later valid load wins')
    const superseded = outcomes[0]
    assert.equal(superseded?.status, 'rejected', 'the earlier load is superseded by the later admission')
    if (superseded?.status === 'rejected') {
      assert.match(String(superseded.reason?.message ?? ''), /closed while loading|superseded/)
    }

    const live = sessions.maybeGet(sessionId)
    assert.ok(live, 'the winning load keeps the session registered')
    const liveProc = live!.proc as unknown as FakePiRpcProcess
    assert.equal(liveProc, spawned[spawned.length - 1], 'the later load owns the session')
    assert.ok(
      spawned.every(proc => proc === liveProc || proc.disposed),
      'no child from the superseded load outlives the winner'
    )
    sessions.close(sessionId)
  }
)

test(
  'PiAcpAgent: a later valid load supersedes an earlier completed resume',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned } = seedHarness(t, 'resume-then-load')

    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawned.length, 1)

    const loaded = await agent.loadSession({ sessionId, cwd, mcpServers: [] })
    assert.ok(Array.isArray(loaded.configOptions))

    assert.equal(spawned.length, 2, "the later load replaces the resume's child")
    assert.equal(spawned[0]!.disposed, true)
    assert.equal(sessions.maybeGet(sessionId)?.proc, spawned[1], 'the later load wins the session')
    sessions.close(sessionId)
  }
)

test('PiAcpAgent: an invalid load never cancels prior valid work', { skip: isWindows, timeout: 10_000 }, async t => {
  const { sessionId, cwd, agent, sessions, spawned } = seedHarness(t, 'invalid-load-pin')

  await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
  const live = sessions.maybeGet(sessionId)
  assert.ok(live)

  await assert.rejects(agent.loadSession({ sessionId, cwd: wrongCwd(), mcpServers: [] }), /does not match/)

  assert.equal(sessions.maybeGet(sessionId), live, "the prior valid resume's session survives the invalid load")
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0]!.disposed, false, 'the prior valid work keeps its child alive')
  sessions.close(sessionId)
})

test(
  'PiAcpAgent: a resume arriving while a close is in flight is rejected and never spawns',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned } = seedHarness(t, 'close-late-resume')
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawned.length, 1)

    // Park the close inside the live session's teardown so its admission
    // marker is observably in flight when the new resume arrives.
    const live = sessions.get(sessionId)
    const originalShutdown = live.shutdown.bind(live)
    let releaseShutdown!: () => void
    let shutdownParked!: () => void
    const shutdownGate = new Promise<void>(resolve => {
      releaseShutdown = resolve
    })
    const shutdownParkedSignal = new Promise<void>(resolve => {
      shutdownParked = resolve
    })
    live.shutdown = () => {
      shutdownParked()
      return shutdownGate.then(() => originalShutdown())
    }

    const closing = agent.closeSession({ sessionId })
    await shutdownParkedSignal

    // A NEW resume arriving while the close marker is active must fail
    // closed at admission instead of racing the close's sweeps and spawning
    // a child behind the acknowledged close.
    await assert.rejects(agent.resumeSession({ sessionId, cwd, mcpServers: [] }), /session is being closed/)
    assert.equal(spawned.length, 1, 'the late resume never spawns a child behind the close')

    releaseShutdown()
    await closing
    assert.equal(sessions.maybeGet(sessionId), undefined, 'the close completes with nothing registered')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )
  }
)

test(
  'PiAcpAgent: a close disposes a resume parked on a live RPC instead of waiting behind it',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned } = seedHarness(t, 'close-live-resume-rpc', {
      onSpawn: proc => {
        // The resume's configuration probe parks on an RPC that only
        // disposal can reject, mirroring a real channel: the close must
        // dispose the registered child so that RPC — and the resume —
        // settles, instead of draining the resume first and deadlocking.
        proc.getAvailableModels = () => proc.pendingRequest(new Promise(() => {}))
      }
    })

    const resumeOutcome = assert.rejects(agent.resumeSession({ sessionId, cwd, mcpServers: [] }), /pi process closed/)
    // The resume registers its child and then parks on the gated RPC.
    const registered = Date.now() + 5_000
    while (!sessions.maybeGet(sessionId) && Date.now() < registered) await tick()
    assert.ok(sessions.maybeGet(sessionId), 'the resume registered its child and parked on the configuration RPC')

    // No gate is ever released: the close can only settle by disposing the
    // child so the parked RPC rejects.
    await agent.closeSession({ sessionId })
    assert.equal(spawned[0]!.disposeCount, 1, 'the close disposes the registered child promptly')
    await resumeOutcome
    assert.equal(sessions.maybeGet(sessionId), undefined, 'nothing stays registered behind the close')
  }
)

test(
  'PiAcpAgent: a load arriving while a close is in flight is rejected at admission and never restores',
  { skip: isWindows, timeout: 10_000 },
  async t => {
    const { sessionId, cwd, agent, sessions, spawned, store } = seedHarness(t, 'close-late-load')
    await agent.resumeSession({ sessionId, cwd, mcpServers: [] })
    assert.equal(spawned.length, 1)

    // Park the close inside the live session's teardown: the manager has
    // already deregistered the session by then, so a new load arriving while
    // the closing marker is active takes the validation path.
    const live = sessions.get(sessionId)
    const originalShutdown = live.shutdown.bind(live)
    let releaseShutdown!: () => void
    let shutdownParked!: () => void
    const shutdownGate = new Promise<void>(resolve => {
      releaseShutdown = resolve
    })
    const shutdownParkedSignal = new Promise<void>(resolve => {
      shutdownParked = resolve
    })
    live.shutdown = () => {
      shutdownParked()
      return shutdownGate.then(() => originalShutdown())
    }
    const closing = agent.closeSession({ sessionId })
    await shutdownParkedSignal

    // The load's validation lookup is gated so the close can acknowledge
    // while it would otherwise sit in validation (the reproduction's schedule).
    const gates = parkedRepository({ agent, store }, { parkFindAt: [1] })
    const load = agent.loadSession({ sessionId, cwd, mcpServers: [] })
    const outcome = load.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, message: String((error as Error)?.message ?? '') })
    )
    // The close acknowledges with nothing registered and no active load
    // tracked (the load is still validating in the unfenced schedule).
    releaseShutdown()
    await closing
    assert.equal(sessions.maybeGet(sessionId), undefined, 'the close completes with nothing registered')

    // Release the lookup gate before asserting: in the unfenced schedule the
    // parked validation continues and settles so the failure is observed
    // instead of hanging on a gate that must never park once fenced.
    gates.releaseFind(1)
    const result = await outcome
    assert.equal(result.status, 'rejected', 'the load must fail closed at admission, not restore after the ack')
    if (result.status === 'rejected') {
      assert.match(result.message, /session is being closed/)
    }
    assert.equal(gates.findCalls(), 0, 'the admission rejection precedes the validation lookup entirely')
    assert.equal(spawned.length, 1, 'no child is spawned behind the acknowledged close')
    assert.ok(
      spawned.every(proc => proc.disposed),
      'the close leaves no child alive'
    )

    // Admission reopens once the marker cleared: a legitimate load after the
    // completed close restores the session normally.
    const reopened = await agent.loadSession({ sessionId, cwd, mcpServers: [] })
    assert.ok(Array.isArray(reopened.configOptions), 'a load after the completed close still restores')
    assert.equal(spawned.length, 2, 'the legitimate post-close load spawns its fresh child')
    assert.equal(sessions.maybeGet(sessionId)?.proc, spawned[1], 'the post-close load owns the session')
    sessions.close(sessionId)
  }
)
