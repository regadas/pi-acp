import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-list-load-cwd-'))

test('PiAcpAgent: loadSession replays visible custom history once across the response boundary', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: TEST_CWD
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-load-store-'))

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, TEST_CWD)
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return a fake process with persisted history
    const originalSpawn = PiRpcProcess.spawn
    let eventHandler: ((event: Record<string, unknown>) => void) | undefined
    const preBoundarySnapshotMessage = {
      role: 'custom',
      customType: 'background-task',
      display: true,
      content: 'Pre-boundary snapshot message.',
      timestamp: 1
    }
    const postBoundarySnapshotMessage = {
      role: 'custom',
      customType: 'background-task',
      display: true,
      content: 'Post-boundary snapshot message.',
      timestamp: 2
    }
    const postBoundaryQueuedMessage = {
      role: 'custom',
      customType: 'background-task',
      display: true,
      content: 'Post-boundary queued message.',
      timestamp: 3
    }
    const timestampLessSnapshotMessage = {
      role: 'custom',
      customType: 'timestamp-less',
      display: true,
      content: 'Timestamp-less message.',
      details: { source: 'snapshot' }
    }
    const timestampLessQueuedMessage = {
      role: 'custom',
      customType: 'timestamp-less',
      display: true,
      content: 'Timestamp-less message.',
      details: { source: 'queued' }
    }
    const repeatedMessage = {
      role: 'custom',
      customType: 'repeated',
      display: true,
      content: 'Repeated identical message.',
      timestamp: 4
    }
    const imageFirstMessage = {
      role: 'custom',
      customType: 'vision',
      display: true,
      content: [
        { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
        { type: 'text', text: 'Image note.' }
      ],
      timestamp: 5
    }

    // The persisted snapshot equivalents of the live custom messages:
    // pi persists extension messages as `custom_message` entries.
    const toCustomMessageEntry = (message: Record<string, unknown>) => ({
      type: 'custom_message',
      customType: message.customType,
      content: message.content,
      display: message.display,
      ...(message.details !== undefined ? { details: message.details } : {}),
      // pi persists SessionEntryBase.timestamp as an ISO string even though
      // live CustomMessage events carry a numeric epoch timestamp; the
      // reconciliation identity must bridge both representations.
      timestamp: typeof message.timestamp === 'number' ? new Date(message.timestamp).toISOString() : message.timestamp
    })

    const chainEntries = [
      { type: 'message', message: { role: 'user', content: 'Hello' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] } },
      toCustomMessageEntry(preBoundarySnapshotMessage),
      toCustomMessageEntry(postBoundarySnapshotMessage),
      toCustomMessageEntry(timestampLessSnapshotMessage),
      toCustomMessageEntry(repeatedMessage),
      toCustomMessageEntry(repeatedMessage),
      toCustomMessageEntry(imageFirstMessage),
      toCustomMessageEntry({ customType: 'background-task', display: false, content: 'Hidden custom message' }),
      // Display flag absent: a raw custom message persisted as a message entry.
      { type: 'message', message: { role: 'custom', content: 'Display flag absent' } },
      toCustomMessageEntry({ customType: 'background-task', display: true, content: [] })
    ]

    const entryData = {
      entries: chainEntries.map((entry, index) => ({
        id: `e${index + 1}`,
        parentId: index === 0 ? null : `e${index}`,
        timestamp: '',
        ...entry
      })),
      leafId: `e${chainEntries.length}`
    }

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: (handler: (event: Record<string, unknown>) => void) => {
          eventHandler = handler
          return () => {
            if (eventHandler === handler) eventHandler = undefined
          }
        },
        onTermination: () => () => {},
        whenTerminated: async () => {},
        getEntries: async (beforeResponseResolve?: () => void) => {
          eventHandler?.({ type: 'message_end', message: { ...preBoundarySnapshotMessage } })
          eventHandler?.({ type: 'message_end', message: { ...repeatedMessage } })
          eventHandler?.({ type: 'message_end', message: { ...repeatedMessage } })
          eventHandler?.({ type: 'message_end', message: { ...imageFirstMessage } })
          beforeResponseResolve?.()
          eventHandler?.({ type: 'message_end', message: { ...postBoundarySnapshotMessage } })
          eventHandler?.({ type: 'message_end', message: { ...postBoundaryQueuedMessage } })
          // Emit the unmatched timestamp-less event first. A fallback identity
          // that ignores stable details would consume the wrong snapshot count.
          eventHandler?.({ type: 'message_end', message: { ...timestampLessQueuedMessage } })
          eventHandler?.({ type: 'message_end', message: { ...timestampLessSnapshotMessage } })

          return entryData
        },
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({
          thinkingLevel: 'medium',
          isStreaming: true,
          // Restore validation requires pi to report the requested session.
          sessionId: 'sess-1',
          sessionFile: String(params.sessionPath)
        }),
        prompt: async () => {}
      } as any
    }

    try {
      await assert.rejects(
        () => agent.loadSession({ sessionId: 'sess-1', cwd: root, mcpServers: [], _meta: null }),
        /does not match the session's recorded cwd/i
      )

      const loaded = await agent.loadSession({ sessionId: 'sess-1', cwd: TEST_CWD, mcpServers: [], _meta: null })

      // Session configuration is returned through standard config options only;
      // thinking levels are never advertised as legacy session modes.
      assert.ok(loaded.configOptions?.some(option => option.id === 'thought_level'))
      assert.equal('modes' in (loaded as any), false)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
      assert.equal(texts.filter(t => t.text === 'Pre-boundary snapshot message.').length, 1)
      assert.equal(texts.filter(t => t.text === 'Post-boundary snapshot message.').length, 1)
      assert.equal(texts.filter(t => t.text === 'Timestamp-less message.').length, 1)
      assert.equal(texts.filter(t => t.text === 'Repeated identical message.').length, 2)
      assert.equal(texts.filter(t => t.text === 'Image note.').length, 1)

      const replayChunks = conn.updates
        .map(u => (u as any).update)
        .filter(u => u?.sessionUpdate === 'agent_message_chunk')
        .map(u => u.content)
      const imageIndex = replayChunks.findIndex(c => c?.type === 'image' && c?.data === 'aW1nQQ==')
      assert.ok(imageIndex >= 0, 'custom-message image content is replayed')
      assert.deepEqual(replayChunks[imageIndex], { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' })
      assert.deepEqual(
        replayChunks[imageIndex + 1],
        { type: 'text', text: 'Image note.' },
        'image-first ordering is preserved'
      )
      assert.ok(!texts.some(t => t.text === 'Hidden custom message'))
      assert.ok(!texts.some(t => t.text === 'Display flag absent'))
      assert.ok(!texts.some(t => t.text === 'Post-boundary queued message.'))

      const nextPrompt = agent.prompt({
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'Continue' }]
      } as any)
      await new Promise(resolve => setTimeout(resolve, 0))
      eventHandler?.({ type: 'agent_start' })
      eventHandler?.({ type: 'agent_settled' })
      assert.equal((await nextPrompt).stopReason, 'end_turn')
      await new Promise(resolve => setTimeout(resolve, 0))

      const allAgentTexts = conn.updates
        .map(u => (u as any).update)
        .filter(u => u?.sessionUpdate === 'agent_message_chunk')
        .map(u => u.content?.text)
      assert.equal(allAgentTexts.filter(text => text === 'Pre-boundary snapshot message.').length, 1)
      // A post-boundary event never reconciles against the snapshot — counted
      // identity cannot tell a genuinely new identical message apart from an
      // older snapshot occurrence — so it stays queued and is emitted on the
      // next prompt. The rare delayed persisted event is therefore shown
      // twice (documented tradeoff) instead of a new one ever being dropped.
      assert.equal(allAgentTexts.filter(text => text === 'Post-boundary snapshot message.').length, 2)
      assert.equal(allAgentTexts.filter(text => text === 'Post-boundary queued message.').length, 1)
      assert.equal(allAgentTexts.filter(text => text === 'Timestamp-less message.').length, 3)
      assert.equal(allAgentTexts.filter(text => text === 'Repeated identical message.').length, 2)
      assert.equal(allAgentTexts.filter(text => text === 'Image note.').length, 1)

      const allImageChunks = conn.updates
        .map(u => (u as any).update)
        .filter(u => u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'image')
      assert.equal(allImageChunks.length, 1, 'the custom-message image is not re-emitted on the next prompt')
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
  }
})
