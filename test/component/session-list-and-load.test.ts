import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

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
        cwd: '/tmp/project'
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
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
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
        getMessages: async (beforeResponseResolve?: () => void) => {
          eventHandler?.({ type: 'message_end', message: { ...preBoundarySnapshotMessage } })
          beforeResponseResolve?.()
          eventHandler?.({ type: 'message_end', message: { ...postBoundarySnapshotMessage } })
          eventHandler?.({ type: 'message_end', message: { ...postBoundaryQueuedMessage } })
          // Emit the unmatched timestamp-less event first. A fallback identity
          // that ignores stable details would consume the wrong snapshot count.
          eventHandler?.({ type: 'message_end', message: { ...timestampLessQueuedMessage } })
          eventHandler?.({ type: 'message_end', message: { ...timestampLessSnapshotMessage } })

          return {
            messages: [
              { role: 'user', content: 'Hello' },
              { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
              preBoundarySnapshotMessage,
              postBoundarySnapshotMessage,
              timestampLessSnapshotMessage,
              { role: 'custom', display: false, content: 'Hidden custom message' },
              { role: 'custom', content: 'Display flag absent' },
              { role: 'custom', display: true, content: [] }
            ]
          }
        },
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium', isStreaming: true }),
        prompt: async () => {}
      } as any
    }

    try {
      await assert.rejects(
        () => agent.loadSession({ sessionId: 'sess-1', cwd: '/different/project', mcpServers: [], _meta: null } as any),
        /does not match the session's recorded cwd/i
      )

      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

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
      assert.equal(allAgentTexts.filter(text => text === 'Post-boundary snapshot message.').length, 1)
      assert.equal(allAgentTexts.filter(text => text === 'Post-boundary queued message.').length, 1)
      assert.equal(allAgentTexts.filter(text => text === 'Timestamp-less message.').length, 2)
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
