import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import type { SessionRepository } from '../../src/acp/session-repository.js'
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

function addSessions(root: string, count: number): void {
  const dir = join(root, 'sessions', '--a--')
  for (let index = 0; index < count; index++) {
    writeFileSync(
      join(dir, `paged-${index}.jsonl`),
      JSON.stringify({
        type: 'session',
        version: 3,
        id: `paged-${index}`,
        timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
        cwd: '/cwd/a'
      }) + '\n'
    )
  }
}

async function withSeededAgent(fn: (agent: PiAcpAgent, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  seedSessions(root)

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  const oldAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_DIR = join(root, 'acp')

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    try {
      await fn(agent, root)
    } finally {
      agent.dispose()
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    if (oldAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = oldAcpDir
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
    const listed = await agent.listSessions({ cwd: '/cwd/a///' })
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

test('PiAcpAgent: listSessions snapshot pages avoid discovery and stay stable across insertion', async () => {
  await withSeededAgent(async (agent, root) => {
    addSessions(root, 112)
    const repository = (agent as unknown as { repository: SessionRepository }).repository
    const originalList = repository.list.bind(repository)
    let scans = 0
    repository.list = async cwd => {
      scans++
      return originalList(cwd)
    }

    const first = await agent.listSessions({ cwd: '/cwd/a' })
    assert.equal(scans, 1)
    assert.equal(first.sessions.length, 50)
    assert.match(first.nextCursor ?? '', /^s:[A-Za-z0-9_-]+:50$/)
    const expected = Array.from({ length: 112 }, (_, index) => `paged-${111 - index}`).concat('sess-a')
    assert.deepEqual(
      first.sessions.map(session => session.sessionId),
      expected.slice(0, 50)
    )

    writeFileSync(
      join(root, 'sessions', '--a--', 'new.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'new', timestamp: '2027-01-01T00:00:00.000Z', cwd: '/cwd/a' }) +
        '\n'
    )

    const second = await agent.listSessions({ cwd: '/cwd/a///', cursor: first.nextCursor! })
    assert.equal(scans, 1)
    assert.deepEqual(
      second.sessions.map(session => session.sessionId),
      expected.slice(50, 100)
    )
    assert.match(second.nextCursor ?? '', /^s:[A-Za-z0-9_-]+:100$/)
    const third = await agent.listSessions({ cwd: '/cwd/a', cursor: second.nextCursor! })
    assert.equal(scans, 1)
    assert.deepEqual(
      third.sessions.map(session => session.sessionId),
      expected.slice(100)
    )
    assert.equal(third.nextCursor, null)

    await assert.rejects(() => agent.listSessions({ cwd: '/cwd/b', cursor: first.nextCursor! }), /invalid cursor/i)
    await assert.rejects(() => agent.listSessions({ cursor: first.nextCursor! }), /invalid cursor/i)
    await assert.rejects(
      () => agent.listSessions({ cwd: '/cwd/a/other/..', cursor: first.nextCursor! }),
      /invalid cursor/i
    )
    assert.equal(scans, 1)

    const fresh = await agent.listSessions({ cwd: '/cwd/a' })
    assert.equal(scans, 2)
    assert.equal(fresh.sessions[0]?.sessionId, 'new')
    assert.deepEqual(fresh.sessions.map(session => session.sessionId).slice(1), expected.slice(0, 49))

    const legacy = await agent.listSessions({ cwd: '/cwd/a', cursor: '50' })
    assert.equal(scans, 3)
    assert.deepEqual(
      legacy.sessions.map(session => session.sessionId),
      expected.slice(49, 99)
    )

    const unaligned = await agent.listSessions({ cwd: '/cwd/a', cursor: '1' })
    assert.equal(scans, 4)
    assert.deepEqual(
      unaligned.sessions.map(session => session.sessionId),
      expected.slice(0, 50)
    )
    assert.match(unaligned.nextCursor ?? '', /^s:[A-Za-z0-9_-]+:51$/)
    const continuation = await agent.listSessions({ cwd: '/cwd/a', cursor: unaligned.nextCursor! })
    assert.equal(scans, 4)
    assert.deepEqual(
      continuation.sessions.map(session => session.sessionId),
      expected.slice(50, 100)
    )
  })
})

test('PiAcpAgent: listSessions rejects unknown and expired snapshot cursors', async () => {
  await withSeededAgent(async (agent, root) => {
    addSessions(root, 51)
    const first = await agent.listSessions({ cwd: '/cwd/a' })
    assert.ok(first.nextCursor)
    await assert.rejects(
      () => agent.listSessions({ cwd: '/cwd/a', cursor: `s:${'a'.repeat(24)}:50` }),
      /invalid cursor/i
    )
    await assert.rejects(() => agent.listSessions({ cwd: '/cwd/a', cursor: `${first.nextCursor}x` }), /invalid cursor/i)
    await assert.rejects(
      () => agent.listSessions({ cwd: '/cwd/a', cursor: first.nextCursor!.replace(':50', ':050') }),
      /invalid cursor/i
    )
    await assert.rejects(
      () => agent.listSessions({ cwd: '/cwd/a', cursor: first.nextCursor!.replace(':50', ':51') }),
      /invalid cursor/i
    )

    const snapshots = (agent as unknown as { listSnapshots: Map<string, { expiresAt: number }> }).listSnapshots
    assert.equal(snapshots.size, 1)
    snapshots.values().next().value!.expiresAt = 0
    await assert.rejects(() => agent.listSessions({ cwd: '/cwd/a', cursor: first.nextCursor! }), /invalid cursor/i)
    assert.equal(snapshots.size, 0)
  })
})

test('PiAcpAgent: listSessions bounds snapshots and clears them on disposal', async () => {
  await withSeededAgent(async (agent, root) => {
    addSessions(root, 51)
    const oldest = (await agent.listSessions({})).nextCursor!
    const snapshots = (agent as unknown as { listSnapshots: Map<string, unknown> }).listSnapshots
    for (let index = 0; index < 16; index++) await agent.listSessions({})
    assert.equal(snapshots.size, 16)
    await assert.rejects(() => agent.listSessions({ cursor: oldest }), /invalid cursor/i)
    agent.dispose()
    assert.equal(snapshots.size, 0)
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
