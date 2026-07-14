import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function seedSessions(root: string): void {
  const dirA = join(root, 'sessions', '--a--')
  const dirB = join(root, 'sessions', '--b--')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })

  writeFileSync(
    join(dirA, '1.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/cwd/a'
    }) +
      '\n' +
      JSON.stringify({
        type: 'session_info',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        name: 'A'
      }) +
      '\n',
    { encoding: 'utf8' }
  )

  writeFileSync(
    join(dirB, '2.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-b',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/cwd/b'
    }) +
      '\n' +
      JSON.stringify({
        type: 'session_info',
        id: 'b1b2c3d4',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        name: 'B'
      }) +
      '\n',
    { encoding: 'utf8' }
  )
}

async function withSeededAgent(fn: (agent: PiAcpAgent) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  seedSessions(root)

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    await fn(new PiAcpAgent(asAgentConn(new FakeAgentSideConnection())))
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

test('PiAcpAgent: listSessions returns all known sessions when cwd is omitted', async () => {
  await withSeededAgent(async agent => {
    const listed = await agent.listSessions({})
    const ids = listed.sessions.map(s => s.sessionId).sort()
    assert.deepEqual(ids, ['sess-a', 'sess-b'])
    assert.equal(listed.nextCursor, null)
  })
})

test('PiAcpAgent: listSessions filters by the supplied cwd', async () => {
  await withSeededAgent(async agent => {
    const listed = await agent.listSessions({ cwd: '/cwd/a' })
    assert.equal(listed.sessions.length, 1)
    assert.equal(listed.sessions[0]?.sessionId, 'sess-a')

    const none = await agent.listSessions({ cwd: '/cwd/unknown' })
    assert.deepEqual(none.sessions, [])

    await assert.rejects(() => agent.listSessions({ cwd: 'relative/path' }), /absolute path/i)
  })
})

test('PiAcpAgent: listSessions rejects malformed cursors instead of treating them as zero', async () => {
  await withSeededAgent(async agent => {
    await assert.rejects(() => agent.listSessions({ cursor: 'not-a-cursor' }), /invalid cursor/i)
    await assert.rejects(() => agent.listSessions({ cursor: '-1' }), /invalid cursor/i)
    await assert.rejects(() => agent.listSessions({ cursor: '' }), /invalid cursor/i)
    await assert.rejects(() => agent.listSessions({ cursor: '9007199254740992' }), /invalid cursor/i)
  })
})

test('PiAcpAgent: listSessions accepts cursors it issued', async () => {
  await withSeededAgent(async agent => {
    // Page size is larger than the fixture, so a "2" offset yields an empty page.
    const first = await agent.listSessions({ cursor: '0' })
    assert.deepEqual(
      first.sessions.map(session => session.sessionId),
      ['sess-a', 'sess-b']
    )

    const listed = await agent.listSessions({ cursor: '2' })
    assert.deepEqual(listed.sessions, [])
    assert.equal(listed.nextCursor, null)
  })
})
