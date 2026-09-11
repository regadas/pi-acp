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
    update: { sessionUpdate: 'config_option_update', configOptions: highOptions }
  })
  session.seedSessionConfiguration(highOptions)
  await session.endConfigurationMutation()

  const afterMutation = configUpdates(conn)
  assert.deepEqual(
    afterMutation.map(update => update.sessionUpdate),
    ['config_option_update']
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

test('PiAcpAgent: a thought-level mutation publishes exactly one config update despite pi echoes', async () => {
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

  await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' })
  await tick()
  await tick()

  assert.deepEqual(proc.thinkingLevels, ['high'])

  const published = configUpdates(conn)
  assert.deepEqual(
    published.map(update => update.sessionUpdate),
    ['config_option_update'],
    'the pi echo must not duplicate the mutation\u2019s own publication'
  )

  const options = published[0]?.sessionUpdate === 'config_option_update' ? published[0].configOptions : []
  assert.deepEqual(
    options.map(option => [option.id, option.currentValue]),
    [
      ['model', 'test/alpha'],
      ['thought_level', 'high']
    ],
    'config_option_update carries the complete current option list'
  )
})

test('PiAcpAgent: a blocked update queue cannot deliver a stale configuration after a mutation published the new one', async () => {
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
      update.sessionUpdate === 'config_option_update'
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

  const mutation = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' })
  await tick()
  await tick()
  assert.equal(wire.length, 0, 'nothing may reach the client while the queue is blocked')

  releaseQueue()
  await mutation
  await tick()
  await tick()

  assert.deepEqual(proc.thinkingLevels, ['high'])
  // The pre-fix repro delivered config:high before the stale config:medium.
  assert.deepEqual([...wire], ['config:medium', 'config:high'])
  assert.equal(wire.at(-1), 'config:high', 'the last configuration on the wire must be the mutation\u2019s value')
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
      update.sessionUpdate === 'config_option_update'
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
  const mutation = agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' })
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
  const configs = wire.filter(entry => entry.startsWith('config:'))
  // Pre-fix the queued sync adopted the mutation's epoch and appended
  // config:medium after the mutation's own publication.
  assert.deepEqual(configs, ['config:high'], 'no stale config option list may reach the wire')
  assert.deepEqual(wire, configs, 'no update other than the mutation\u2019s config publication may be delivered')
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
    configUpdates(conn).map(update =>
      update.sessionUpdate === 'config_option_update'
        ? update.configOptions.find(option => option.id === 'thought_level')?.currentValue
        : update.sessionUpdate
    ),
    ['medium', 'high']
  )
})

for (const boundary of ['handled', 'agent-settled', 'failed-agent-settled', 'compact', 'failed-compact']) {
  for (const change of ['same-thinking', 'unchanged', 'thinking-event']) {
    test(`PiAcpSession: ${boundary} reconciles ${change} before releasing the FIFO`, async () => {
      const conn = new FakeAgentSideConnection()
      const proc = new FakePiRpcProcess()
      const model = (id: string) => ({ provider: 'test', id, reasoning: true })
      proc.state = { isStreaming: false, thinkingLevel: 'medium', model: model('A') }
      proc.getAvailableModels = async () => ({ models: [model('A'), model('B')] })
      proc.availableThinkingLevels = ['off', 'medium', 'high']
      const session = makeSession(conn, proc)
      const agent = new PiAcpAgent(asAgentConn(conn))
      ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions(session)
      await session.syncSessionConfiguration()
      const switchModel = () => {
        if (change !== 'unchanged') proc.state = { ...proc.state, model: model('B') }
        if (change === 'thinking-event') {
          proc.state = { ...proc.state, thinkingLevel: 'high' }
          proc.emit({ type: 'thinking_level_changed', level: 'high' })
        }
      }
      const options = () =>
        configUpdates(conn).flatMap(update =>
          update.sessionUpdate === 'config_option_update' ? [update.configOptions] : []
        )
      const expectedModel = change === 'unchanged' ? 'test/A' : 'test/B'
      const compactStarted = deferred()
      const compactRelease = deferred()
      let first: Promise<unknown>
      if (boundary.includes('compact')) {
        Object.assign(proc, {
          compact: async () => {
            compactStarted.resolve()
            await compactRelease.promise
            switchModel() // pi awaits session_before_compact/session_compact extension hooks.
            if (boundary === 'failed-compact') throw new Error('compaction failed')
            return { summary: 'compacted' }
          }
        })
        first = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] })
      } else {
        proc.beforePromptAccepted = switchModel
        first = session.prompt('/switch')
        if (boundary !== 'handled') {
          proc.emit({ type: 'agent_start' })
          if (boundary === 'failed-agent-settled')
            proc.emit({
              type: 'message_update',
              assistantMessageEvent: { type: 'error', error: { errorMessage: 'run failed' } }
            })
          proc.emit({ type: 'agent_settled' })
        }
      }
      const firstResult = first.then(
        () => 'success',
        () => 'failed'
      )
      if (boundary.includes('compact')) await compactStarted.promise
      const later = session.runCommand(async () => {
        assert.equal(
          options()
            .at(-1)
            ?.find(option => option.id === 'model')?.currentValue,
          expectedModel
        )
        return 'next'
      })
      const laterResult = later.then(
        value => ({ value }),
        error => ({ error })
      )
      compactRelease.resolve()
      assert.equal(await firstResult, boundary.startsWith('failed-') ? 'failed' : 'success')
      if (boundary === 'failed-agent-settled') assert.ok('error' in (await laterResult))
      else assert.deepEqual(await laterResult, { value: 'next' })
      assert.equal(
        options()
          .at(-1)
          ?.find(option => option.id === 'model')?.currentValue,
        expectedModel
      )
      assert.equal(
        options().length,
        change === 'unchanged' ? 1 : 2,
        'unchanged fingerprint and thinking echoes must dedupe'
      )
      session.dispose()
    })
  }
}

test('PiAcpSession: completion config probe is best-effort and does not strand later work', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false }
  proc.getAvailableModels = async () => {
    throw new Error('metadata unavailable')
  }
  const session = makeSession(conn, proc)
  const prompt = session.prompt('handled')
  const command = session.runCommand(async () => 'next')
  assert.equal(await prompt, 'end_turn')
  assert.equal(await command, 'next')
  session.dispose()
})

test('PiAcpSession: a cancelled undispatched prompt does not probe autonomous configuration', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let probes = 0
  proc.getState = async () => {
    probes++
    return proc.state
  }
  const session = makeSession(conn, proc)
  proc.emit({ type: 'agent_start' })
  const prompt = session.prompt('held')
  await session.cancel()
  assert.equal(await prompt, 'cancelled')
  assert.equal(probes, 0)
  assert.equal(proc.prompts.length, 0)
  session.dispose()
})

test('PiAcpSession: cancellation during a pending command completion RPC quarantines and suppresses config/result', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  const gate = deferred()
  let probed = false
  proc.getState = async () => {
    probed = true
    return proc.pendingRequest(gate.promise.then(() => proc.state))
  }
  const command = session.runCommand(async () => 'late success')
  await tick()
  assert.equal(probed, true)
  assert.equal(proc.hasPendingRequests(), true)
  await session.cancel()
  assert.equal(session.isUnavailable(), true, 'a real outstanding RPC triggers existing quarantine policy')
  gate.resolve()
  assert.equal(await command, null)
  assert.equal(configUpdates(conn).length, 0)
  session.dispose()
})

test('PiAcpSession: owned cancelled settlement publishes the effective model before usage and the next dispatch', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const model = (id: string) => ({ provider: 'test', id, reasoning: true })
  proc.state = { isStreaming: true, thinkingLevel: 'medium', model: model('A') }
  proc.getAvailableModels = async () => ({ models: [model('A'), model('B')] })
  proc.availableThinkingLevels = ['off', 'medium']
  const session = makeSession(conn, proc)
  await session.syncSessionConfiguration()
  const selector = () =>
    configUpdates(conn).flatMap(update =>
      update.sessionUpdate === 'config_option_update'
        ? [update.configOptions.find(option => option.id === 'model')?.currentValue]
        : []
    )
  const order: string[] = []
  const first = session.prompt('active', [], async () => {
    order.push(`usage:${selector().at(-1)}`)
  })
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  assert.equal(proc.abortCount, 1)
  assert.equal(session.isUnavailable(), false, 'owned cancellation must leave the child reusable')

  // Pi awaits settlement hooks, including same-thinking model switches, before this event.
  proc.state = { ...proc.state, isStreaming: false, model: model('B') }
  proc.beforePromptAccepted = message => {
    order.push(`dispatch:${message}:${selector().at(-1)}`)
  }
  const next = session.prompt('next')
  proc.emit({ type: 'agent_settled' })
  assert.deepEqual(await Promise.all([first, next]), ['cancelled', 'end_turn'])
  assert.deepEqual(order, ['usage:test/B', 'dispatch:next:test/B'])
  assert.deepEqual(selector(), ['test/A', 'test/B'], 'the next completion must dedupe the effective model')
  session.dispose()
})

for (const completion of ['shutdown', 'abort-failure', 'preflight-cancel']) {
  test(`PiAcpSession: ${completion} completion does not start a configuration probe`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)
    let probes = 0
    proc.getAvailableModels = async () => {
      probes++
      return { models: [] }
    }
    const acceptance = deferred()
    if (completion === 'preflight-cancel') {
      proc.prompt = async () => {
        await acceptance.promise
      }
    }
    const prompt = session.prompt('active')
    if (completion !== 'preflight-cancel') proc.emit({ type: 'agent_start' })
    if (completion === 'abort-failure')
      proc.abort = async () => {
        throw new Error('abort failed')
      }
    if (completion === 'shutdown') await session.shutdown()
    else await session.cancel()
    acceptance.resolve()
    assert.equal(await prompt, 'cancelled')
    assert.equal(probes, 0)
    assert.equal(configUpdates(conn).length, 0)
    session.dispose()
  })
}

for (const boundary of ['prompt', 'failed-prompt', 'compact']) {
  for (const cancelAt of ['probe', 'queued-publication', ...(boundary === 'compact' ? ['completed-output'] : [])]) {
    test(
      `PiAcpSession: ${boundary} cancellation at ${cancelAt} preserves reusable configuration`,
      { timeout: 2000 },
      async () => {
        const conn = new FakeAgentSideConnection()
        const proc = new FakePiRpcProcess()
        const model = (id: string) => ({ provider: 'test', id, reasoning: true })
        proc.state = { isStreaming: true, thinkingLevel: 'medium', model: model('A') }
        proc.getAvailableModels = async () => ({ models: [model('A'), model('B')] })
        proc.availableThinkingLevels = ['off', 'medium']
        const session = makeSession(conn, proc)
        const agent = new PiAcpAgent(asAgentConn(conn))
        ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions(session)
        await session.syncSessionConfiguration()
        const selector = () =>
          configUpdates(conn).flatMap(update =>
            update.sessionUpdate === 'config_option_update'
              ? [update.configOptions.find(option => option.id === 'model')?.currentValue]
              : []
          )
        const reached = deferred()
        const release = deferred()
        let gated = false
        let probes = 0
        const deliver = conn.sessionUpdate.bind(conn)
        conn.sessionUpdate = async notification => {
          const update = notification.update
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            (update.content.text === 'delivery barrier' ||
              (cancelAt === 'completed-output' && update.content.text.startsWith('Compaction completed.')))
          ) {
            reached.resolve()
            await release.promise
          }
          await deliver(notification)
        }
        proc.getState = async () => {
          probes++
          if (!gated) {
            gated = true
            if (cancelAt === 'probe') {
              const response = proc.pendingRequest(release.promise.then(() => proc.state))
              reached.resolve()
              return response
            }
            if (cancelAt === 'queued-publication') {
              void session.sendSessionUpdate({
                sessionId: 's1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'delivery barrier' }
                }
              })
            }
          }
          return proc.pendingRequest(Promise.resolve(proc.state))
        }
        const switchModel = () => {
          proc.state = { ...proc.state, isStreaming: false, model: model('B') }
        }
        let work: Promise<string>
        if (boundary === 'compact') {
          Object.assign(proc, {
            compact: () =>
              proc.pendingRequest(
                Promise.resolve().then(() => {
                  switchModel() // Awaited session_compact hook precedes the completed RPC response.
                  return { summary: 'done' }
                })
              ),
            getSessionStats: async () => ({ sessionId: 's1', totalMessages: 2 })
          })
          work = agent
            .prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] })
            .then(result => result.stopReason)
        } else {
          work = session.prompt('active')
          proc.emit({ type: 'agent_start' })
          if (boundary === 'failed-prompt')
            proc.emit({
              type: 'message_update',
              assistantMessageEvent: {
                type: 'error',
                error: { errorMessage: 'run failed' }
              }
            })
          switchModel()
          proc.emit({ type: 'agent_settled' })
        }
        // Attach a handler immediately: failed-turn regression must not create an unhandled rejection.
        const outcome = work.then(
          value => ({ value }),
          error => ({ error })
        )
        try {
          await reached.promise
          if (cancelAt === 'queued-publication') await tick() // All answered RPC microtasks enqueue behind the barrier.
          assert.equal(proc.hasPendingRequests(), cancelAt === 'probe')
          if (cancelAt === 'completed-output')
            assert.equal(probes, 0, 'compact RPC has completed before reconciliation starts')
          assert.deepEqual(selector(), ['test/A'])
          const cancelling = session.cancel()
          const quarantined = boundary === 'compact' && cancelAt === 'probe'
          assert.equal(session.isUnavailable(), quarantined)
          assert.equal(proc.abortCount, 0, 'completion cancellation must not abort an unrelated run')
          release.resolve()
          await cancelling
          assert.deepEqual(await outcome, { value: boundary === 'prompt' ? 'end_turn' : 'cancelled' })
          if (quarantined) {
            assert.deepEqual(selector(), ['test/A'], 'quarantined RPC results never publish')
            assert.equal(await session.prompt('not sent'), 'cancelled')
          } else {
            let selectorAtDispatch: unknown
            proc.beforePromptAccepted = () => {
              selectorAtDispatch = selector().at(-1)
            }
            assert.equal(await session.prompt('next'), 'end_turn')
            assert.equal(selectorAtDispatch, 'test/B', 'persistent model must precede the next fresh dispatch')
            assert.deepEqual(selector(), ['test/A', 'test/B'], 'later completion dedupes')
            assert.equal(session.isUnavailable(), false)
          }
        } finally {
          release.resolve()
          session.dispose()
          await outcome
        }
      }
    )
  }
}
