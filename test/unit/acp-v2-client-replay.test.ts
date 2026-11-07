import test from 'node:test'
import assert from 'node:assert/strict'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { V2ClientConnection } from '../../src/acp/v2/client.js'
import { replayEntryId } from '../../src/acp/replay-entry-id.js'

test('V2ClientConnection: subagent updates inside a replay window pass through without flushing the buffered entry', async () => {
  const sent: { sessionId: string; update: v2.SessionUpdate }[] = []
  // The connection only calls notify on this path; AgentContext wraps SDK internals.
  const ctx = {
    notify: async (_method: unknown, params: { sessionId: string; update: v2.SessionUpdate }) => {
      sent.push(params)
    }
  } as unknown as v2.AgentContext
  const conn = new V2ClientConnection(ctx)
  const taggedChunk = (text: string): SessionUpdate =>
    // The load replay attaches the retained entry id as a symbol-keyed property.
    ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      [replayEntryId]: 'entry-1'
    }) as SessionUpdate

  await conn.replaying('s', async () => {
    await conn.sessionUpdate({ sessionId: 's', update: taggedChunk('hello ') })
    await conn.sessionUpdate({
      sessionId: 's',
      update: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Reviewer', state: { state: 'running' } }
    })
    await conn.sessionUpdate({ sessionId: 's', update: taggedChunk('world') })
  })

  const announcementIndex = sent.findIndex(item => item.update.sessionUpdate === 'subagent_update')
  const flushIndex = sent.findIndex(item => item.update.sessionUpdate === 'agent_message')
  assert.ok(announcementIndex >= 0, 'the subagent update passed through the replay window')
  assert.ok(
    flushIndex > announcementIndex,
    'the buffered entry flushed only at the window end, not on the announcement'
  )
  assert.equal(sent.filter(item => item.update.sessionUpdate === 'agent_message').length, 1, 'exactly one flush upsert')
  const flush = sent[flushIndex].update as { messageId?: string; content?: v2.ContentBlock[] }
  assert.equal(flush.messageId, 'replay:entry-1')
  assert.deepEqual(flush.content, [
    { type: 'text', text: 'hello ' },
    { type: 'text', text: 'world' }
  ])
})
