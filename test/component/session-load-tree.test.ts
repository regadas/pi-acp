import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Isolated workspace: repository-local .pi settings/commands must not leak in.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-load-tree-cwd-'))

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: TEST_CWD, sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

function mockSpawn(tree: unknown) {
  return async () =>
    ({
      onEvent: () => () => {},
      onTermination: () => () => {},
      whenTerminated: async () => {},
      getTree: async (beforeResponseResolve?: () => void) => {
        beforeResponseResolve?.()
        return tree
      },
      getAvailableModels: async () => ({ models: [] }),
      // Restore validation requires pi to report the requested session.
      getState: async () => ({ thinkingLevel: 'medium', sessionId: 's1', sessionFile: '/tmp/s.jsonl' })
    }) as any
}

async function loadWith(tree: unknown, supportsTerminalOutputMeta = false): Promise<FakeAgentSideConnection> {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn(tree)
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: supportsTerminalOutputMeta ? { _meta: { terminal_output: true } } : {}
    } as any)
    await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })
    return conn
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

/** Nest a flat chain of entries into get_tree's node shape. */
function chainToTree(entries: Array<Record<string, unknown>>, extraBranches: Record<string, unknown[]> = {}) {
  let root: any = null
  let cursor: any = null
  entries.forEach((entry, index) => {
    const id = `e${index + 1}`
    const node = {
      entry: { id, parentId: index === 0 ? null : `e${index}`, timestamp: '', ...entry },
      children: [] as any[]
    }
    for (const abandoned of extraBranches[id] ?? []) {
      node.children.push({ entry: abandoned, children: [] })
    }
    if (!root) root = node
    else cursor.children.push(node)
    cursor = node
  })
  // Abandoned children attached to the leaf's parent come before the active
  // child; the walk must pick the branch containing leafId regardless.
  return { tree: [root], leafId: `e${entries.length}` }
}

test('PiAcpAgent: loadSession replays the complete raw active branch in order', async () => {
  const tree = chainToTree(
    [
      { type: 'message', message: { role: 'user', content: 'first question' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'checking the file' },
            { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'a.txt' } }
          ]
        }
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call_read',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
          isError: false
        }
      },
      // Internal entries that must never appear in the replayed conversation:
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      { type: 'model_change', provider: 'test', modelId: 'alpha' },
      { type: 'label', targetId: 'e1', label: 'bookmark' },
      { type: 'session_info', name: 'My session' },
      { type: 'custom', customType: 'ext-state', data: { some: 'state' } },
      // Compaction keeps the original messages above on the path; the summary
      // itself must not be replayed in addition to them.
      { type: 'compaction', summary: 'SUMMARY OF EVERYTHING', firstKeptEntryId: 'e1', tokensBefore: 999 },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'now look at this: ' },
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
          ]
        }
      },
      { type: 'custom_message', customType: 'notes', content: 'visible note', display: true, details: { n: 1 } },
      { type: 'custom_message', customType: 'notes', content: 'hidden note', display: false },
      {
        type: 'message',
        message: { role: 'bashExecution', command: 'ls -la', output: 'total 0', exitCode: 0, cancelled: false }
      },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } }
    ],
    {
      // Abandoned sibling branch forked from e1: must not replay.
      e1: [
        {
          type: 'message',
          id: 'abandoned-1',
          parentId: 'e1',
          timestamp: '',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ABANDONED ANSWER' }] }
        }
      ]
    }
  )

  const conn = await loadWith(tree)
  const updates = conn.updates.map(u => (u as any).update)

  const replay = updates
    .filter(u =>
      ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(
        u.sessionUpdate
      )
    )
    .map(u => {
      if (u.sessionUpdate === 'tool_call') return `tool_call:${u.toolCallId}:${u.status}`
      if (u.sessionUpdate === 'tool_call_update') return `tool_call_update:${u.toolCallId}:${u.status}`
      const c = u.content
      return `${u.sessionUpdate}:${c.type === 'text' ? c.text : `image/${c.mimeType}`}`
    })

  assert.deepEqual(replay, [
    'user_message_chunk:first question',
    'agent_thought_chunk:let me look',
    'agent_message_chunk:checking the file',
    'tool_call:call_read:pending',
    'tool_call_update:call_read:completed',
    'user_message_chunk:now look at this: ',
    'user_message_chunk:image/image/png',
    'agent_message_chunk:visible note',
    'tool_call:pi-bash-e13:in_progress',
    'tool_call_update:pi-bash-e13:completed',
    'agent_message_chunk:all done'
  ])

  const texts = JSON.stringify(updates)
  assert.ok(!texts.includes('ABANDONED ANSWER'), 'abandoned sibling branches must not replay')
  assert.ok(!texts.includes('SUMMARY OF EVERYTHING'), 'compaction summaries must not duplicate original history')
  assert.ok(!texts.includes('hidden note'), 'display:false custom messages must not replay')

  // The assistant toolCall provided the initial tool_call; the toolResult
  // must not synthesize a duplicate.
  const readCalls = updates.filter(u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call_read')
  assert.equal(readCalls.length, 1)
  assert.deepEqual(readCalls[0].rawInput, { path: 'a.txt' })

  // Non-negotiated client: bash execution output arrives as standard content.
  const bashEnd = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'pi-bash-e13')
  assert.deepEqual(bashEnd.content, [{ type: 'content', content: { type: 'text', text: '```console\ntotal 0\n```' } }])
  assert.equal(bashEnd._meta, undefined)
})

test('PiAcpAgent: loadSession replays failed and cancelled bashExecution entries as failed', async () => {
  const tree = chainToTree([
    {
      type: 'message',
      message: { role: 'bashExecution', command: 'false', output: '', exitCode: 1, cancelled: false }
    },
    {
      type: 'message',
      message: { role: 'bashExecution', command: 'sleep 100', output: '^C', cancelled: true }
    }
  ])

  const conn = await loadWith(tree)
  const updates = conn.updates.map(u => (u as any).update)

  const finals = updates.filter(u => u.sessionUpdate === 'tool_call_update')
  assert.deepEqual(
    finals.map(u => u.status),
    ['failed', 'failed']
  )
  const initials = updates.filter(u => u.sessionUpdate === 'tool_call')
  assert.deepEqual(
    initials.map(u => u.status),
    ['in_progress', 'in_progress'],
    'initial replay status stays monotonic before the failed terminal status'
  )
})

test('PiAcpAgent: loadSession preserves tool-result image content in replay', async () => {
  const tree = chainToTree([
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_img',
        toolName: 'screenshot',
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' }
        ],
        isError: false
      }
    }
  ])

  const conn = await loadWith(tree)
  const updates = conn.updates.map(u => (u as any).update)
  const end = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_img')
  assert.deepEqual(end.content, [
    { type: 'content', content: { type: 'text', text: 'captured' } },
    { type: 'content', content: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' } }
  ])
})

test('PiAcpAgent: loadSession preserves interleaved and image-only tool-result content order', async () => {
  const tree = chainToTree([
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_mixed',
        toolName: 'screenshot',
        content: [
          { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
          { type: 'text', text: 'between' },
          { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' }
        ],
        isError: false
      }
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_img_only',
        toolName: 'screenshot',
        content: [{ type: 'image', data: 'b25seQ==', mimeType: 'image/png' }],
        isError: false
      }
    }
  ])

  const conn = await loadWith(tree)
  const updates = conn.updates.map(u => (u as any).update)

  const mixed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_mixed')
  assert.deepEqual(mixed.content, [
    { type: 'content', content: { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' } },
    { type: 'content', content: { type: 'text', text: 'between' } },
    { type: 'content', content: { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' } }
  ])

  const imageOnly = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_img_only')
  assert.deepEqual(
    imageOnly.content,
    [{ type: 'content', content: { type: 'image', data: 'b25seQ==', mimeType: 'image/png' } }],
    'an image-only result must not grow a JSON/base64 text block'
  )
})

test('PiAcpAgent: loadSession replays custom-message image content in source order', async () => {
  const tree = chainToTree([
    {
      type: 'custom_message',
      customType: 'vision',
      display: true,
      content: [
        { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
        { type: 'text', text: 'annotated' }
      ]
    }
  ])

  const conn = await loadWith(tree)
  const chunks = conn.updates
    .map(u => (u as any).update)
    .filter(u => u.sessionUpdate === 'agent_message_chunk')
    .map(u => u.content)

  assert.deepEqual(chunks, [
    { type: 'image', data: 'aW1nQQ==', mimeType: 'image/png' },
    { type: 'text', text: 'annotated' }
  ])
})

test('PiAcpAgent: loadSession fails replayed tool calls that never got a durable result', async () => {
  const tree = chainToTree([
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_done', name: 'read', arguments: { path: 'a.txt' } },
          { type: 'toolCall', id: 'call_interrupted', name: 'read', arguments: { path: 'b.txt' } }
        ]
      }
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_done',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        isError: false
      }
    }
  ])

  const conn = await loadWith(tree)
  const updates = conn.updates.map(u => (u as any).update)

  const doneStatuses = updates.filter(u => u.toolCallId === 'call_done').map(u => u.status)
  assert.deepEqual(doneStatuses, ['pending', 'completed'], 'matched calls keep their real terminal status')

  const interrupted = updates.filter(u => u.toolCallId === 'call_interrupted')
  assert.deepEqual(
    interrupted.map(u => u.status),
    ['pending', 'failed'],
    'a call with no durable result must not stay pending forever'
  )
  const final = interrupted.at(-1)
  assert.equal(final.sessionUpdate, 'tool_call_update')
  assert.deepEqual(final.content, [
    {
      type: 'content',
      content: {
        type: 'text',
        text: 'No result was recorded for this tool call; the session ended before it completed.'
      }
    }
  ])
})

test('PiAcpAgent: unmatched replayed Bash calls settle negotiated terminals and stay generic otherwise', async () => {
  const tree = chainToTree([
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_bash_interrupted', name: 'bash', arguments: { command: 'sleep 5' } }]
      }
    }
  ])

  const generic = await loadWith(tree)
  const genericUpdates = generic.updates.map(update => (update as any).update)
  const genericFinal = genericUpdates.find(
    update => update.toolCallId === 'call_bash_interrupted' && update.status === 'failed'
  )
  assert.equal(genericFinal._meta, undefined)
  assert.equal(genericFinal.content.length, 1)
  assert.equal(genericFinal.content[0].type, 'content')

  const terminal = await loadWith(tree, true)
  const terminalUpdates = terminal.updates.map(update => (update as any).update)
  const terminalFinal = terminalUpdates.find(
    update => update.toolCallId === 'call_bash_interrupted' && update.status === 'failed'
  )
  assert.deepEqual(terminalFinal._meta, {
    terminal_exit: { terminal_id: 'call_bash_interrupted', exit_code: 1, signal: null }
  })
  assert.deepEqual(terminalFinal.content[0], { type: 'terminal', terminalId: 'call_bash_interrupted' })
  assert.match(terminalFinal.content[1].content.text, /No result was recorded/)
})

test('PiAcpAgent: loadSession fails clearly on malformed trees instead of replaying garbage', async () => {
  const missingLeaf = { tree: [{ entry: { type: 'message', id: 'a', parentId: null }, children: [] }], leafId: 'zzz' }
  const duplicate = {
    tree: [
      { entry: { type: 'message', id: 'a', parentId: null }, children: [] },
      { entry: { type: 'message', id: 'a', parentId: null }, children: [] }
    ],
    leafId: 'a'
  }
  const cycle = {
    tree: [
      { entry: { type: 'message', id: 'a', parentId: 'b' }, children: [] },
      { entry: { type: 'message', id: 'b', parentId: 'a' }, children: [] }
    ],
    leafId: 'a'
  }

  for (const [label, tree] of Object.entries({ missingLeaf, duplicate, cycle })) {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = mockSpawn(tree)
    try {
      await assert.rejects(
        () => agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] }),
        (e: any) => {
          assert.equal(e?.code, -32603, label)
          assert.match(String(e?.message), /Cannot replay session history/, label)
          return true
        }
      )
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  }
})

test('PiAcpAgent: loadSession replays an empty session (null leaf) without updates', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = new FakeStore()
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = mockSpawn({ tree: [], leafId: null })
  try {
    const res = await agent.loadSession({ sessionId: 's1', cwd: TEST_CWD, mcpServers: [] })
    assert.equal('models' in (res as any), false, 'no custom root models field')
    const replayKinds = conn.updates
      .map(u => (u as any).update.sessionUpdate)
      .filter(kind => kind !== 'available_commands_update')
    assert.deepEqual(replayKinds, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
