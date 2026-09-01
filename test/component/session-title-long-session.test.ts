import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionRepository } from '../../src/acp/session-repository.js'
import { SessionStore } from '../../src/acp/session-store.js'

test('listPiSessions: streams a name outside both bounded ends and keeps the newest message timestamp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const sessionFile = join(sessionsDir, 's.jsonl')

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project'
  })
  const info = JSON.stringify({
    type: 'session_info',
    id: 'i1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    name: 'Named Early'
  })

  const filler = (timestamp: string) =>
    Array.from({ length: 200 }, () =>
      JSON.stringify({
        type: 'message',
        id: 'm',
        parentId: null,
        timestamp,
        message: { role: 'user', content: 'x'.repeat(2000) }
      })
    ).join('\n')

  writeFileSync(
    sessionFile,
    [header, filler('2026-01-01T00:00:01.000Z'), info, filler('2026-01-01T00:00:03.000Z')].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const repository = new SessionRepository(new SessionStore(join(root, 'map.json')), {}, root)
    const s = (await repository.list()).find(item => item.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.title, 'Named Early')
    assert.equal(s?.updatedAt, '2026-01-01T00:00:03.000Z')
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('listPiSessions: skips oversized records, continues scanning, and caps explicit titles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-oversized-metadata-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, 's.jsonl')
  const longName = 'N'.repeat(200)
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', id: 'sess-oversized', cwd: '/tmp/project' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'x'.repeat(1024 * 1024) }
      }),
      JSON.stringify({ type: 'session_info', timestamp: '2026-01-01T00:00:02.000Z', name: longName }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'assistant', content: 'latest' }
      })
    ].join('\n') + '\n'
  )

  const repository = new SessionRepository(new SessionStore(join(root, 'map.json')), {}, root)
  const session = (await repository.list()).find(item => item.sessionId === 'sess-oversized')
  assert.equal(session?.title, longName.slice(0, 80))
  assert.equal(session?.updatedAt, '2026-01-01T00:00:03.000Z')
})

test('listPiSessions: keeps tail title while selecting the latest message timestamp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-tail-metadata-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, 's.jsonl')
  const records = [
    JSON.stringify({
      type: 'session',
      id: 'sess-tail',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'x'.repeat(300 * 1024) }
    }),
    JSON.stringify({
      type: 'session_info',
      timestamp: '2026-01-01T00:00:02.000Z',
      name: 'Named In Tail'
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', content: 'latest' }
    })
  ]
  writeFileSync(sessionFile, records.join('\n') + '\n')

  const repository = new SessionRepository(new SessionStore(join(root, 'map.json')), {}, root)
  const session = (await repository.list()).find(item => item.sessionId === 'sess-tail')
  assert.equal(session?.title, 'Named In Tail')
  assert.equal(session?.updatedAt, '2026-01-01T00:00:03.000Z')
})
