import test from 'node:test'
import assert from 'node:assert/strict'
import { replaySessionHistory } from '../../src/acp/history-replay.js'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { asAgentConn, FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: '/tmp',
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const replay = () =>
    replaySessionHistory({
      session,
      cwd: '/tmp',
      supportsTerminalOutputMeta: false,
      assertActive() {},
      sendUpdate: update => session.sendSessionUpdate(update)
    })
  const texts = () =>
    conn.updates.flatMap(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
    )
  return { conn, proc, session, replay, texts }
}

const customMessage = {
  role: 'custom',
  customType: 'background-task',
  display: true,
  content: [
    { type: 'image', data: 'aW1n', mimeType: 'image/png' },
    { type: 'text', text: 'Repeated note' }
  ],
  details: { source: 'extension' },
  timestamp: 1
}

function history(count: number) {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      type: 'custom_message',
      id: `e${index}`,
      parentId: index === 0 ? null : `e${index - 1}`,
      customType: customMessage.customType,
      display: true,
      content: customMessage.content,
      details: customMessage.details,
      timestamp: new Date(customMessage.timestamp).toISOString()
    })),
    leafId: count ? `e${count - 1}` : null
  }
}

for (const [liveCount, historyCount] of [
  [1, 1],
  [2, 3],
  [3, 2]
]) {
  test(`load custom messages reconcile ${liveCount} live occurrences with ${historyCount} history occurrences`, async () => {
    const { conn, proc, session, replay, texts } = harness()
    proc.getEntries = async beforeResponseResolve => {
      proc.emit({ type: 'agent_start' })
      for (let index = 0; index < liveCount; index++) proc.emit({ type: 'message_end', message: customMessage })
      await tick()
      assert.equal(texts().length, liveCount, 'autonomous output is already published before the snapshot response')
      beforeResponseResolve?.()
      return history(historyCount)
    }
    try {
      await replay()
      assert.equal(
        texts().length,
        Math.max(liveCount, historyCount),
        'overlap consumes occurrences, not all equal messages'
      )
      const images = conn.updates.filter(
        ({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image'
      )
      assert.equal(
        images.length,
        Math.max(liveCount, historyCount),
        'image blocks are not replayed a second time either'
      )
    } finally {
      session.dispose()
    }
  })
}

for (const delivery of ['autonomous-flush', 'adapter-flush', 'live-and-buffered']) {
  test(`load custom messages reconcile buffered and live occurrences: ${delivery}`, async () => {
    const { proc, session, replay, texts } = harness()
    proc.getEntries = async beforeResponseResolve => {
      if (delivery === 'live-and-buffered') {
        proc.emit({ type: 'agent_start' })
        proc.emit({ type: 'message_end', message: customMessage })
        proc.emit({ type: 'agent_settled' })
        proc.emit({ type: 'message_end', message: customMessage })
      } else {
        proc.emit({ type: 'message_end', message: customMessage })
        if (delivery === 'autonomous-flush') {
          proc.emit({ type: 'agent_start' })
          proc.emit({ type: 'message_end', message: customMessage })
        } else {
          const finish = session.beginAdapterPromptTurn()
          proc.emit({ type: 'message_end', message: customMessage })
          await finish()
        }
      }
      beforeResponseResolve?.()
      return history(3)
    }
    try {
      await replay()
      assert.equal(texts().length, 3)
      const finish = session.beginAdapterPromptTurn()
      await finish()
      assert.equal(texts().length, 3, 'reconciled buffered messages cannot leak into the next prompt')
    } finally {
      session.dispose()
    }
  })
}

test('load custom-message reconciliation preserves unmatched buffered output and post-boundary duplicates', async () => {
  const { proc, session, replay, texts } = harness()
  proc.getEntries = async beforeResponseResolve => {
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_end', message: customMessage })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Unrelated live text' } })
    await tick()
    proc.emit({ type: 'agent_settled' })
    proc.emit({ type: 'message_end', message: { ...customMessage, content: 'Unmatched buffered note' } })
    proc.emit({ type: 'extension_error', extensionPath: '/tmp/extension.ts', event: 'background', error: 'diagnostic' })
    beforeResponseResolve?.()
    proc.emit({ type: 'message_end', message: customMessage })
    return history(1)
  }
  try {
    await replay()
    assert.deepEqual(texts(), ['Repeated note', 'Unrelated live text'])
    const finish = session.beginAdapterPromptTurn()
    await finish()
    assert.deepEqual(texts(), [
      'Repeated note',
      'Unrelated live text',
      'Unmatched buffered note',
      'Deferred pi extension error (/tmp/extension.ts, background): diagnostic',
      'Repeated note'
    ])
  } finally {
    session.dispose()
  }
})

test('load custom-message reconciliation does not consume identical live messages after the response boundary', async () => {
  const { proc, session, replay, texts } = harness()
  proc.getEntries = async beforeResponseResolve => {
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'message_end', message: customMessage })
    beforeResponseResolve?.()
    proc.emit({ type: 'message_end', message: customMessage })
    return history(1)
  }
  try {
    await replay()
    await tick()
    assert.deepEqual(texts(), ['Repeated note', 'Repeated note'])
  } finally {
    session.dispose()
  }
})

for (const failSnapshot of [false, true]) {
  test(`load custom-message replays stay isolated after a ${failSnapshot ? 'failed' : 'successful'} snapshot`, async () => {
    const { proc, session, replay, texts } = harness()
    proc.getEntries = async beforeResponseResolve => {
      proc.emit({ type: 'agent_start' })
      proc.emit({ type: 'message_end', message: customMessage })
      beforeResponseResolve?.()
      if (failSnapshot) throw new Error('snapshot failed')
      return history(1)
    }
    try {
      if (failSnapshot) await assert.rejects(replay(), /snapshot failed/)
      else await replay()
      proc.emit({ type: 'message_end', message: customMessage })
      await tick()
      const beforeReplay = texts().length
      proc.getEntries = async beforeResponseResolve => {
        beforeResponseResolve?.()
        return history(1)
      }
      await replay()
      assert.equal(
        texts().length,
        beforeReplay + 1,
        'a later replay does not consume publications outside its own snapshot window'
      )
    } finally {
      session.dispose()
    }
  })
}

for (const delivery of ['live', 'buffered']) {
  for (const failedBlock of ['image', 'text']) {
    test(`load rejects a failed ${failedBlock} block from an overlapping ${delivery} custom message`, async () => {
      const { conn, proc, session, replay } = harness()
      const attempted: string[] = []
      conn.sessionUpdate = async msg => {
        const update = msg.update
        if (update.sessionUpdate === 'agent_message_chunk') {
          attempted.push(update.content.type)
          if (update.content.type === failedBlock) throw new Error('custom delivery failed')
        }
        conn.updates.push(msg)
      }
      proc.getEntries = async beforeResponseResolve => {
        if (delivery === 'live') proc.emit({ type: 'agent_start' })
        proc.emit({ type: 'message_end', message: customMessage })
        if (delivery === 'buffered') proc.emit({ type: 'agent_start' })
        await tick()
        assert.deepEqual(attempted, ['image', 'text'], 'delivery fails while the history response is still pending')
        beforeResponseResolve?.()
        return history(1)
      }
      try {
        await assert.rejects(replay(), /custom delivery failed/)
      } finally {
        session.dispose()
      }
    })
  }
}
