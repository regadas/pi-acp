import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, type StopReason } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import type { SessionUpdateMsg } from '../helpers/fakes.js'
import { asAgentConn, FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

const WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
const omitted = { runs: 0, children: 0, byteLimitExceeded: false }

let widgetId = 0

function widget(payload?: unknown) {
  return {
    type: 'extension_ui_request',
    id: `subagent-widget-${widgetId++}`,
    method: 'setWidget',
    widgetKey: 'subagent-async',
    ...(payload === undefined ? {} : { widgetLines: [`${WIDGET_PREFIX}${JSON.stringify(payload)}`] })
  }
}

function snapshot(runs: unknown[], snapshotOmitted: unknown = omitted) {
  return { kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: 1, omitted: snapshotOmitted, runs }
}

type NodeSpec = { id: string; kind?: string; state?: string; label?: string } & Record<string, unknown>

function node(spec: NodeSpec) {
  return { kind: 'subagent', state: 'running', label: `label-${spec.id}`, ...spec }
}

function harness(subagents: boolean) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    ...(subagents ? { supportsSubagentUpdates: true } : {})
  })
  return { conn, proc, session }
}

const subagentUpdates = (conn: FakeAgentSideConnection) =>
  conn.updates
    .map(update => update.update)
    .filter((update): update is Extract<SessionUpdateMsg['update'], { sessionUpdate: 'subagent_update' }> => {
      const kind = (update as { sessionUpdate?: string }).sessionUpdate
      return kind === 'subagent_update'
    })

const sessionMessages = (conn: FakeAgentSideConnection) =>
  conn.updates
    .map(update => update.update)
    .filter((update): update is Extract<SessionUpdateMsg['update'], { sessionUpdate: 'session_message' }> => {
      const kind = (update as { sessionUpdate?: string }).sessionUpdate
      return kind === 'session_message'
    })

const asSubagentUpdate = (update: SessionUpdateMsg['update']) =>
  update as Extract<SessionUpdateMsg['update'], { sessionUpdate: 'subagent_update' }>
const asSessionMessage = (update: SessionUpdateMsg['update']) =>
  update as Extract<SessionUpdateMsg['update'], { sessionUpdate: 'session_message' }>

/** Start a turn that owns pi's run: prompt accepted, agent_start attributed. */
function ownedTurn(proc: FakePiRpcProcess, session: PiAcpSession, message = 'go'): Promise<StopReason> {
  const turn = session.prompt(message)
  proc.emit({ type: 'agent_start' })
  return turn
}

test('subagent widgets are invisible without the negotiated capability', async () => {
  const { conn, proc, session } = harness(false)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'run-1' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(subagentUpdates(conn).length, 0)
  assert.equal(sessionMessages(conn).length, 0)
})

test('every node state maps onto the ACP state table', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(
    widget(
      snapshot([
        node({ id: 'queued', state: 'queued' }),
        node({ id: 'running', state: 'running' }),
        node({ id: 'paused', state: 'paused' }),
        node({ id: 'complete', state: 'complete' }),
        node({ id: 'failed', state: 'failed' }),
        node({ id: 'partial', state: 'partial' }),
        node({ id: 'rejected', state: 'rejected' }),
        node({ id: 'stopped', state: 'stopped' })
      ])
    )
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.title !== undefined)
      .map(update => [update.sessionId, update.state]),
    [
      ['queued', { state: 'running' }],
      ['running', { state: 'running' }],
      ['paused', { state: 'running' }],
      ['complete', { state: 'idle', stopReason: 'end_turn' }],
      ['failed', { state: 'idle', stopReason: 'error' }],
      ['partial', { state: 'idle', stopReason: 'error' }],
      ['rejected', { state: 'idle', stopReason: 'error' }],
      ['stopped', { state: 'idle', stopReason: 'cancelled' }]
    ]
  )
})

test('announcements carry title, description, no cancel capability and snapshot meta', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(
    widget(
      snapshot(
        [
          node({
            id: 'researcher',
            kind: 'subagent',
            agent: 'researcher',
            model: 'model-x',
            thinking: 'high',
            activity: { currentTool: 'read' }
          }),
          node({ id: 'bare', kind: 'step', activity: { state: 'waiting' } })
        ],
        { runs: 1, children: 2, byteLimitExceeded: true }
      )
    )
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  const updates = subagentUpdates(conn)
  const announced = updates.filter(update => update.title !== undefined)
  assert.equal(announced.length, 2)
  assert.deepEqual(announced[0], {
    sessionUpdate: 'subagent_update',
    sessionId: 'researcher',
    title: 'label-researcher',
    description: 'subagent · researcher · model-x · thinking high · tool read',
    capabilities: {},
    state: { state: 'running' },
    _meta: {
      piSubagents: {
        kind: 'subagent',
        parentId: null,
        omitted: { runs: 1, children: 2, byteLimitExceeded: true }
      }
    }
  })
  assert.deepEqual(announced[1], {
    sessionUpdate: 'subagent_update',
    sessionId: 'bare',
    title: 'label-bare',
    description: 'step · waiting',
    capabilities: {},
    state: { state: 'running' },
    _meta: {
      piSubagents: {
        kind: 'step',
        parentId: null,
        omitted: { runs: 1, children: 2, byteLimitExceeded: true }
      }
    }
  })
})

test('tree recursion announces nested children and skips host-step subtrees', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(
    widget(
      snapshot([
        node({
          id: 'workflow-1',
          kind: 'workflow',
          state: 'running',
          children: [
            node({ id: 'step-1', kind: 'step', state: 'complete' }),
            node({
              id: 'monitor',
              kind: 'host-step',
              children: [node({ id: 'inside-host', kind: 'subagent' })]
            }),
            node({ id: 'nested-run', kind: 'subagent', state: 'queued' })
          ]
        })
      ])
    )
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.title !== undefined)
      .map(update => [update.sessionId, update._meta?.piSubagents ?? null]),
    [
      ['workflow-1', { kind: 'workflow', parentId: null, omitted }],
      ['step-1', { kind: 'step', parentId: 'workflow-1', omitted }],
      ['nested-run', { kind: 'subagent', parentId: 'workflow-1', omitted }]
    ]
  )
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.title === undefined)
      .map(update => [update.sessionId, update.state]),
    [
      ['workflow-1', { state: 'unknown' }],
      ['nested-run', { state: 'unknown' }]
    ],
    'the settle flush unknowns the still-running children'
  )
})

test('a child gets exactly one session_message per turn and a fresh one next turn', async () => {
  const { conn, proc, session } = harness(true)
  const first = ownedTurn(proc, session, 'first')
  proc.emit(widget(snapshot([node({ id: 'run-1', label: 'Research' })])))
  await tick()
  // Protocol ordering MUST: the child's announcement update precedes the
  // session_message naming the child, so clients can render the card.
  const indexOf = (predicate: (update: SessionUpdateMsg['update']) => boolean) =>
    conn.updates.findIndex(entry => predicate(entry.update))
  const announceIndex = indexOf(
    update =>
      (update as { sessionUpdate?: string }).sessionUpdate === 'subagent_update' &&
      (update as { sessionId?: string }).sessionId === 'run-1'
  )
  const messageIndex = indexOf(
    update =>
      (update as { sessionUpdate?: string }).sessionUpdate === 'session_message' &&
      (update as { recipientSessionId?: string }).recipientSessionId === 'run-1'
  )
  assert.ok(announceIndex >= 0, 'the child was announced')
  assert.ok(messageIndex > announceIndex, 'the session_message follows its child announcement')
  proc.emit(widget(snapshot([node({ id: 'run-1', label: 'Research', state: 'complete' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  let messages = sessionMessages(conn)
  assert.equal(messages.length, 1)
  const firstMessage = asSessionMessage(messages[0])
  assert.ok(firstMessage.messageId, 'message ids must be non-empty strings')
  assert.equal(firstMessage.senderSessionId, 's')
  assert.equal(firstMessage.recipientSessionId, 'run-1')
  assert.deepEqual(firstMessage.content, [{ type: 'text', text: 'Research' }])

  const second = ownedTurn(proc, session, 'second')
  proc.emit(widget(snapshot([node({ id: 'run-1', label: 'Research' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
  messages = sessionMessages(conn)
  assert.equal(messages.length, 2)
  assert.equal(asSessionMessage(messages[1]).recipientSessionId, 'run-1')
  assert.notEqual(asSessionMessage(messages[1]).messageId, asSessionMessage(messages[0]).messageId)
})

test('a child that disappears and reappears within one turn is messaged only once', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'a' })])))
  proc.emit(widget(snapshot([])))
  proc.emit(widget(snapshot([node({ id: 'a' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(sessionMessages(conn).length, 1, 'the reappearance does not message the child twice')
  assert.deepEqual(
    subagentUpdates(conn).map(update => [update.sessionId, update.state]),
    [
      ['a', { state: 'running' }],
      ['a', { state: 'unknown' }],
      ['a', { state: 'running' }],
      ['a', { state: 'unknown' }]
    ]
  )
})

test('replacement sessions sharing an ACP session id never reuse a message id', async () => {
  const first = harness(true)
  const firstTurn = ownedTurn(first.proc, first.session)
  first.proc.emit(widget(snapshot([node({ id: 'shared' })])))
  first.proc.emit({ type: 'agent_settled' })
  assert.equal(await firstTurn, 'end_turn')

  // A later prompt on an unavailable subprocess transparently restores a
  // replacement session under the same ACP session id; its transcript upserts
  // are keyed by messageId, so a reused id would overwrite the earlier card.
  const second = harness(true)
  const secondTurn = ownedTurn(second.proc, second.session)
  second.proc.emit(widget(snapshot([node({ id: 'shared' })])))
  second.proc.emit({ type: 'agent_settled' })
  assert.equal(await secondTurn, 'end_turn')

  const messageIds = [first.conn, second.conn].flatMap(conn => sessionMessages(conn)).map(message => message.messageId)
  assert.equal(messageIds.length, 2)
  assert.notEqual(messageIds[0], messageIds[1])
})

test('settling the turn flushes only running children to unknown', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'still-running' }), node({ id: 'done', state: 'complete' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  const updates = subagentUpdates(conn)
  assert.deepEqual(updates.at(-1), {
    sessionUpdate: 'subagent_update',
    sessionId: 'still-running',
    state: { state: 'unknown' }
  })
  assert.equal(updates.filter(update => update.sessionId === 'still-running').length, 2, 'announce then unknown')
  assert.equal(
    updates.some(update => update.sessionId === 'done' && update.state?.state === 'unknown'),
    false,
    'an already idle child is not flushed'
  )
})

test('a child leaving the snapshot becomes unknown, never idle', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'vanishing' }), node({ id: 'staying' })])))
  proc.emit(widget(snapshot([node({ id: 'staying', state: 'complete' })])))
  await tick()
  // The disappearance itself (not the later settle) produced the unknown.
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.sessionId === 'vanishing')
      .map(update => update.state),
    [{ state: 'running' }, { state: 'unknown' }]
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  const vanishing = subagentUpdates(conn).filter(update => update.sessionId === 'vanishing')
  // The settled turn must not flush the already-untracked child again.
  assert.equal(vanishing.length, 2)
})

test('a completed child that later disappears keeps its idle state', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'finished', state: 'complete' })])))
  await tick()
  proc.emit(widget(snapshot([node({ id: 'other' })])))
  await tick()
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.sessionId === 'finished')
      .map(update => update.state),
    [{ state: 'idle', stopReason: 'end_turn' }],
    'the disappearance does not downgrade a completed child'
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    subagentUpdates(conn)
      .filter(update => update.sessionId === 'finished')
      .map(update => update.state),
    [{ state: 'idle', stopReason: 'end_turn' }],
    'settle does not resurrect the untracked completed child either'
  )
})

test('a cleared widget unknowns every tracked child', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'run-1' })])))
  proc.emit(widget())
  await tick()
  // The clear itself (not the later settle) unknowns the child.
  assert.deepEqual(
    subagentUpdates(conn).map(update => [update.sessionId, update.state]),
    [
      ['run-1', { state: 'running' }],
      ['run-1', { state: 'unknown' }]
    ]
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    subagentUpdates(conn).map(update => [update.sessionId, update.state]),
    [
      ['run-1', { state: 'running' }],
      ['run-1', { state: 'unknown' }]
    ],
    'settle adds nothing once the child is untracked'
  )
})

test('malformed payloads keep current tracking and stay silent', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget({ kind: 'pi-subagents.async-status-snapshot', version: 2, runs: [] }))
  await tick()
  assert.equal(subagentUpdates(conn).length, 0, 'a wrong-version payload emits nothing')
  proc.emit(widget(snapshot([node({ id: 'trusted' })])))
  await tick()
  assert.equal(subagentUpdates(conn).length, 1, 'the valid snapshot announced its child')
  proc.emit(widget({ kind: 'pi-subagents.async-status-snapshot', version: 2, runs: [] }))
  await tick()
  assert.equal(subagentUpdates(conn).length, 1, 'a wrong-version payload after tracking emits nothing')
  proc.emit({
    type: 'extension_ui_request',
    id: 'raw',
    method: 'setWidget',
    widgetKey: 'subagent-async',
    widgetLines: [`${WIDGET_PREFIX}{not json`]
  })
  await tick()
  assert.equal(subagentUpdates(conn).length, 1, 'a broken JSON payload emits nothing')
  proc.emit({
    type: 'extension_ui_request',
    id: 'foreign',
    method: 'setWidget',
    widgetKey: 'subagent-async',
    widgetLines: ['plain text']
  })
  await tick()
  assert.equal(subagentUpdates(conn).length, 1, 'an unprefixed payload emits nothing')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  // The malformed events never cleared tracking: the running child is still
  // flushed to unknown at settlement.
  assert.deepEqual(
    subagentUpdates(conn).map(update => [update.sessionId, update.state]),
    [
      ['trusted', { state: 'running' }],
      ['trusted', { state: 'unknown' }]
    ]
  )
})

test('a failed turn flushes its running children to unknown', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(widget(snapshot([node({ id: 'doomed' })])))
  await tick()
  assert.equal(subagentUpdates(conn).length, 1, 'the child was announced before the failure')
  proc.emitTermination()
  await assert.rejects(turn)
  await tick()
  assert.deepEqual(
    subagentUpdates(conn).at(-1),
    {
      sessionUpdate: 'subagent_update',
      sessionId: 'doomed',
      state: { state: 'unknown' }
    },
    'the failure path flushes the running child to unknown'
  )
})

test('out-of-band widgets are ignored', async () => {
  const { conn, proc, session } = harness(true)
  // No pending turn at all.
  proc.emit(widget(snapshot([node({ id: 'orphan' })])))
  // An autonomous run the turn does not own: the staged prompt defers.
  proc.emit({ type: 'agent_start' })
  const turn = session.prompt('held back')
  await tick()
  proc.emit(widget(snapshot([node({ id: 'foreign' })])))
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(subagentUpdates(conn).length, 0)
  // Once the turn owns pi's run, the same widget announces its children.
  proc.emit(widget(snapshot([node({ id: 'owned' })])))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(subagentUpdates(conn).length, 2)
  assert.equal(asSubagentUpdate(subagentUpdates(conn)[0]).sessionId, 'owned')
})

test('invalid nodes are skipped without dropping their valid siblings', async () => {
  const { conn, proc, session } = harness(true)
  const turn = ownedTurn(proc, session)
  proc.emit(
    widget(
      snapshot([
        { id: 'bad-state', kind: 'subagent', state: 'exploded', label: 'bad' },
        node({ id: 'good', state: 'complete' }),
        'not-a-node'
      ])
    )
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    subagentUpdates(conn).map(update => update.sessionId),
    ['good']
  )
})
