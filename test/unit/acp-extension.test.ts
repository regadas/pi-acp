import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import acpExtension from '../../src/pi-rpc/acp-extension.js'

const key = Symbol.for('@agegr/pi-web/session-liveness/v1')
const globals = globalThis as Record<symbol, any>

function harness() {
  const hooks = new Map<string, (event: any, ctx: any) => void>()
  const events = new EventEmitter()
  let command!: (args: string, ctx: any) => Promise<void>
  const tools = new Map<string, any>()
  const updates: any[] = []
  const ctx = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/session' },
    ui: { setWidget: (_key: string, lines: string[]) => updates.push(JSON.parse(lines[0]!)) }
  }
  acpExtension({
    events: {
      on: (name, handler) => {
        events.on(name, handler)
        return () => {
          events.off(name, handler)
        }
      },
      emit: (name, data) => {
        events.emit(name, data)
      }
    },
    on: (name, handler) => {
      hooks.set(name, handler)
    },
    registerCommand: (_name, value) => {
      command = value.handler
    },
    registerTool: tool => {
      tools.set(tool.name, tool)
    }
  })
  return {
    ctx,
    updates,
    events,
    command: (args: string) => command(/^(cancel|check) /.test(args) ? `${args} ${Date.now() + 9_000}` : args, ctx),
    // Simulated native-idle driver; real Pi abort ordering is checked separately.
    async cancel(token: string) {
      const deadline = Date.now() + 9_000
      for (;;) {
        if (Date.now() >= deadline) throw new Error('termination could not be confirmed')
        await command(`cancel ${token} ${deadline}`, ctx)
        await command(`check ${token} ${deadline}`, ctx)
        if (updates.at(-1)?.state === 'cancelled') return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    },
    emit: (name: string, event: any = {}): any => hooks.get(name)?.(event, ctx),
    tool: (name: string, params: unknown) => tools.get(name)!.execute('call', params, undefined, undefined, ctx),
    tools,
    register: (value: any) => globals[key].register(value)
  }
}
const owner = '11111111-1111-4111-8111-111111111111'

test('before_agent_start supplements the rendered prompt once without dropping resources', t => {
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const rendered = 'Base prompt\n\nGLOBAL_APPEND_SENTINEL\n\nProject context'
  const result = h.emit('before_agent_start', { prompt: 'question', systemPrompt: rendered })
  assert.ok(result.systemPrompt.startsWith(rendered), 'rendered resources and earlier hook changes are preserved')
  assert.ok(result.systemPrompt.includes('acp_detach'))
  const again = h.emit('before_agent_start', { prompt: 'question', systemPrompt: result.systemPrompt })
  assert.equal(again?.systemPrompt, undefined, 'an already supplemented prompt is not appended again')
  assert.equal(h.tools.get('acp_detach')?.parameters.required[0], 'runIds')
})

for (const residual of ['pending-delivery', 'last-stop-synthesis', 'nested-descendant']) {
  test(`companion cancellation must not acknowledge terminal root with ${residual}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    let pending = false
    let rootState = residual === 'last-stop-synthesis' ? 'running' : 'complete'
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    h.ctx.hasPendingMessages = () => pending
    await h.command(`begin ${owner}`)
    live = true
    pending = residual === 'pending-delivery'
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned-root' } })
    const stops: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      if (request.method === 'stop') {
        stops.push(request.params.id)
        rootState = 'stopped'
        pending = true
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'status'
            ? {
                asyncSnapshot: {
                  kind: 'pi-subagents.async-status-snapshot',
                  version: 1,
                  runs: [
                    {
                      id: 'owned-root',
                      state: rootState,
                      ...(residual === 'nested-descendant'
                        ? { children: [{ id: 'nested-live', kind: 'subagent', label: 'nested', state: 'running' }] }
                        : {})
                    }
                  ]
                }
              }
            : { runId: request.params.id }
      })
    })
    await h.command(`cancel ${owner}`)
    await h.command(`check ${owner}`)
    assert.equal(live, true, 'explicit host liveness still reports owned work/delivery')
    assert.equal(pending, residual !== 'nested-descendant')
    assert.deepEqual(stops, residual === 'last-stop-synthesis' ? ['owned-root'] : [])
    assert.equal(
      h.updates.some(update => update.state === 'cancelled'),
      false,
      'terminal root is not proof of delivery, synthesis, or descendant quiescence'
    )
    assert.equal(h.updates.at(-1).state, 'pending')
    live = false
    h.ctx.isIdle = () => false
    pending = true
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'native synthesis must settle too')
    h.ctx.isIdle = () => true
    pending = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
  })
}

type Row = { id: string; state: string; kind?: string; children?: any[] }
// Deterministic stand-in for the public v1 status/stop bridge of stock pi-subagents 0.77.0.
function host(h: ReturnType<typeof harness>, rows: Row[] = []) {
  const state = {
    rows: new Map(rows.map(row => [row.id, row])),
    omitted: { runs: 0, children: 0, byteLimitExceeded: false } as any,
    failure: undefined as any,
    held: undefined as undefined | Array<() => void>,
    statusCount: 0,
    stops: [] as string[]
  }
  h.events.on('subagents:rpc:v1:request', request => {
    let body: any = { success: true, data: {} }
    if (request.method === 'status' && !request.params.id) {
      state.statusCount++
      body = state.failure ?? {
        success: true,
        data: {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            caps: { maxStringLength: 160 },
            ...(state.omitted ? { omitted: { ...state.omitted } } : {}),
            runs: [...state.rows.values()].map(row => structuredClone(row))
          }
        }
      }
    } else if (request.method === 'stop') {
      state.stops.push(request.params.id)
      const row = state.rows.get(request.params.id)
      if (row) row.state = 'stopped'
      body = { success: true, data: { runId: request.params.id } }
    }
    const send = () =>
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        ...body
      })
    if (state.held) state.held.push(send)
    else send()
  })
  return state
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
}
// Advance mocked time until the awaited boundary returns or the bound elapses.
async function drive(t: any, pending: Promise<any>, ms: number, step = 100) {
  let done = false
  let value: any
  void pending.then(result => {
    done = true
    value = result
  })
  await flush()
  for (let elapsed = 0; elapsed < ms && !done; elapsed += step) {
    t.mock.timers.tick(step)
    await flush()
  }
  return { done, value }
}
async function foreground(h: ReturnType<typeof harness>, token = owner, text = 'do delegated work') {
  await h.command(`begin ${token}`)
  h.emit('input', { source: 'rpc', text })
  h.emit('before_agent_start', { prompt: text, systemPrompt: 'rendered' })
  h.emit('agent_start')
  h.emit('message_start', { message: { role: 'user', content: text } })
}
const launch = (h: ReturnType<typeof harness>, id: string, input: Record<string, unknown> = { async: true }) =>
  h.emit('tool_result', { toolName: 'subagent', input, details: { asyncId: id, runId: id } })
const notice = (h: ReturnType<typeof harness>, runs: Array<string | Record<string, unknown>>) =>
  h.emit('message_start', {
    message: {
      role: 'custom',
      customType: 'subagent-notify',
      content: 'completion',
      details: { runs: runs.map(run => (typeof run === 'string' ? { runId: run, status: 'completed' } : run)) }
    }
  })
const reply = (h: ReturnType<typeof harness>) => h.emit('message_end', { message: { role: 'assistant', content: [] } })
const boundary = (context: Record<string, unknown> = {}, entries: any[] = [], outcome = 'completed') => ({
  type: 'agent_before_settle',
  outcome,
  entries,
  continue: false,
  context: { pendingMessages: [], canContinue: false, ...context }
})
const settle = (h: ReturnType<typeof harness>, event = boundary()): Promise<any> =>
  Promise.resolve(h.emit('agent_before_settle', event))
const isProbe = (result: any) =>
  result?.continue === true && result.entries?.at(-1)?.customType === 'pi-acp-completion-wait'
const failures = (h: ReturnType<typeof harness>) => h.updates.filter(update => update.state === 'failed')
const timers = (t: any) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
}
const rootA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const rootB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const foreignRun = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

test('companion coexists with a previous host registry and restores it on shutdown', () => {
  let registrations = 0
  const previous = {
    version: 1,
    register: () => {
      registrations++
      return () => {
        registrations--
      }
    }
  }
  globals[key] = previous
  const h = harness()
  const release = h.register({
    name: 'pi-subagents',
    sessionId: 'session',
    sessionFile: '/session',
    isActive: () => true
  })
  assert.equal(registrations, 1)
  release()
  assert.equal(registrations, 0)
  h.emit('session_shutdown')
  assert.equal(globals[key], previous)
  delete globals[key]
})

test('required root prevents settlement beyond 30 minutes; new root from continuation remains required', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'running' },
    { id: foreignRun, state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  // Liveness that reports busy forever (foreign work) is irrelevant to exact completion.
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => true })
  const first = settle(h)
  const held = await drive(t, first, 31 * 60_000, 1_000)
  assert.equal(held.done, false, 'a running required root holds the boundary with no adapter runtime cap')
  status.rows.get(rootA)!.state = 'complete'
  const probed = await drive(t, first, 3_000)
  assert.ok(isProbe(probed.value), 'terminal capture without delivery requests a runnable continuation')
  launch(h, rootB)
  status.rows.set(rootB, { id: rootB, state: 'running' })
  notice(h, [rootA])
  reply(h)
  const secondBoundary = settle(h)
  const second = await drive(t, secondBoundary, 5_000)
  assert.equal(second.done, false, 'a root launched by the continuation extends the same owner')
  status.rows.get(rootB)!.state = 'complete'
  const secondProbe = await drive(t, secondBoundary, 3_000)
  assert.ok(isProbe(secondProbe.value))
  notice(h, [rootB])
  reply(h)
  const released = await drive(t, settle(h), 3_000)
  assert.equal(released.done, true)
  assert.equal(released.value, undefined)
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(status.stops, [], 'completion never stops work')
  assert.equal(status.rows.get(foreignRun)!.state, 'running', 'foreign work survives')
  assert.deepEqual(failures(h), [])
})

test('notice consumed before final provider cycle; final text predating delivery needs a continuation', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete' }])
  await foreground(h)
  reply(h)
  launch(h, rootA)
  await flush()
  notice(h, [rootA])
  const runnable = await drive(t, settle(h, boundary({ canContinue: true })), 1_000)
  assert.deepEqual(runnable.value, { continue: true }, 'the notice is runnable context; no draft needed')
  const assistantFinal = await drive(
    t,
    settle(h, boundary({ canContinue: false }, [{ type: 'custom', customType: 'prior' }])),
    1_000
  )
  assert.equal(assistantFinal.value.continue, true)
  assert.equal(assistantFinal.value.entries[0].customType, 'prior', 'prior boundary drafts are preserved')
  assert.equal(assistantFinal.value.entries[1].customType, 'pi-acp-completion-wait')
  assert.equal(assistantFinal.value.entries[1].display, false)
  reply(h)
  const released = await drive(t, settle(h), 1_000)
  assert.deepEqual(released, { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

test('delivery racing boundary: a queued entry-time message continues natively without probing', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [{ id: rootA, state: 'running' }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  const before = status.statusCount
  const queued = await settle(h, boundary({ pendingMessages: [{ role: 'custom', customType: 'subagent-notify' }] }))
  assert.deepEqual(queued, { continue: true })
  assert.equal(status.statusCount, before, 'the entry-time preview is used before any awaited status')
  status.rows.get(rootA)!.state = 'complete'
  const probe = await drive(t, settle(h), 1_000)
  assert.ok(isProbe(probe.value), 'the queue continuation did not consume probe budget')
})

test('fast provider with notice after probe: probes keep 1 second owner cadence until consumption', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete' }])
  await foreground(h)
  launch(h, rootA)
  const first = await drive(t, settle(h), 100)
  assert.ok(isProbe(first.value))
  const firstAt = Date.now()
  reply(h)
  const second = await drive(t, settle(h), 2_000, 50)
  assert.ok(isProbe(second.value))
  assert.ok(Date.now() - firstAt >= 1_000, 'an immediate re-entry waits for the probe interval')
  notice(h, [rootA])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 100), { done: true, value: undefined })
  assert.deepEqual(failures(h), [])
})

test('terminal capture delivery while another root runs is still probed', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'running' },
    { id: rootB, state: 'complete' }
  ])
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB)
  const probe = await drive(t, settle(h), 1_000)
  assert.ok(isProbe(probe.value))
  assert.match(probe.value.entries.at(-1).content, new RegExp(rootB))
  assert.doesNotMatch(probe.value.entries.at(-1).content, new RegExp(rootA))
  notice(h, [rootB])
  reply(h)
  const holding = settle(h)
  assert.equal((await drive(t, holding, 3_000)).done, false, 'the running root still holds')
  status.rows.get(rootA)!.state = 'failed'
  assert.ok(isProbe((await drive(t, holding, 3_000)).value))
  notice(h, [{ runId: rootA, status: 'failed' }])
  reply(h)
  assert.deepEqual(
    await drive(t, settle(h), 3_000),
    { done: true, value: undefined },
    'failed is an outcome, not a hang'
  )
})

test('probe cadence and count bound: 30 probes at 1 second, then the 30 second delivery deadline fails', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [{ id: rootA, state: 'complete' }])
  await foreground(h)
  launch(h, rootA)
  const probes: number[] = []
  let final: any
  for (let i = 0; i < 40; i++) {
    const result = await drive(t, settle(h), 5_000, 50)
    assert.equal(result.done, true)
    if (!isProbe(result.value)) {
      final = result
      break
    }
    probes.push(Date.now())
    reply(h)
  }
  assert.equal(probes.length, 30)
  for (let i = 1; i < probes.length; i++) assert.ok(probes[i]! - probes[i - 1]! >= 1_000)
  assert.equal(final.value, undefined)
  assert.ok(Date.now() >= 30_000, 'expiry is measured from terminal proof')
  assert.match(failures(h).at(-1).error, /not consumed within 30s/)
  assert.notEqual(h.updates.at(-1).state, 'idle', 'elapsed time is never successful delivery')
  assert.deepEqual(status.stops, [])
})

test('partial delivery and probe drafts are not delivery proof', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [
    { id: rootA, state: 'complete' },
    { id: rootB, state: 'complete' }
  ])
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB)
  const probe = await drive(t, settle(h), 100)
  // Pi commits the waiting draft as a custom message; it is not a completion notice.
  h.emit('message_start', { message: { role: 'custom', customType: 'pi-acp-completion-wait', content: 'wait' } })
  notice(h, [rootA])
  reply(h)
  const again = await drive(t, settle(h, boundary({}, probe.value.entries)), 2_000, 50)
  assert.ok(isProbe(again.value), 'the undelivered capture is probed again')
  assert.match(again.value.entries.at(-1).content, new RegExp(rootB))
  assert.doesNotMatch(again.value.entries.at(-1).content, new RegExp(rootA))
})

test('terminal proof survives completed-record retention and resets on recapture', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete' },
    { id: rootB, state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB) // keeps status polling active after rootA's proof latches
  await flush()
  status.rows.delete(rootA) // stock drops completed jobs after 10 seconds
  for (let i = 0; i < 11; i++) {
    t.mock.timers.tick(1_000)
    await flush()
  }
  const probe = await drive(t, settle(h), 100)
  assert.ok(isProbe(probe.value), 'latched exact proof is kept across retention')
  notice(h, [rootA])
  status.rows.get(rootB)!.state = 'complete'
  notice(h, [rootB])
  reply(h)
  assert.equal((await drive(t, settle(h), 3_000)).done, true)
  // Same ID relaunched after its notice was consumed: a new capture with no inherited latch.
  status.rows.set(rootA, { id: rootA, state: 'running' })
  launch(h, rootA, { action: 'resume', id: rootA })
  assert.equal((await drive(t, settle(h), 3_000)).done, false)
  assert.deepEqual(failures(h), [])
})

for (const evidence of ['none', 'branch', 'fresh-id']) {
  test(`reused run ID delivery attribution with ${evidence} prior-notice evidence`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [{ id: rootA, state: 'running' }])
    if (evidence === 'branch')
      (h.ctx.sessionManager as any).getBranch = () => [
        { type: 'custom_message', customType: 'subagent-notify', details: { runs: [{ runId: rootA }] } }
      ]
    await foreground(h)
    if (evidence !== 'fresh-id') launch(h, rootA) // the earlier attempt, notice never consumed
    const revived = evidence === 'fresh-id' ? rootB : rootA
    launch(h, revived, { action: 'resume', id: revived })
    const result = await drive(t, settle(h), 3_000)
    if (evidence === 'none') {
      assert.deepEqual(result, { done: true, value: undefined })
      assert.match(failures(h).at(-1).error, /reused before its previous completion notice/)
    } else if (evidence === 'branch') {
      assert.equal(result.done, false, 'a consumed earlier notice disambiguates the revival')
      assert.deepEqual(failures(h), [])
    } else {
      // The stock revives under a fresh run ID with no earlier attempt to confuse.
      assert.equal(result.done, false, 'a fresh-ID revival is newly owned work, not ambiguity')
      assert.deepEqual(failures(h), [])
      assert.ok(
        h.updates.some(update => update.state === 'active'),
        'the revived run was captured'
      )
    }
  })
}

for (const shape of ['status-action', 'management', 'error', 'foreign-session']) {
  test(`only launches create ownership: ${shape} results are not captured`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [{ id: rootA, state: 'running' }])
    await foreground(h)
    if (shape === 'foreign-session') h.ctx.sessionManager.getSessionId = () => 'other'
    h.emit('tool_result', {
      toolName: 'subagent',
      input: shape === 'status-action' ? { action: 'status', id: rootA } : { async: true },
      isError: shape === 'error',
      details: { asyncId: rootA, ...(shape === 'management' ? { mode: 'management' } : {}) }
    })
    h.ctx.sessionManager.getSessionId = () => 'session'
    assert.equal(
      h.updates.some(update => update.state === 'active'),
      false
    )
    assert.deepEqual(await drive(t, settle(h), 100), { done: true, value: undefined })
    await assert.rejects(h.tool('acp_detach', { runIds: [rootA] }), /nothing was detached/)
  })
}

for (const shape of [
  'omitted-children',
  'omitted-root',
  'missing-accounting',
  'malformed-row',
  'status-failure',
  'missing-snapshot',
  'unstructured-notice',
  'left-status'
]) {
  test(`unsupported completion evidence fails visibly without stopping work: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: shape === 'unstructured-notice' ? 'complete' : 'running' },
      { id: foreignRun, state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    const root = status.rows.get(rootA)!
    if (shape === 'omitted-children') {
      root.state = 'complete'
      status.omitted.children = 1
    }
    if (shape === 'omitted-root') {
      status.rows.delete(rootA)
      status.omitted.runs = 1
    }
    if (shape === 'missing-accounting') {
      root.state = 'complete'
      status.omitted = undefined
    }
    if (shape === 'malformed-row') Object.assign(root, { state: 'complete', children: [{ id: 'x', kind: 'subagent' }] })
    if (shape === 'status-failure') status.failure = { success: false, error: { code: 'denied', message: 'denied' } }
    if (shape === 'missing-snapshot') status.failure = { success: true, data: { text: 'no snapshot' } }
    if (shape === 'unstructured-notice')
      h.emit('message_start', { message: { role: 'custom', customType: 'subagent-notify', content: 'done' } })
    if (shape === 'left-status') status.rows.delete(rootA)
    const result = await drive(t, settle(h), 3_000)
    assert.deepEqual(result, { done: true, value: undefined })
    assert.equal(failures(h).length, 1)
    assert.notEqual(h.updates.at(-1).state, 'idle')
    assert.deepEqual(status.stops, [], 'failure is not broad termination')
    assert.equal(status.rows.get(foreignRun)!.state, 'running')
  })
}

test('terminal root with live descendant rows or notice-reported children holds until exact drain and delivery', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete', children: [{ id: 'step:0', kind: 'step', state: 'running' }] },
    { id: 'child-run', state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  const first = settle(h)
  assert.equal((await drive(t, first, 3_000)).done, false, 'a live display row under a terminal root holds')
  status.rows.get(rootA)!.children![0].state = 'complete'
  const probe = await drive(t, first, 3_000)
  assert.ok(isProbe(probe.value))
  notice(h, [{ runId: rootA, status: 'completed', childRuns: [{ runId: 'child-run', status: 'running' }] }])
  reply(h)
  const second = settle(h)
  assert.equal((await drive(t, second, 3_000)).done, false, 'a promoted live child reported by the notice holds')
  status.rows.get('child-run')!.state = 'complete'
  const childProbe = await drive(t, second, 3_000)
  assert.ok(isProbe(childProbe.value), 'a terminal promoted child still owes its own completion notice')
  assert.match(childProbe.value.entries.at(-1).content, /child-run/)
  reply(h)
  status.rows.set('grandchild-run', { id: 'grandchild-run', state: 'running' })
  notice(h, [{ runId: 'child-run', status: 'completed', childRuns: [{ runId: 'grandchild-run', status: 'running' }] }])
  const third = settle(h)
  assert.equal((await drive(t, third, 3_000)).done, false, 'a live run reported by a descendant notice holds')
  status.rows.get('grandchild-run')!.state = 'complete'
  assert.ok(isProbe((await drive(t, third, 3_000)).value))
  notice(h, ['grandchild-run'])
  const unanswered = await drive(t, settle(h), 3_000)
  assert.equal(unanswered.value.continue, true, 'a consumed descendant notice needs a later provider cycle')
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(failures(h), [])
})

test('atomic acp_detach validates the whole batch; detached and foreign work survive cancellation', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'running' },
    { id: rootB, state: 'running' },
    { id: foreignRun, state: 'running' }
  ])
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => true })
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB)
  for (const runIds of [[rootA, foreignRun], [rootA, rootA], [], [''], 'x'])
    await assert.rejects(h.tool('acp_detach', { runIds }))
  h.ctx.sessionManager.getSessionFile = () => '/other-file'
  await assert.rejects(h.tool('acp_detach', { runIds: [rootA] }), /only available/)
  h.ctx.sessionManager.getSessionFile = () => '/session'
  const detached = await h.tool('acp_detach', { runIds: [rootA] })
  assert.deepEqual(detached.details, { runIds: [rootA] })
  await assert.rejects(h.tool('acp_detach', { runIds: [rootA] }), /nothing was detached/, 'already detached')
  const holding = settle(h)
  assert.equal((await drive(t, holding, 2_000)).done, false, 'the unmentioned root stays required')
  await h.command(`cancel ${owner}`)
  assert.equal((await drive(t, holding, 0)).done, true, 'the cancel control wakes the suspended boundary')
  await h.cancel(owner)
  assert.deepEqual(status.stops, [rootB])
  assert.equal(status.rows.get(rootA)!.state, 'running', 'detached work survives')
  assert.equal(status.rows.get(foreignRun)!.state, 'running', 'foreign work survives')
  assert.equal(h.updates.at(-1).state, 'cancelled', 'exact proof does not wait on busy foreign liveness')
  notice(h, [rootA])
  const next = '77777777-7777-4777-8777-777777777777'
  await foreground(h, next)
  assert.deepEqual(await drive(t, settle(h), 100), { done: true, value: undefined }, 'a later owner adopts nothing')
  await assert.rejects(h.tool('acp_detach', { runIds: [rootB] }), /nothing was detached/)
})

test('owner replacement, stale awaited replies and shutdown end a suspended boundary without settlement', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [{ id: rootA, state: 'running' }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  status.held = []
  const holding = settle(h)
  await flush()
  const next = '77777777-7777-4777-8777-777777777777'
  await h.command(`begin ${next}`)
  const returned = await drive(t, holding, 100)
  assert.deepEqual(returned, { done: true, value: undefined })
  status.rows.get(rootA)!.state = 'complete'
  for (const send of status.held.splice(0)) send()
  status.held = undefined
  await flush()
  assert.equal(
    h.updates.some(update => update.owner === owner && ['idle', 'failed'].includes(update.state)),
    false,
    'a stale reply has no authority'
  )
  launch(h, rootB)
  status.rows.set(rootB, { id: rootB, state: 'running' })
  const shutdownHold = settle(h)
  await flush()
  h.emit('session_shutdown')
  assert.deepEqual(await drive(t, shutdownHold, 100), { done: true, value: undefined })
  const count = status.statusCount
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(status.statusCount, count, 'shutdown stops status polling')
})

for (const outcome of ['error', 'aborted']) {
  test(`hard ${outcome} exit is never overridden and never successful`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [{ id: rootA, state: 'running' }])
    await foreground(h)
    launch(h, rootA)
    await flush()
    const count = status.statusCount
    assert.equal(await settle(h, boundary({ canContinue: true }, [], outcome)), undefined)
    assert.equal(status.statusCount, count)
    h.emit('agent_settled')
    assert.match(failures(h).at(-1).error, /settled before required/)
    assert.deepEqual(status.stops, [])
  })
}

test('companion stops only owned live IDs, skips proven terminal IDs, rejects foreign ownership', async () => {
  const h = harness()
  let active = false
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => active })
  await h.command(`begin ${owner}`)
  active = true
  for (const id of ['live', 'terminal']) h.emit('tool_result', { toolName: 'subagent', details: { asyncId: id } })
  const stopped: string[] = []
  h.events.on('subagents:rpc:v1:request', request => {
    let data
    if (request.method === 'status')
      data = {
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [
            { id: 'live', state: active ? 'running' : 'stopped' },
            { id: 'terminal', state: 'complete' },
            { id: 'foreign', state: 'running' }
          ]
        }
      }
    else {
      stopped.push(request.params.id)
      active = false
      data = { runId: request.params.id }
    }
    h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data
    })
  })
  await assert.rejects(h.cancel('foreign'), /Invalid ACP lifecycle owner/)
  await h.cancel(owner)
  assert.deepEqual(stopped, ['live'])
  assert.equal(h.updates.at(-1).state, 'cancelled')
  h.emit('session_shutdown')
})

test('stop rejection and missing RPC replies are explicit failures, never successful drain', async () => {
  for (const respond of [true, false]) {
    const h = harness()
    let active = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => active })
    await h.command(`begin ${owner}`)
    active = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    if (respond)
      h.events.on('subagents:rpc:v1:request', request => {
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: { message: 'denied' }
        })
      })
    await assert.rejects(
      h.cancel(owner),
      respond ? /pi-subagents status failed: denied/ : /pi-subagents status timed out$/
    )
    assert.equal(h.updates.at(-1).state, 'error')
    h.emit('session_shutdown')
  }
})

test('pre-existing same-session work is not adopted; ordinary Pi needs no optional provider', async () => {
  const h = harness()
  await h.command(`begin ${owner}`)
  h.emit('agent_end')
  h.emit('agent_settled')
  assert.equal(h.updates.at(-1).state, 'ready')
  let busy = true
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready', 'live restored children are not model ownership')
  busy = false
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready')
  h.emit('session_shutdown')
})

for (const drain of [true, false]) {
  test(`companion cancellation keeps its deadline after long-running work and slow status/stop/drain (${drain})`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    t.mock.timers.tick(60 * 60_000)
    assert.equal(h.updates.at(-1).state, 'active')
    let requests = 0
    h.events.on('subagents:rpc:v1:request', request => {
      requests++
      setTimeout(
        () => {
          h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
            version: 1,
            requestId: request.requestId,
            success: true,
            data:
              request.method === 'status'
                ? {
                    asyncSnapshot: {
                      kind: 'pi-subagents.async-status-snapshot',
                      version: 1,
                      runs: [{ id: 'owned', state: busy ? 'running' : 'stopped' }]
                    }
                  }
                : { runId: 'owned' }
          })
        },
        requests <= 2 ? 4000 : 0
      )
    })
    const pending = h.cancel(owner)
    const result = drain ? pending : assert.rejects(pending, /termination could not be confirmed/)
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(4000)
      await new Promise(resolve => setImmediate(resolve))
    }
    if (drain) busy = false
    for (let i = 0; i < (drain ? 5 : 10); i++) {
      t.mock.timers.tick(100)
      await new Promise(resolve => setImmediate(resolve))
    }
    await result
    assert.equal(
      h.updates.some(update => update.state === 'cancelled'),
      drain
    )
    assert.equal(h.updates.at(-1).state, drain ? 'cancelled' : 'pending')
    h.emit('session_shutdown')
  })
}

for (const transition of ['invalid_state', 'not_found', 'unrelated']) {
  test(`owned cancellation retries ${transition} and retains exact terminal IDs while aggregate liveness is inconclusive`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    let stops = 0
    let state = transition === 'unrelated' ? 'running' : 'queued'
    h.events.on('subagents:rpc:v1:request', request => {
      const reply = {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {} as any,
        error: undefined as any
      }
      if (request.method === 'status')
        reply.data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            runs: [
              { id: 'owned', state },
              { id: 'foreign', state: 'running' }
            ]
          }
        }
      else {
        assert.equal(request.params.id, 'owned')
        stops++
        if (stops === 1 && transition !== 'unrelated') {
          reply.success = false
          reply.error = {
            code: transition,
            message:
              transition === 'not_found'
                ? "Status file not found for async run 'owned'."
                : 'Async run owned is queued; stop only supports running async runs.'
          }
          state = 'running'
        } else {
          state = 'stopped'
          reply.data = { runId: 'owned' }
        }
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply)
    })
    let error: unknown
    const pending = h.cancel(owner).catch(e => {
      error = e
    })
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(1000)
      await new Promise(resolve => setImmediate(resolve))
    }
    await pending
    h.emit('session_shutdown')
    assert.match(String(error), /termination could not be confirmed/)
    assert.equal(stops, transition === 'unrelated' ? 1 : 2)
    assert.ok(!h.updates.some(update => update.state === 'cancelled'))
    assert.equal(busy, true, 'unrelated liveness is unknown ownership, never stop authority')
  })
}

for (const failure of ['omitted', 'wrong-session', 'permission', 'malformed']) {
  test(`companion never claims cancellation on ${failure} status/stop`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    let stops = 0
    h.events.on('subagents:rpc:v1:request', request => {
      const reply = {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {} as any,
        error: undefined as any
      }
      if (request.method === 'status')
        reply.data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            runs: failure === 'omitted' ? [] : [{ id: 'owned', state: 'running' }]
          }
        }
      else {
        stops++
        reply.success = failure === 'malformed'
        reply.error =
          failure === 'wrong-session'
            ? { code: 'not_found', message: "Async run 'owned' was not found in the active session." }
            : { code: 'permission_denied', message: 'denied' }
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply)
    })
    const result = assert.rejects(
      h.cancel(owner),
      failure === 'omitted' ? /termination could not be confirmed/ : /stop failed/
    )
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(1000)
      await new Promise(resolve => setImmediate(resolve))
    }
    await result
    assert.equal(stops, failure === 'omitted' ? 0 : 1)
    assert.ok(!h.updates.some(update => update.state === 'cancelled'))
    h.emit('session_shutdown')
  })
}

test('companion retains owner across native settlement and repeated post-stop tool results', async () => {
  const h = harness()
  let busy = false
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await h.command(`begin ${owner}`)
  h.emit('agent_settled')
  await h.cancel(owner)
  busy = true
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'late' } })
  h.events.on('subagents:rpc:v1:request', request => {
    h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [{ id: 'late', state: 'stopped' }]
        }
      }
    })
  })
  await h.command(`cancel ${owner}`)
  await h.command(`check ${owner}`)
  assert.equal(h.updates.at(-1).state, 'pending')
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'rejected', 'unconfirmed ownership must not be forgotten')
  busy = false
  await h.command(`check ${owner}`)
  assert.equal(h.updates.at(-1).state, 'cancelled')
  h.emit('session_shutdown')
})

const ownedRoot = '22222222-2222-4222-8222-222222222222'
const nestedId = '33333333-3333-4333-8333-333333333333'
const deeperId = '44444444-4444-4444-8444-444444444444'
const routeRoot = '55555555-5555-4555-8555-555555555555'
const foreignRoot = '66666666-6666-4666-8666-666666666666'
function statusHeaders(id: string, parent = ownedRoot, root = routeRoot, state = 'running') {
  return `Status target: run ${id}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nNested run: ${id}\nRoot: ${root}\nParent: ${parent} step 1\nState: ${state}\nAgent: fixture`
}

for (const method of ['status', 'interrupt']) {
  test(`companion reconciles stock nested ${method} execution_failed across owned roots`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    let stale = true
    let terminal = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    await h.command(`begin ${owner}`)
    live = true
    for (const asyncId of [ownedRoot, foreignRoot])
      h.emit('tool_result', { toolName: 'subagent', details: { asyncId } })
    const stops: string[] = []
    const interrupts: string[] = []
    const targeted: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      const id = request.params.id
      if (request.method === 'status' && id) targeted.push(id)
      if (request.method === 'interrupt') interrupts.push(id)
      if (request.method === method && id === nestedId && stale) {
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: {
            code: 'execution_failed',
            message:
              method === 'status'
                ? 'Async run not found. Provide id or dir.'
                : `Nested run ${id} is already complete and cannot be interrupted.`
          }
        })
        return
      }
      if (request.method === 'stop') stops.push(id)
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'status'
            ? id
              ? {
                  text: statusHeaders(
                    id,
                    id === nestedId ? ownedRoot : foreignRoot,
                    routeRoot,
                    stale ? 'running' : 'complete'
                  )
                }
              : {
                  asyncSnapshot: {
                    kind: 'pi-subagents.async-status-snapshot',
                    version: 1,
                    caps: { maxStringLength: 160 },
                    runs: [ownedRoot, foreignRoot].map((root, index) => ({
                      id: root,
                      state: terminal ? 'complete' : 'running',
                      children: [{ id: index === 0 ? nestedId : deeperId, kind: 'subagent', state: 'running' }]
                    }))
                  }
                }
            : { runId: id }
      })
    })
    await h.command(`cancel ${owner}`)
    assert.deepEqual(stops, [ownedRoot, foreignRoot], 'a stale descendant must not skip either owned root stop')
    assert.ok(interrupts.includes(deeperId), 'the next owned root still receives nested control')
    assert.match(h.updates.at(-1).error, /pi-subagents (status|interrupt) failed/)
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending')
    assert.match(h.updates.at(-1).error, /not found|already complete/)
    stale = false
    terminal = true
    await h.command(`cancel ${owner}`)
    assert.equal(targeted.filter(id => id === nestedId).length, 2, 're-observe failed targets on the next pass')
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'terminal records still cannot replace aggregate quiescence')
    live = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
    assert.equal(h.updates.at(-1).error, undefined, 'independent quiescence resolves the unconfirmed outcome')
  })
}

for (const method of ['status', 'interrupt']) {
  for (const code of ['invalid_params', 'unsupported_method', 'no_active_session', 'denied', undefined]) {
    test(`companion preserves fatal nested ${method} rejection: ${code ?? 'malformed reply'}`, async t => {
      const h = harness()
      t.after(() => h.emit('session_shutdown'))
      let live = false
      h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
      await h.command(`begin ${owner}`)
      live = true
      h.emit('tool_result', { toolName: 'subagent', details: { asyncId: ownedRoot } })
      h.events.on('subagents:rpc:v1:request', request => {
        const fail = request.method === method && request.params.id === nestedId
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          ...(fail
            ? { success: false, error: { code, message: 'rejected control' } }
            : {
                success: true,
                data: request.params.id
                  ? { text: statusHeaders(nestedId) }
                  : {
                      asyncSnapshot: {
                        kind: 'pi-subagents.async-status-snapshot',
                        version: 1,
                        caps: { maxStringLength: 160 },
                        runs: [{ id: ownedRoot, state: 'complete', children: [{ id: nestedId, kind: 'subagent' }] }]
                      }
                    }
              })
        })
      })
      await assert.rejects(h.command(`cancel ${owner}`), /rejected control/)
      assert.equal(h.updates.at(-1).state, 'error')
      assert.equal(
        h.updates.some(update => update.state === 'cancelled'),
        false
      )
    })
  }
}

for (const shape of [
  'direct',
  'deep-live-parent',
  'sibling-routes',
  'deep-terminal-parent',
  'wrong-parent',
  'wrong-route',
  'missing-parent',
  'cycle',
  'stale',
  'stale-status',
  'stale-interrupt',
  'normalized',
  'truncated',
  'injected',
  'duplicate',
  'control',
  'foreign-sibling'
]) {
  test(`companion verifies canonical nested ancestry before interrupt: ${shape}`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    await h.command(`begin ${owner}`)
    live = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: ownedRoot } })
    const nested = { id: nestedId, kind: 'subagent', state: 'running' }
    const deeper = { id: deeperId, kind: 'subagent', state: 'running' }
    const children = shape === 'missing-parent' ? [deeper] : shape === 'direct' ? [nested] : [nested, deeper]
    const controls: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      let data: object
      if (
        (shape === 'stale-status' && request.method === 'status' && request.params.id) ||
        (shape === 'stale-interrupt' && request.method === 'interrupt')
      ) {
        if (request.method === 'interrupt') controls.push(request.params.id)
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: {
            code: 'execution_failed',
            message: 'Target already settled'
          }
        })
        return
      }
      if (request.method === 'interrupt') {
        controls.push(request.params.id)
        data = {}
      } else if (request.params.id) {
        let text =
          request.params.id === deeperId
            ? statusHeaders(
                deeperId,
                shape === 'sibling-routes' ? ownedRoot : nestedId,
                shape === 'wrong-route' || shape === 'sibling-routes' ? foreignRoot : routeRoot
              )
            : statusHeaders(
                nestedId,
                shape === 'wrong-parent' ? foreignRoot : shape === 'cycle' ? deeperId : ownedRoot,
                routeRoot,
                shape === 'deep-terminal-parent' || shape === 'stale' ? 'complete' : 'running'
              )
        if (shape === 'normalized')
          text = text.replace(`Nested run: ${request.params.id}`, `Nested run:  ${request.params.id}`)
        if (shape === 'injected') text = `Agent: fake\n${text}`
        if (shape === 'duplicate') text += `\nRoot: ${foreignRoot}`
        if (shape === 'control') text += '\u001b[0m'
        data = { text }
      } else
        data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            caps: { maxStringLength: shape === 'truncated' ? 36 : 160 },
            runs: [
              {
                id: ownedRoot,
                state: 'complete',
                children: shape === 'foreign-sibling' ? [] : shape === 'stale' ? [nested] : children
              },
              { id: foreignRoot, state: 'running', children: [nested] }
            ]
          }
        }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data
      })
    })
    await h.command(`cancel ${owner}`)
    assert.equal(h.updates.at(-1).state, 'stopping')
    assert.deepEqual(
      controls.sort(),
      ['deep-live-parent', 'sibling-routes', 'stale-interrupt'].includes(shape)
        ? [nestedId, deeperId]
        : shape === 'deep-terminal-parent'
          ? [deeperId]
          : shape === 'wrong-route' || shape === 'direct'
            ? [nestedId]
            : []
    )
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'interrupt ACK and root state do not prove quiescence')
    live = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
  })
}

test('companion stages exact tokens while busy and ignores readiness after withdrawal or replacement', async t => {
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const waiters: Array<() => void> = []
  h.ctx.waitForIdle = () => new Promise<void>(resolve => waiters.push(resolve))
  h.ctx.isIdle = () => false
  h.emit('agent_start')
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'waiting')
  await h.command(`withdraw ${owner}`)
  const next = '77777777-7777-4777-8777-777777777777'
  await h.command(`begin ${next}`)
  h.ctx.isIdle = () => true
  h.emit('agent_settled')
  waiters[0]!()
  await Promise.resolve()
  assert.equal(h.updates.at(-1).state, 'waiting', 'withdrawn token cannot emit late readiness')
  waiters[1]!()
  await Promise.resolve()
  assert.deepEqual(h.updates.at(-1), { version: 1, owner: next, state: 'ready' })
})

test('companion admits a live restored child without claiming it or a foreign model run', async t => {
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => true })
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready')
  h.emit('agent_start')
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'foreign-child' } })
  assert.equal(
    h.updates.some(update => update.state === 'active'),
    false
  )
  h.emit('agent_settled')
  const next = '77777777-7777-4777-8777-777777777777'
  await h.command(`begin ${next}`)
  const requests: string[] = []
  h.events.on('subagents:rpc:v1:request', request => requests.push(request.method))
  await h.command(`cancel ${next}`)
  assert.deepEqual(requests, [], 'new foreground token has no stop authority over restored/foreign children')
})

for (const residual of ['idle', 'native-run', 'pending-messages']) {
  test(`companion cancellation with no owned children ignores foreign liveness but preserves ${residual}`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let livenessReads = 0
    h.register({
      name: 'pi-subagents',
      sessionId: 'session',
      isActive: () => {
        livenessReads++
        return true
      }
    })
    const requests: string[] = []
    h.events.on('subagents:rpc:v1:request', request => requests.push(request.method))
    await h.command(`begin ${owner}`)
    h.emit('input', { source: 'rpc', text: 'ordinary question' })
    h.emit('before_agent_start', { prompt: 'ordinary question' })
    h.emit('agent_start')
    h.emit('message_start', { message: { role: 'user', content: 'ordinary question' } })
    h.emit('agent_settled')
    h.ctx.isIdle = () => residual !== 'native-run'
    h.ctx.hasPendingMessages = () => residual === 'pending-messages'
    await h.command(`cancel ${owner}`)
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, residual === 'idle' ? 'cancelled' : 'pending')
    h.ctx.isIdle = () => true
    h.ctx.hasPendingMessages = () => false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled', 'foreign provider cannot hold an empty cancellation scope')
    assert.equal(livenessReads, 0, 'foreign child liveness is irrelevant without observed owned IDs')
    assert.deepEqual(requests, [], 'no status, interrupt or stop authority over unrelated work')
  })
}

for (const normalization of ['unchanged', 'resized', 'failed', 'text-only-prefix', 'foreign-image-input']) {
  test(`companion correlates image normalization without adopting foreign input: ${normalization}`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const image = { type: 'image', data: 'fixture', mimeType: 'image/png' }
    const hasImages = normalization !== 'text-only-prefix'
    let live = true
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    await h.command(`begin ${owner}`)
    h.emit('input', { source: 'rpc', text: '/inspect', images: hasImages ? [image] : undefined })
    // Pi expands input before this hook and appends normalization hints afterward.
    h.emit('before_agent_start', { prompt: 'expanded inspection', images: hasImages ? [image] : undefined })
    if (normalization === 'foreign-image-input') {
      h.emit('input', { source: 'extension', text: 'expanded inspection', images: [image] })
      h.emit('before_agent_start', { prompt: 'expanded inspection', images: [image] })
    }
    h.emit('agent_start')
    const hints = normalization === 'unchanged' ? '' : '\n\nImage processing hint'
    h.emit('message_start', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `expanded inspection${hints}` },
          ...(hasImages && normalization !== 'failed' ? [image] : [])
        ]
      }
    })
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned-image-child' } })
    const stops: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      if (request.method === 'stop') stops.push(request.params.id)
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'status'
            ? {
                asyncSnapshot: {
                  kind: 'pi-subagents.async-status-snapshot',
                  version: 1,
                  runs: [
                    { id: 'owned-image-child', state: 'running' },
                    { id: 'unrelated-child', state: 'running' }
                  ]
                }
              }
            : { runId: request.params.id }
      })
    })
    await h.command(`cancel ${owner}`)
    assert.deepEqual(
      stops,
      ['text-only-prefix', 'foreign-image-input'].includes(normalization) ? [] : ['owned-image-child']
    )
    live = false
  })
}

test('an unreleased status poll does not keep the Pi process alive', { timeout: 15_000 }, async () => {
  const { execFile } = await import('node:child_process')
  const extension = new URL('../../src/pi-rpc/acp-extension.ts', import.meta.url).pathname
  const script = `
    const { default: acpExtension } = await import(${JSON.stringify(extension)})
    const hooks = new Map(); let command
    const ctx = { isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {},
      sessionManager: { getSessionId: () => 's', getSessionFile: () => '/s' }, ui: { setWidget() {} } }
    acpExtension({ events: { on: () => () => {}, emit() {} }, on: (n, h) => hooks.set(n, h),
      registerCommand: (_n, c) => { command = c.handler }, registerTool() {} })
    await command('begin 11111111-1111-4111-8111-111111111111', ctx)
    hooks.get('tool_result')({ toolName: 'subagent', details: { asyncId: 'leak' } }, ctx)
  `
  const started = Date.now()
  await new Promise<void>((resolve, reject) =>
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10_000 }, error =>
      error ? reject(error) : resolve()
    )
  )
  assert.ok(Date.now() - started < 8_000, 'the advisory poll timer must not hold the event loop open')
})

const promoted = (root: string, child: string) => ({
  runId: root,
  status: 'completed',
  childRuns: [{ runId: child, status: 'running' }]
})

test('cancellation stops promoted descendants of captured roots, never detached or foreign work', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete', kind: 'workflow' },
    { id: nestedId, state: 'running' },
    { id: rootB, state: 'complete' },
    { id: deeperId, state: 'running' },
    { id: foreignRun, state: 'running' }
  ])
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => true })
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB)
  await flush()
  notice(h, [promoted(rootA, nestedId), promoted(rootB, deeperId)])
  await assert.rejects(
    h.tool('acp_detach', { runIds: [nestedId] }),
    /nothing was detached/,
    'not independently detachable'
  )
  await h.tool('acp_detach', { runIds: [rootB] })
  await h.command(`cancel ${owner}`)
  await h.command(`check ${owner}`)
  assert.deepEqual(status.stops, [nestedId], 'the live child of a completed dispatch root is owned work')
  assert.equal(h.updates.at(-1).state, 'cancelled')
  assert.equal(status.rows.get(deeperId)!.state, 'running', 'detaching a root removes its descendant authority')
  assert.equal(status.rows.get(foreignRun)!.state, 'running', 'foreign work survives')
})

test('a latched parent leaving status keeps its separately reported descendant observable', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete' },
    { id: 'child-run', state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  await flush()
  notice(h, [promoted(rootA, 'child-run')])
  reply(h)
  status.rows.delete(rootA) // completed-record retention expired
  const holding = settle(h)
  assert.equal((await drive(t, holding, 15_000, 1_000)).done, false, 'the live child still holds')
  status.rows.get('child-run')!.state = 'complete'
  const probe = await drive(t, holding, 3_000)
  assert.ok(isProbe(probe.value), 'the child terminal state is still observed')
  assert.match(probe.value.entries.at(-1).content, /child-run/)
  notice(h, ['child-run'])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(failures(h), [])
})

for (const shape of ['omitted-children', 'missing-accounting', 'preserved-latch']) {
  test(`descendant terminal proof requires complete status accounting: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete' },
      { id: 'child-run', state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    notice(h, [promoted(rootA, 'child-run')])
    reply(h)
    if (shape === 'preserved-latch') {
      status.rows.get('child-run')!.state = 'complete'
      assert.ok(isProbe((await drive(t, settle(h), 3_000)).value), 'validated descendant latch')
      status.omitted = undefined
      notice(h, ['child-run'])
      reply(h)
      assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
      assert.equal(h.updates.at(-1).state, 'idle', 'a later lossy snapshot does not revoke validated proof')
      assert.deepEqual(failures(h), [])
      return
    }
    if (shape === 'omitted-children') status.omitted.children = 1
    else status.omitted = undefined
    status.rows.get('child-run')!.state = 'complete'
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.match(failures(h).at(-1)?.error ?? '', /cannot prove descendants of child-run drained/)
    assert.notEqual(h.updates.at(-1).state, 'idle')
    assert.deepEqual(status.stops, [])
  })
}

for (const shape of ['late-consumption', 'late-preview', 'timely-slow-synthesis']) {
  test(`delivery window governs consumption, not synthesis: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [{ id: rootA, state: 'complete' }])
    await foreground(h)
    launch(h, rootA)
    await flush()
    if (shape === 'late-preview') {
      t.mock.timers.tick(31_000)
      await flush()
      const preview = boundary({ pendingMessages: [{ role: 'custom', customType: 'subagent-notify' }] })
      assert.equal(await settle(h, preview), undefined, 'an expired notice in the preview is not a continuation')
      assert.match(failures(h).at(-1)?.error ?? '', /30s/)
      return
    }
    assert.ok(isProbe((await drive(t, settle(h), 100)).value))
    // The probe's provider call is slow; the notice queues and is consumed only afterwards.
    t.mock.timers.tick(shape === 'late-consumption' ? 31_000 : 5_000)
    await flush()
    notice(h, [rootA])
    if (shape === 'timely-slow-synthesis') {
      t.mock.timers.tick(60_000)
      await flush()
      const synthesis = await drive(t, settle(h), 1_000)
      assert.equal(synthesis.value?.continue, true, 'timely delivery ends the deadline; synthesis is not timed')
    }
    reply(h)
    const result = await drive(t, settle(h), 1_000)
    assert.deepEqual(result, { done: true, value: undefined })
    if (shape === 'late-consumption') {
      assert.match(failures(h).at(-1)?.error ?? '', /30s/)
      assert.notEqual(h.updates.at(-1).state, 'idle')
    } else {
      assert.deepEqual(failures(h), [])
      assert.equal(h.updates.at(-1).state, 'idle')
    }
  })
}

const steering = (state: string, replacementRunId?: string) => ({
  mode: 'management',
  results: [],
  steering: {
    requestId: 'request',
    state,
    deliveryStatus: 'delivered',
    sourceRunId: rootA,
    ...(replacementRunId ? { replacementRunId } : {}),
    targets: [{ index: 0, state, ...(replacementRunId ? { replacementRunId } : {}) }]
  }
})
for (const shape of [
  'recovered-steer',
  'padded-resume',
  'delivered-steer',
  'pending-steer',
  'source-replacement',
  'status-with-steering',
  'padded-status'
]) {
  test(`revival capture follows runner receipts and action normalization: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'running' },
      { id: rootB, state: 'running' }
    ])
    await foreground(h)
    const steer = { action: 'steer', id: rootA, message: 'change course' }
    const [input, details] = (
      {
        'recovered-steer': [steer, steering('recovered', rootB)],
        'padded-resume': [
          { action: ' resume ', id: rootA },
          { asyncId: rootB, runId: rootB }
        ],
        'delivered-steer': [steer, steering('delivered')],
        'pending-steer': [steer, steering('pending', rootB)],
        'source-replacement': [steer, steering('recovered', rootA)],
        'status-with-steering': [{ action: 'status', id: rootA }, steering('recovered', rootB)],
        'padded-status': [{ action: ' status ', id: rootB }, { asyncId: rootB }]
      } as Record<string, [object, object]>
    )[shape]!
    h.emit('tool_result', { toolName: 'subagent', input, details })
    const captured = shape === 'recovered-steer' || shape === 'padded-resume'
    assert.equal(
      h.updates.some(update => update.state === 'active'),
      captured
    )
    if (!captured) {
      assert.deepEqual(await drive(t, settle(h), 100), { done: true, value: undefined })
      await assert.rejects(h.tool('acp_detach', { runIds: [rootB] }), /nothing was detached/)
      return
    }
    assert.equal((await drive(t, settle(h), 2_000)).done, false, 'the fresh replacement is required')
    await h.command(`cancel ${owner}`)
    await h.command(`check ${owner}`)
    assert.deepEqual(status.stops, [rootB], 'only the replacement gains cancellation authority')
    assert.equal(h.updates.at(-1).state, 'cancelled')
    assert.equal(status.rows.get(rootA)!.state, 'running')
  })
}

for (const shape of ['rejected', 'malformed']) {
  test(`a stale owner's ${shape} status poll cannot fail the replacement owner`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [{ id: rootA, state: 'running' }])
    await foreground(h)
    launch(h, rootA)
    await flush()
    status.held = []
    status.failure =
      shape === 'rejected'
        ? { success: false, error: { code: 'denied', message: 'denied' } }
        : { success: true, data: { text: 'no snapshot' } }
    const holding = settle(h)
    await flush()
    const next = '77777777-7777-4777-8777-777777777777'
    await h.command(`begin ${next}`)
    assert.deepEqual(await drive(t, holding, 100), { done: true, value: undefined })
    const held = status.held.splice(0)
    status.held = undefined
    status.failure = undefined
    await foreground(h, next)
    status.rows.set(rootB, { id: rootB, state: 'running' })
    launch(h, rootB)
    const current = settle(h)
    for (const send of held) send()
    await flush()
    assert.equal((await drive(t, current, 3_000)).done, false, 'the replacement owner keeps waiting')
    assert.deepEqual(failures(h), [], 'stale RPC or validation failure has no authority')
    status.rows.get(rootB)!.state = 'complete'
    assert.ok(isProbe((await drive(t, current, 3_000)).value), 'the replacement gets a fresh assessment')
  })
}

test('waiting draft is position-independent and acknowledges already consumed notices', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete' }])
  await foreground(h)
  launch(h, rootA)
  const probe = await drive(t, settle(h, boundary({}, [{ type: 'custom', customType: 'prior' }])), 100)
  assert.equal(probe.value.entries[0].customType, 'prior', 'earlier handler drafts are preserved')
  const draft = probe.value.entries.at(-1).content
  assert.doesNotMatch(draft, /above/, 'the notice may be consumed after the draft')
  assert.match(draft, /before or after/)
  notice(h, [rootA]) // consumed before the next draft
  const synthesis = await drive(t, settle(h), 2_000, 50)
  const again = synthesis.value.entries.at(-1).content
  assert.match(again, /already/, 'a consumed notice is acknowledged rather than awaited')
  assert.doesNotMatch(again, /above/)
})

// Stock git-main native-supervisor-channel: queued triggerTurn message, then this public bus event.
const ask = (h: ReturnType<typeof harness>, requestId: string, runId: string) =>
  h.events.emit('pi-intercom:detach-request', { requestId, runId, agent: 'worker', childIndex: 0 })
const answer = (h: ReturnType<typeof harness>, requestId: string, runId: string) =>
  h.emit('message_start', {
    message: {
      role: 'custom',
      customType: 'subagent_supervisor_request',
      content: 'question',
      details: { id: requestId, requestId, runId, agent: 'worker', childIndex: 0, expectsReply: true }
    }
  })

test('owned supervisor wake: a running child asks during the barrier, parent answers, child then finishes', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [{ id: rootA, state: 'running' }])
  await foreground(h)
  launch(h, rootA)
  const holding = settle(h, boundary({}, [{ type: 'custom', customType: 'prior' }]))
  assert.equal((await drive(t, holding, 3_000)).done, false)
  ask(h, 'req-1', rootA)
  const wake = await drive(t, holding, 1_000)
  assert.ok(isProbe(wake.value), 'an attributable supervisor request permits a native continuation')
  assert.equal(wake.value.entries[0].customType, 'prior')
  assert.match(wake.value.entries.at(-1).content, /supervisor request/)
  assert.match(wake.value.entries.at(-1).content, /req-1/)
  answer(h, 'req-1', rootA)
  reply(h)
  const next = settle(h)
  assert.equal((await drive(t, next, 45_000, 1_000)).done, false, 'consumption closes the window; child still runs')
  assert.deepEqual(failures(h), [])
  status.rows.get(rootA)!.state = 'complete'
  assert.ok(isProbe((await drive(t, next, 3_000)).value))
  notice(h, [rootA])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(status.stops, [])
})

test('supervisor wake bounds: 30 attempts at 1 second cadence, then visible 30 second failure', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [{ id: rootA, state: 'running' }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  ask(h, 'req-1', rootA)
  const probes: number[] = []
  let final: any
  for (let i = 0; i < 40; i++) {
    const result = await drive(t, settle(h), 5_000, 50)
    assert.equal(result.done, true)
    if (!isProbe(result.value)) {
      final = result
      break
    }
    probes.push(Date.now())
    if (i === 10) ask(h, 'req-1', rootA) // a duplicate cannot reset the budget or window
    reply(h)
  }
  assert.equal(probes.length, 30)
  for (let i = 1; i < probes.length; i++) assert.ok(probes[i]! - probes[i - 1]! >= 1_000)
  assert.equal(final.value, undefined)
  assert.ok(Date.now() >= 30_000 && Date.now() < 35_000, 'measured from observation; the duplicate did not extend it')
  assert.match(failures(h).at(-1).error, /supervisor request req-1 from required run .* not consumed within 30s/)
  assert.notEqual(h.updates.at(-1).state, 'idle')
  assert.deepEqual(status.stops, [])
})

test('supervisor and completion-delivery probes share one owner cadence', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [
    { id: rootA, state: 'running' },
    { id: rootB, state: 'complete' }
  ])
  await foreground(h)
  launch(h, rootA)
  launch(h, rootB)
  await flush()
  ask(h, 'req-1', rootA)
  const first = await drive(t, settle(h), 100)
  assert.ok(isProbe(first.value))
  assert.match(first.value.entries.at(-1).content, /req-1/)
  assert.match(first.value.entries.at(-1).content, new RegExp(rootB), 'one probe covers both obligations')
  const firstAt = Date.now()
  reply(h)
  assert.ok(isProbe((await drive(t, settle(h), 2_000, 50)).value))
  assert.ok(Date.now() - firstAt >= 1_000)
})

for (const shape of ['foreign', 'detached', 'stale-consumed', 'old-owner', 'cancelling', 'malformed']) {
  test(`supervisor attention without exact ownership grants no continuation: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'running' },
      { id: rootB, state: 'running' },
      { id: foreignRun, state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    launch(h, rootB)
    if (shape === 'detached') {
      ask(h, 'req-b', rootB) // opened before detach, removed with its root
      await h.tool('acp_detach', { runIds: [rootB] })
      ask(h, 'req-b2', rootB)
    }
    if (shape === 'foreign') ask(h, 'req-f', foreignRun)
    if (shape === 'stale-consumed') {
      answer(h, 'req-1', rootA) // consumed before its bus event
      ask(h, 'req-1', rootA)
    }
    if (shape === 'old-owner') {
      await foreground(h, '77777777-7777-4777-8777-777777777777')
      status.rows.set('new-root', { id: 'new-root', state: 'running' })
      launch(h, 'new-root')
      ask(h, 'req-old', rootA)
    }
    if (shape === 'malformed') {
      h.events.emit('pi-intercom:detach-request', { runId: rootA })
      h.events.emit('pi-intercom:detach-request', { requestId: 'req-x' })
    }
    const holding = settle(h)
    if (shape === 'cancelling') {
      await h.command(`cancel ${owner}`)
      ask(h, 'req-c', rootA)
      assert.deepEqual(await drive(t, holding, 100), { done: true, value: undefined })
      assert.deepEqual(status.stops.sort(), [rootA, rootB].sort())
      return
    }
    assert.equal((await drive(t, holding, 35_000, 1_000)).done, false, 'no probe and no attention deadline')
    assert.deepEqual(failures(h), [])
    assert.equal(status.rows.get(foreignRun)!.state, 'running')
  })
}

test('supervisor attention from a proven descendant opens a window; late consumption fails visibly', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [
    { id: rootA, state: 'complete' },
    { id: 'child-run', state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  await flush()
  notice(h, [promoted(rootA, 'child-run')])
  reply(h)
  const holding = settle(h)
  assert.equal((await drive(t, holding, 2_000)).done, false)
  ask(h, 'req-d', 'child-run')
  assert.ok(isProbe((await drive(t, holding, 1_000)).value), 'descendant attention is owned through its root')
  t.mock.timers.tick(31_000) // slow provider: the queued request is consumed after the window
  await flush()
  answer(h, 'req-d', 'child-run')
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.match(failures(h).at(-1)?.error ?? '', /supervisor request req-d .*30s/)
})

// git-main explicit async workflow child: dispatch notice maps runId to workflowKey; the child's own native notice follows later.
const wfChild = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const dispatch = (
  h: ReturnType<typeof harness>,
  childRuns: unknown[] = [{ runId: wfChild, workflowKey: 'child', status: 'running' }]
) => notice(h, [{ runId: rootA, workflowRunId: rootA, agent: 'workflow', status: 'completed', childRuns }])
const folded = (extra: Record<string, unknown> = {}) => ({
  id: 'child',
  kind: 'step',
  state: 'complete',
  startedAt: 1,
  endedAt: 2,
  ...extra
})
let toolCalls = 0
const collect = (
  h: ReturnType<typeof harness>,
  id: string,
  result: Record<string, unknown> = {},
  toolName = 'bg_wait'
) => {
  const toolCallId = `call-${++toolCalls}`
  const input = toolName === 'bg_wait' ? { id } : { action: 'status', id }
  h.emit('tool_call', { toolName, toolCallId, input })
  return () =>
    h.emit('tool_result', {
      toolName,
      toolCallId,
      input,
      isError: false,
      details: {
        mode: 'management',
        results: [],
        completions: [
          { runId: id, state: 'complete', success: true, results: [{ success: true, outputState: 'present' }] }
        ]
      },
      ...result
    })
}
async function workflowBarrier(t: any, h: ReturnType<typeof harness>, status: ReturnType<typeof host>) {
  await foreground(h)
  launch(h, rootA)
  await flush()
  dispatch(h)
  reply(h)
  const holding = settle(h)
  assert.equal((await drive(t, holding, 2_000)).done, false, 'the promoted live child holds')
  status.rows.delete(wfChild)
  status.rows.get(rootA)!.children = [folded()]
  return { holding } // a bare pending promise would be adopted by this async function
}

test('workflow dispatch child: an exact post-terminal bg_wait result never substitutes for its native notice', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete', kind: 'workflow' },
    { id: wfChild, state: 'running', kind: 'subagent' }
  ])
  const { holding } = await workflowBarrier(t, h, status)
  const probe = await drive(t, holding, 3_000)
  assert.ok(isProbe(probe.value), 'the folded keyed step proves the child terminal')
  assert.doesNotMatch(probe.value.entries.at(-1).content, /bg_wait|sends no notice/)
  collect(h, wfChild)()
  reply(h)
  const stillOwed = await drive(t, settle(h), 3_000, 50)
  assert.ok(isProbe(stillOwed.value), 'collection is not delivery: the native notice is still owed')
  notice(h, [wfChild])
  const unanswered = await drive(t, settle(h), 3_000)
  assert.equal(unanswered.value?.continue, true, 'the child notice needs a later provider cycle')
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(failures(h), [])
})

for (const shape of [
  'exact-post-terminal',
  'early-query',
  'failed',
  'empty',
  'unrelated',
  'prefix',
  'missing-results',
  'status-action',
  'no-call'
]) {
  test(`status or bg_wait replies never substitute for a workflow child notice: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete', kind: 'workflow' },
      { id: wfChild, state: 'running', kind: 'subagent' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    dispatch(h)
    reply(h)
    const begun = shape === 'early-query' ? collect(h, wfChild) : undefined // started while the child still runs
    const holding = settle(h)
    assert.equal((await drive(t, holding, 2_000)).done, false)
    status.rows.delete(wfChild)
    status.rows.get(rootA)!.children = [folded()]
    assert.ok(isProbe((await drive(t, holding, 3_000)).value))
    if (begun) begun()
    else if (shape === 'exact-post-terminal') collect(h, wfChild)()
    else if (shape === 'failed') collect(h, wfChild, { isError: true })()
    else if (shape === 'empty') collect(h, wfChild, { details: { mode: 'management', results: [] } })()
    else if (shape === 'unrelated') collect(h, foreignRun)()
    else if (shape === 'prefix') {
      const id = wfChild.slice(0, 8)
      h.emit('tool_call', { toolName: 'bg_wait', toolCallId: 'prefix', input: { id } })
      h.emit('tool_result', {
        toolName: 'bg_wait',
        toolCallId: 'prefix',
        input: { id },
        details: { completions: [{ runId: wfChild, state: 'complete', results: [{ success: true }] }] }
      })
    } else if (shape === 'missing-results')
      collect(h, wfChild, {
        details: { completions: [{ runId: wfChild, state: 'complete', success: true, results: [] }] }
      })()
    else if (shape === 'status-action') collect(h, wfChild, {}, 'subagent')()
    reply(h)
    let final: any
    for (let i = 0; i < 40; i++) {
      final = await drive(t, settle(h), 5_000, 50)
      if (!isProbe(final.value)) break
      reply(h)
    }
    assert.deepEqual(final, { done: true, value: undefined })
    assert.match(
      failures(h).at(-1)?.error ?? '',
      new RegExp(`completion notice for required run ${wfChild} was not consumed within 30s`)
    )
    assert.notEqual(h.updates.at(-1).state, 'idle')
  })
}

for (const shape of [
  'duplicate-step',
  'virtual-step',
  'omitted-children',
  'parent-retention',
  'duplicate-mapping',
  'missing-key',
  'conflicting-key'
]) {
  test(`workflow child identity and terminal proof must be unique and exhaustive: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete', kind: 'workflow' },
      { id: wfChild, state: 'running', kind: 'subagent' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    const child = { runId: wfChild, workflowKey: 'child', status: 'running' }
    if (shape === 'duplicate-mapping') dispatch(h, [child, { ...child, workflowKey: 'other' }])
    else if (shape === 'missing-key') dispatch(h, [{ runId: wfChild, status: 'running' }])
    else if (shape === 'conflicting-key') {
      dispatch(h)
      dispatch(h, [{ ...child, workflowKey: 'other' }])
    } else dispatch(h)
    reply(h)
    const holding = settle(h)
    if (['duplicate-mapping', 'missing-key', 'conflicting-key'].includes(shape)) {
      assert.deepEqual(await drive(t, holding, 3_000), { done: true, value: undefined })
      assert.match(failures(h).at(-1)?.error ?? '', /workflow child/)
      return
    }
    assert.equal((await drive(t, holding, 2_000)).done, false)
    status.rows.delete(wfChild)
    const root = status.rows.get(rootA)!
    if (shape === 'duplicate-step') root.children = [folded(), folded()]
    if (shape === 'virtual-step') root.children = [{ id: 'child', kind: 'step', state: 'complete' }]
    if (shape === 'omitted-children') {
      root.children = [folded()]
      status.omitted.children = 1
    }
    if (shape === 'parent-retention') status.rows.delete(rootA)
    assert.deepEqual(await drive(t, holding, 3_000), { done: true, value: undefined })
    assert.equal(failures(h).length, 1)
    assert.notEqual(h.updates.at(-1).state, 'idle')
  })
}

test('fast workflow child already folded at first assessment still owes its native notice', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete', kind: 'workflow', children: [folded()] }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  dispatch(h)
  reply(h)
  const probe = await drive(t, settle(h), 3_000)
  assert.ok(isProbe(probe.value), 'no bypass: the undelivered fast child is probed')
  collect(h, wfChild)()
  reply(h)
  assert.ok(isProbe((await drive(t, settle(h), 3_000, 50)).value), 'collection does not bypass the notice')
  notice(h, [wfChild])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

test('bg_wait results never create ownership: foreign and detached results are ignored', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootB, state: 'running' }])
  await foreground(h)
  collect(h, foreignRun)()
  assert.equal(
    h.updates.some(update => update.state === 'active'),
    false
  )
  launch(h, rootB)
  await h.tool('acp_detach', { runIds: [rootB] })
  collect(h, rootB)()
  assert.deepEqual(await drive(t, settle(h), 100), { done: true, value: undefined })
  assert.deepEqual(failures(h), [])
})

test('an awaited workflow child whose result the workflow already delivered owes nothing more', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete', kind: 'workflow', children: [folded()] }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  dispatch(h, [{ runId: wfChild, workflowKey: 'child', status: 'completed' }])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

test("a workflow child's native completion notice after folding is its delivery", async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete', kind: 'workflow' },
    { id: wfChild, state: 'running', kind: 'subagent' }
  ])
  const { holding } = await workflowBarrier(t, h, status)
  assert.ok(isProbe((await drive(t, holding, 3_000)).value))
  notice(h, [wfChild])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

test('a stop racing runner shutdown (execution_failed) is retried within the deadline, never fatal', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  let attempts = 0
  let state = 'running'
  h.events.on('subagents:rpc:v1:request', request => {
    let body: any
    if (request.method === 'status')
      body = {
        success: true,
        data: {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            caps: { maxStringLength: 160 },
            omitted: { runs: 0, children: 0, byteLimitExceeded: false },
            runs: [{ id: rootA, state }]
          }
        }
      }
    else if (++attempts === 1)
      body = {
        success: false,
        error: {
          code: 'execution_failed',
          message: 'Runner stop inbox is closed. Retry stop after runner shutdown is observed.'
        }
      }
    else {
      state = 'stopped'
      body = { success: true, data: { runId: request.params.id } }
    }
    h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, ...body })
  })
  await foreground(h)
  launch(h, rootA)
  await h.command(`cancel ${owner}`)
  assert.equal(h.updates.at(-1).state, 'stopping', 'the shutdown race is a retryable transition')
  await h.command(`check ${owner}`)
  await h.command(`cancel ${owner}`)
  await h.command(`check ${owner}`)
  assert.equal(attempts, 2)
  assert.equal(h.updates.at(-1).state, 'cancelled')
  assert.equal(
    h.updates.some(update => update.state === 'error'),
    false
  )
})

for (const message of [
  'Runner crashed while stopping.',
  'Runner stop inbox is closed. Retry stop after runner shutdown is observed. (extra)',
  'runner stop inbox is closed. retry stop after runner shutdown is observed.',
  undefined
]) {
  test(`a root-stop execution_failed other than the closed-inbox race stays fatal: ${message ?? 'missing message'}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let stops = 0
    h.events.on('subagents:rpc:v1:request', request => {
      const body =
        request.method === 'status'
          ? {
              success: true,
              data: {
                asyncSnapshot: {
                  kind: 'pi-subagents.async-status-snapshot',
                  version: 1,
                  caps: { maxStringLength: 160 },
                  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
                  runs: [{ id: rootA, state: 'running' }]
                }
              }
            }
          : (stops++, { success: false, error: { code: 'execution_failed', ...(message ? { message } : {}) } })
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        ...body
      })
    })
    await foreground(h)
    launch(h, rootA)
    await assert.rejects(h.command(`cancel ${owner}`), /pi-subagents stop failed/)
    assert.equal(stops, 1)
    assert.equal(h.updates.at(-1).state, 'error', 'no retry authority: the control failure is visible')
    assert.equal(
      h.updates.some(update => update.state === 'cancelled'),
      false
    )
  })
}

// Round-2 R1: only the first undelivered -> delivered transition is checked against the deadline or advances the fence.
for (const target of ['root', 'descendant']) {
  test(`a late duplicate of a timely ${target} notice neither fails nor reopens delivery`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete' },
      { id: rootB, state: 'running' },
      { id: 'child-run', state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    launch(h, rootB) // keeps the barrier open beyond the delivery window
    await flush()
    const duplicate = target === 'root' ? rootA : 'child-run'
    if (target === 'root') notice(h, [rootA])
    else {
      notice(h, [promoted(rootA, 'child-run')])
      reply(h)
      status.rows.get('child-run')!.state = 'complete'
      assert.ok(isProbe((await drive(t, settle(h), 3_000)).value))
      notice(h, ['child-run'])
    }
    reply(h)
    const holding = settle(h)
    assert.equal((await drive(t, holding, 35_000, 1_000)).done, false, 'the running root holds past the window')
    notice(h, [duplicate]) // replayed after 30s
    status.rows.get(rootB)!.state = 'complete'
    assert.ok(isProbe((await drive(t, holding, 3_000)).value))
    notice(h, [rootB])
    reply(h)
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.deepEqual(failures(h), [], 'timely consumption ended that window permanently')
    assert.equal(h.updates.at(-1).state, 'idle')
  })
}

test('a timely duplicate notice does not reopen the provider-cycle fence', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [{ id: rootA, state: 'complete' }])
  await foreground(h)
  launch(h, rootA)
  await flush()
  notice(h, [rootA])
  reply(h)
  notice(h, [rootA]) // duplicate after the answering provider cycle
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

// Round-2 R2: stock v1 accounting is { runs: number; children: number; byteLimitExceeded: boolean }.
const malformedAccounting: Record<string, Record<string, unknown>> = {
  'missing-byte-limit': { runs: 0, children: 0 },
  'non-boolean-byte-limit': { runs: 0, children: 0, byteLimitExceeded: 'false' },
  'missing-runs': { children: 0, byteLimitExceeded: false },
  'missing-children': { runs: 0, byteLimitExceeded: false },
  'negative-children': { runs: 0, children: -1, byteLimitExceeded: false },
  'negative-runs': { runs: -1, children: 0, byteLimitExceeded: false },
  'fractional-children': { runs: 0, children: 0.5, byteLimitExceeded: false },
  'unsafe-runs': { runs: 2 ** 53, children: 0, byteLimitExceeded: false },
  'byte-limit-exceeded': { runs: 0, children: 0, byteLimitExceeded: true }
}
for (const [shape, omitted] of Object.entries(malformedAccounting)) {
  for (const target of ['root', 'descendant', 'folded']) {
    test(`malformed omission accounting cannot yield first ${target} terminal proof: ${shape}`, async t => {
      timers(t)
      const h = harness()
      t.after(() => h.emit('session_shutdown'))
      const status = host(h, [
        { id: rootA, state: target === 'root' ? 'running' : 'complete', kind: 'workflow' },
        { id: wfChild, state: 'running', kind: 'subagent' }
      ])
      await foreground(h)
      launch(h, rootA)
      await flush()
      if (target === 'descendant') notice(h, [promoted(rootA, wfChild)])
      if (target === 'folded') dispatch(h)
      if (target !== 'root') reply(h)
      const holding = settle(h)
      assert.equal((await drive(t, holding, 2_000)).done, false)
      status.omitted = omitted
      if (target === 'root') status.rows.get(rootA)!.state = 'complete'
      else if (target === 'descendant') status.rows.get(wfChild)!.state = 'complete'
      else {
        status.rows.delete(wfChild)
        status.rows.get(rootA)!.children = [folded()]
      }
      const result = await drive(t, holding, 3_000)
      assert.deepEqual(result, { done: true, value: undefined }, 'no probe: terminal proof was not established')
      assert.equal(failures(h).length, 1)
      assert.notEqual(h.updates.at(-1).state, 'idle')
    })
  }
}

// Round-2 R3: stock notify childStatus statuses are running/completed/failed/paused/stopped/detached.
for (const [shape, childRuns] of Object.entries({
  'non-array': { runId: 'child-run', status: 'running' },
  'null-collection': null,
  'null-row': [null],
  'string-row': ['child-run'],
  'missing-status': [{ runId: 'child-run' }],
  'snapshot-label': [{ runId: 'child-run', status: 'complete' }],
  'unknown-status': [{ runId: 'child-run', status: 'queued' }]
} as Record<string, unknown>)) {
  test(`malformed notice child metadata fails closed instead of releasing: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete' },
      { id: 'child-run', state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    notice(h, [{ runId: rootA, status: 'completed', childRuns }])
    reply(h)
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.match(failures(h).at(-1)?.error ?? '', /child run metadata/)
    assert.notEqual(h.updates.at(-1).state, 'idle')
    assert.deepEqual(status.stops, [])
  })
}

for (const [shape, childRuns] of Object.entries({
  absent: undefined,
  empty: [],
  completed: [{ runId: 'child-done', status: 'completed' }],
  'terminal-unavailable': [{ runId: 'unavailable', workflowKey: 'k', status: 'failed' }],
  stopped: [{ runId: 'child-done', status: 'stopped' }],
  paused: [{ runId: 'child-done', status: 'paused' }]
} as Record<string, unknown>)) {
  test(`legitimate no-live-child notice metadata releases normally: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [{ id: rootA, state: 'complete' }])
    await foreground(h)
    launch(h, rootA)
    await flush()
    notice(h, [{ runId: rootA, status: 'completed', ...(childRuns === undefined ? {} : { childRuns }) }])
    reply(h)
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.deepEqual(failures(h), [])
    assert.equal(h.updates.at(-1).state, 'idle')
  })
}

// Round-2 R4: consumption closes an episode only with its exact requestId and stored runId.
const answerAs = (h: ReturnType<typeof harness>, requestId: string, details: Record<string, unknown>) =>
  h.emit('message_start', {
    message: {
      role: 'custom',
      customType: 'subagent_supervisor_request',
      content: 'question',
      details: { id: requestId, requestId, agent: 'worker', childIndex: 0, expectsReply: true, ...details }
    }
  })
for (const shape of ['missing-run', 'foreign-run', 'other-owned-run']) {
  test(`supervisor consumption with ${shape} attribution does not close the owned episode`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [
      { id: rootA, state: 'running' },
      { id: rootB, state: 'running' },
      { id: foreignRun, state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    launch(h, rootB)
    await flush()
    ask(h, 'req-1', rootA)
    assert.ok(isProbe((await drive(t, settle(h), 1_000)).value))
    answerAs(h, 'req-1', shape === 'missing-run' ? {} : { runId: shape === 'foreign-run' ? foreignRun : rootB })
    reply(h)
    let final: any
    for (let i = 0; i < 40; i++) {
      final = await drive(t, settle(h), 5_000, 50)
      if (!isProbe(final.value)) break
      reply(h)
    }
    assert.deepEqual(final, { done: true, value: undefined })
    assert.match(
      failures(h).at(-1)?.error ?? '',
      /supervisor request req-1 from required run .* not consumed within 30s/
    )
  })

  test(`pre-wake supervisor consumption with ${shape} attribution cannot suppress the genuine wake`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    host(h, [
      { id: rootA, state: 'running' },
      { id: rootB, state: 'running' }
    ])
    await foreground(h)
    launch(h, rootA)
    launch(h, rootB)
    await flush()
    answerAs(h, 'req-1', shape === 'missing-run' ? {} : { runId: shape === 'foreign-run' ? foreignRun : rootB })
    ask(h, 'req-1', rootA)
    const wake = await drive(t, settle(h), 1_000)
    assert.ok(isProbe(wake.value), 'the genuine owned request still opens its episode')
    answer(h, 'req-1', rootA)
    reply(h)
    assert.equal((await drive(t, settle(h), 35_000, 1_000)).done, false, 'exact consumption closes it; roots run')
    assert.deepEqual(failures(h), [])
  })
}

// Round-3 R6: a child notice consumed before its owned dispatch exposes lineage is candidate evidence only.
const wfRoot = (childRuns: unknown[] = [{ runId: wfChild, workflowKey: 'child', status: 'running' }]) => ({
  runId: rootA,
  workflowRunId: rootA,
  agent: 'workflow',
  status: 'completed',
  childRuns
})
for (const order of ['separate-early', 'grouped-reversed']) {
  test(`a workflow child notice consumed before dispatch lineage is delivery once exactly mapped: ${order}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete', kind: 'workflow' },
      { id: wfChild, state: 'complete', kind: 'subagent' }
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    const before = status.statusCount
    if (order === 'separate-early') {
      notice(h, [wfChild])
      assert.equal(h.updates.filter(update => update.state === 'active').length, 1, 'candidate evidence adopts nothing')
      t.mock.timers.tick(5_000)
      await flush()
      assert.equal(status.statusCount - before <= 6, true)
      notice(h, [wfRoot()])
    } else notice(h, [{ runId: wfChild, status: 'completed' }, wfRoot()])
    const unanswered = await drive(t, settle(h), 3_000)
    assert.equal(unanswered.value?.continue, true, 'the provider fence still follows the consumed notices')
    reply(h)
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.equal(h.updates.at(-1).state, 'idle', 'no second child notice is required')
    assert.deepEqual(failures(h), [])
  })
}

test('an early child notice answered before dispatch still needs a reply after the later dispatch notice', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  host(h, [
    { id: rootA, state: 'complete', kind: 'workflow' },
    { id: wfChild, state: 'complete', kind: 'subagent' }
  ])
  await foreground(h)
  launch(h, rootA)
  await flush()
  notice(h, [wfChild])
  reply(h) // provider cycle after the early candidate, before dispatch
  notice(h, [wfRoot()])
  const unanswered = await drive(t, settle(h), 3_000)
  assert.equal(
    unanswered.value?.continue,
    true,
    'the fence follows the later dispatch notice, not the earlier candidate'
  )
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
  assert.deepEqual(failures(h), [])
})

test('an early child notice keeps its own lineage once associated', async t => {
  timers(t)
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  const status = host(h, [
    { id: rootA, state: 'complete', kind: 'workflow' },
    { id: wfChild, state: 'complete', kind: 'subagent' },
    { id: 'grand-run', state: 'running' }
  ])
  await foreground(h)
  launch(h, rootA)
  await flush()
  notice(h, [{ runId: wfChild, status: 'completed', childRuns: [{ runId: 'grand-run', status: 'running' }] }])
  notice(h, [wfRoot()])
  reply(h)
  const holding = settle(h)
  assert.equal(
    (await drive(t, holding, 3_000)).done,
    false,
    'the live descendant reported by the early notice is required'
  )
  status.rows.get('grand-run')!.state = 'complete'
  assert.ok(isProbe((await drive(t, holding, 3_000)).value))
  notice(h, ['grand-run'])
  reply(h)
  assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
  assert.equal(h.updates.at(-1).state, 'idle')
})

for (const shape of ['stale-owner', 'foreign-scope', 'unmapped']) {
  test(`candidate child-notice evidence grants no delivery, ownership or control: ${shape}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete', kind: 'workflow' },
      { id: wfChild, state: 'running', kind: 'subagent' }
    ])
    if (shape === 'stale-owner') {
      await foreground(h)
      notice(h, [wfChild]) // consumed under a previous owner
      await foreground(h, '77777777-7777-4777-8777-777777777777')
    } else {
      await foreground(h)
      if (shape === 'foreign-scope') {
        h.ctx.sessionManager.getSessionId = () => 'other'
        notice(h, [wfChild])
        h.ctx.sessionManager.getSessionId = () => 'session'
      }
    }
    launch(h, rootA)
    await flush()
    if (shape === 'unmapped') {
      notice(h, [wfChild])
      await assert.rejects(h.tool('acp_detach', { runIds: [wfChild] }), /nothing was detached/)
      await h.command(`cancel ${h.updates.at(-1).owner}`)
      assert.deepEqual(status.stops, [], 'no stop authority over unmapped candidate evidence')
      return
    }
    notice(h, [wfRoot()])
    reply(h)
    status.rows.get(wfChild)!.state = 'complete'
    const probe = await drive(t, settle(h), 3_000)
    assert.ok(isProbe(probe.value), 'the child notice is still owed')
    assert.deepEqual(failures(h), [])
  })
}

// Round-3 R7: attention is stored and looked up by the same (requestId, runId) pair as dedupe.
for (const shape of ['root-descendant', 'siblings']) {
  for (const answered of ['first', 'second']) {
    test(`colliding supervisor request IDs keep separate episodes (${shape}, answer ${answered})`, async t => {
      timers(t)
      const h = harness()
      t.after(() => h.emit('session_shutdown'))
      host(h, [
        { id: rootA, state: 'complete' },
        { id: 'child-a', state: 'running' },
        { id: 'child-b', state: 'running' }
      ])
      await foreground(h)
      launch(h, rootA)
      await flush()
      notice(h, [
        {
          runId: rootA,
          status: 'completed',
          childRuns: [
            { runId: 'child-a', status: 'running' },
            { runId: 'child-b', status: 'running' }
          ]
        }
      ])
      reply(h)
      const [first, second] = shape === 'siblings' ? ['child-a', 'child-b'] : [rootA, 'child-a']
      ask(h, 'req-same', first)
      ask(h, 'req-same', second)
      const consumed = answered === 'first' ? first : second
      const open = answered === 'first' ? second : first
      answer(h, 'req-same', consumed)
      let final: any
      for (let i = 0; i < 40; i++) {
        final = await drive(t, settle(h), 5_000, 50)
        if (!isProbe(final.value)) break
        reply(h)
      }
      assert.deepEqual(final, { done: true, value: undefined })
      assert.match(
        failures(h).at(-1)?.error ?? '',
        new RegExp(`supervisor request req-same from required run ${open} was not consumed within 30s`)
      )
    })
  }
}

// P2 pins: a detached child row is live until visible terminal proof and its own notice; absent row fails visibly.
for (const visible of [true, false]) {
  test(`a detached notice child is required work: ${visible ? 'visible row and own notice' : 'absent row fails'}`, async t => {
    timers(t)
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    const status = host(h, [
      { id: rootA, state: 'complete' },
      ...(visible ? [{ id: 'child-run', state: 'running' }] : [])
    ])
    await foreground(h)
    launch(h, rootA)
    await flush()
    notice(h, [{ runId: rootA, status: 'completed', childRuns: [{ runId: 'child-run', status: 'detached' }] }])
    reply(h)
    const holding = settle(h)
    if (!visible) {
      assert.deepEqual(await drive(t, holding, 3_000), { done: true, value: undefined })
      assert.match(failures(h).at(-1)?.error ?? '', /descendant child-run .* not visible in status/)
      return
    }
    assert.equal((await drive(t, holding, 3_000)).done, false)
    status.rows.get('child-run')!.state = 'complete'
    assert.ok(isProbe((await drive(t, holding, 3_000)).value))
    notice(h, ['child-run'])
    reply(h)
    assert.deepEqual(await drive(t, settle(h), 3_000), { done: true, value: undefined })
    assert.equal(h.updates.at(-1).state, 'idle')
  })
}
