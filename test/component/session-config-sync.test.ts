import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-config-sync-cwd-'))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

class FakeSessions {
  constructor(private readonly session: PiAcpSession) {}

  maybeGet(sessionId: string): PiAcpSession | undefined {
    return sessionId === this.session.sessionId ? this.session : undefined
  }

  get(sessionId: string): PiAcpSession {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

function configUpdates(conn: FakeAgentSideConnection) {
  return conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'current_mode_update' || update.sessionUpdate === 'config_option_update')
}

test('PiAcpSession: a configuration probe in flight during an ACP mutation cannot publish stale state', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  let releaseProbe!: () => void
  const probeGate = new Promise<void>(resolve => {
    releaseProbe = resolve
  })
  let probeStarted = false
  proc.getState = async () => {
    probeStarted = true
    await probeGate
    return proc.state
  }

  const session = makeSession(conn, proc)

  // Pi echo starts a probe that reads the pre-mutation thinking level.
  proc.emit({ type: 'thinking_level_changed', level: 'medium' })
  await tick()
  assert.equal(probeStarted, true, 'the echo probe must be in flight before the mutation runs')

  const highOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: 'thought_level',
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: 'high',
      options: [
        { value: 'medium', name: 'Thinking: medium', description: null },
        { value: 'high', name: 'Thinking: high', description: null }
      ]
    }
  ]

  // An ACP mutation applies and publishes `high` while the probe is blocked.
  session.beginConfigurationMutation()
  proc.state = { ...proc.state, thinkingLevel: 'high' }
  await session.sendSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'high' }
  })
  await session.sendSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'config_option_update', configOptions: highOptions }
  })
  session.seedSessionConfiguration(highOptions, 'high')
  await session.endConfigurationMutation()

  const afterMutation = configUpdates(conn)
  assert.deepEqual(
    afterMutation.map(update => update.sessionUpdate),
    ['current_mode_update', 'config_option_update']
  )

  releaseProbe()
  await tick()
  await tick()

  assert.deepEqual(
    configUpdates(conn),
    afterMutation,
    'the stale probe must not publish the pre-mutation configuration'
  )

  // The mutation's seeded state also survived: a matching echo still dedupes.
  proc.getState = async () => proc.state
  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  await tick()
  await tick()
  assert.deepEqual(configUpdates(conn), afterMutation, 'stale state must not have been reseeded')
})

test('PiAcpAgent: setSessionMode publishes exactly one mode and one config update despite pi echoes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'off',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }
  // Pi echoes its own state change while the ACP mutation is still running.
  proc.afterThinkingLevelSet = level => proc.emit({ type: 'thinking_level_changed', level })

  const session = makeSession(conn, proc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions(session)

  await agent.setSessionMode({ sessionId: 's1', modeId: 'high' })
  await tick()
  await tick()

  assert.deepEqual(proc.thinkingLevels, ['high'])

  const published = configUpdates(conn)
  assert.deepEqual(
    published.map(update => update.sessionUpdate),
    ['current_mode_update', 'config_option_update'],
    'the pi echo must not duplicate the mutation\u2019s own publications'
  )
  assert.equal(published[0]?.sessionUpdate === 'current_mode_update' && published[0].currentModeId, 'high')

  const options = published[1]?.sessionUpdate === 'config_option_update' ? published[1].configOptions : []
  assert.deepEqual(
    options.map(option => [option.id, option.currentValue]),
    [
      ['model', 'test/alpha'],
      ['thought_level', 'high']
    ],
    'config_option_update carries the complete current option list'
  )
})

test('PiAcpAgent: a blocked update queue cannot deliver a stale mode after a mutation published the new one', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  // Hold the first delivery so the out-of-band sync's update is queued but
  // undelivered while the mutation runs. Anything published outside the
  // session's queue would overtake it and leave the stale value last.
  let releaseQueue!: () => void
  const queueGate = new Promise<void>(resolve => {
    releaseQueue = resolve
  })
  const wire: string[] = []
  let deliveries = 0
  const deliver = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    deliveries += 1
    if (deliveries === 1) await queueGate
    const update = notification.update
    wire.push(
      update.sessionUpdate === 'current_mode_update'
        ? `mode:${update.currentModeId}`
        : update.sessionUpdate === 'config_option_update'
          ? `config:${update.configOptions.find(option => option.id === 'thought_level')?.currentValue}`
          : update.sessionUpdate
    )
    await deliver(notification)
  }

  const session = makeSession(conn, proc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions(session)

  // Out-of-band pi event: its probe reads `medium` and enqueues that update.
  proc.emit({ type: 'thinking_level_changed', level: 'medium' })
  await tick()
  assert.equal(deliveries, 1, 'the stale sync update must be queued and blocked before the mutation runs')

  const mutation = agent.setSessionMode({ sessionId: 's1', modeId: 'high' })
  await tick()
  await tick()
  assert.equal(wire.length, 0, 'nothing may reach the client while the queue is blocked')

  releaseQueue()
  await mutation
  await tick()
  await tick()

  assert.deepEqual(proc.thinkingLevels, ['high'])
  // The pre-fix repro delivered mode:high -> config:high -> mode:medium.
  assert.deepEqual([...wire], ['mode:medium', 'mode:high', 'config:high'])
  const lastMode = wire.filter(entry => entry.startsWith('mode:')).at(-1)
  assert.equal(lastMode, 'mode:high', 'the last mode on the wire must be the mutation\u2019s value')
  assert.ok(
    wire.lastIndexOf('mode:high') > wire.lastIndexOf('mode:medium'),
    'a stale mode may never be delivered after the mutation published the new one'
  )
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

test('PiAcpAgent: a sync queued before a mutation is discarded even when its callback starts after it', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  const blockerProbe = deferred()
  const stalePr = deferred()
  const write = deferred()
  const delivery = deferred()

  // Model pi's RPC honestly: the answer reflects the state at call time, so a
  // probe issued before the write reports the pre-write level however late it
  // resolves. Only pre-write ("medium") probes are gated, so the mutation's own
  // verification round trips are never held.
  let gateNextStaleProbe: Promise<void> | null = null
  proc.getState = async () => {
    const snapshot = { ...proc.state }
    if (gateNextStaleProbe && snapshot.thinkingLevel === 'medium') {
      const gate = gateNextStaleProbe
      gateNextStaleProbe = null
      await gate
    }
    return snapshot
  }
  proc.setThinkingLevel = async (level: string) => {
    await write.promise
    proc.thinkingLevels.push(level)
    proc.state = { ...proc.state, thinkingLevel: level }
  }

  const wire: string[] = []
  let deliveries = 0
  const deliver = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async notification => {
    deliveries += 1
    if (deliveries === 1) await delivery.promise
    const update = notification.update
    wire.push(
      update.sessionUpdate === 'current_mode_update'
        ? `mode:${update.currentModeId}`
        : update.sessionUpdate === 'config_option_update'
          ? `config:${update.configOptions.find(option => option.id === 'thought_level')?.currentValue}`
          : update.sessionUpdate
    )
    await deliver(notification)
  }

  const session = makeSession(conn, proc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions(session)

  // 1. Block configurationSyncTail with an in-flight sync (what the
  //    `thinking_level_changed` handler invokes).
  gateNextStaleProbe = blockerProbe.promise
  const blockerSync = session.syncSessionConfiguration(undefined, 'medium')
  await tick()

  // 2. Queue the stale event sync behind it, still before any mutation.
  const staleSync = session.syncSessionConfiguration(undefined, 'medium')
  await tick()

  // 3. Start the mutation and park it mid-write, so the queued sync's callback
  //    starts after beginConfigurationMutation bumped the epoch.
  const mutation = agent.setSessionMode({ sessionId: 's1', modeId: 'high' })
  await tick()
  assert.equal(deliveries, 0, 'the mutation must still be applying its write')

  // 4. Release the tail: the queued sync now starts mid-mutation and reads
  //    pre-write state.
  gateNextStaleProbe = stalePr.promise
  blockerProbe.resolve()
  await blockerSync
  await tick()

  // 5. Let the write land and the mutation publish; its first update is held
  //    on the wire, so it has not seeded yet.
  write.resolve()
  await tick()
  await tick()

  // 6. Release the stale probe while the mutation is parked before its seed.
  stalePr.resolve()
  await tick()
  await tick()

  // 7. Drain everything.
  delivery.resolve()
  await mutation
  await staleSync
  await tick()
  await tick()
  await tick()

  assert.deepEqual(proc.thinkingLevels, ['high'])
  const modes = wire.filter(entry => entry.startsWith('mode:'))
  const configs = wire.filter(entry => entry.startsWith('config:'))
  // Pre-fix the queued sync adopted the mutation's epoch and appended
  // mode:medium/config:medium after the mutation's own publications.
  assert.deepEqual(modes, ['mode:high'], 'no stale mode may reach the wire')
  assert.deepEqual(configs, ['config:high'], 'no stale config option list may reach the wire')
})

test('PiAcpSession: a sync invoked while another is publishing still reports newer pi state', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = {
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha', reasoning: true }
  }

  const firstProbe = deferred()
  let gateNextProbe: Promise<void> | null = firstProbe.promise
  proc.getState = async () => {
    const snapshot = { ...proc.state }
    if (gateNextProbe) {
      const gate = gateNextProbe
      gateNextProbe = null
      await gate
    }
    return snapshot
  }

  const session = makeSession(conn, proc)

  // The first sync reads `medium` and will publish it.
  const first = session.syncSessionConfiguration(undefined, 'medium')
  await tick()
  // A later pi event queues a second sync before the first one published.
  const second = session.syncSessionConfiguration(undefined, 'high')
  proc.state = { ...proc.state, thinkingLevel: 'high' }

  firstProbe.resolve()
  await first
  await second
  await tick()

  // Publishing from a sync is not an ACP mutation, so it must not discard the
  // queued sync that reports the newer level.
  assert.deepEqual(
    configUpdates(conn)
      .filter(update => update.sessionUpdate === 'current_mode_update')
      .map(update => update.currentModeId),
    ['medium', 'high']
  )
})
