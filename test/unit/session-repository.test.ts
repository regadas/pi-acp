import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SessionRepository, resolveSessionDirectory } from '../../src/acp/session-repository.js'
import { SessionStore } from '../../src/acp/session-store.js'

test('session directory precedence preserves pi env, project, tilde, and cwd-relative semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-settings-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(join(cwd, '.pi'), { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~/global-sessions' }))
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ sessionDir: 'project-sessions' }))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    assert.equal(resolveSessionDirectory(cwd, {}, agentDir).path, resolve(cwd, 'project-sessions'))
    assert.equal(
      resolveSessionDirectory(cwd, { PI_CODING_AGENT_SESSION_DIR: '~/env-sessions' }, agentDir).path,
      join(homedir(), 'env-sessions')
    )
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  }
})

test('repository uses the newest duplicate consistently for find, list, and delete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-duplicates-'))
  const sessions = join(root, 'sessions')
  const oldFile = join(sessions, 'old.jsonl')
  const newFile = join(sessions, 'new.jsonl')
  mkdirSync(sessions)
  const writeSession = (path: string, timestamp: string, title: string) =>
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session', id: 'duplicate', cwd: root }),
        JSON.stringify({ type: 'session_info', timestamp, name: title }),
        JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: title } })
      ].join('\n') + '\n'
    )
  writeSession(oldFile, '2026-01-01T00:00:00.000Z', 'Old')
  writeSession(newFile, '2026-01-02T00:00:00.000Z', 'New')

  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'duplicate', cwd: root, sessionFile: oldFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  assert.equal((await repository.find('duplicate', root))?.sessionFile, newFile)
  assert.deepEqual(
    (await repository.list(root)).map(record => record.sessionFile),
    [newFile]
  )
  assert.equal(await repository.delete('duplicate'), newFile)
  assert.equal(existsSync(newFile), false)
  assert.equal(existsSync(oldFile), false)
  assert.equal(store.get('duplicate'), null)
  assert.equal(await repository.find('duplicate', root), null)
  assert.equal(
    (await repository.list(root)).some(record => record.sessionId === 'duplicate'),
    false
  )
})

test('repository validates stored headers before deletion and tombstones tampered paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-delete-'))
  const map = join(root, 'session-map.json')
  const store = new SessionStore(map)
  const victim = join(root, 'victim.jsonl')
  writeFileSync(victim, `${JSON.stringify({ type: 'session', id: 'other', cwd: root })}\n`)
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: victim })
  const repository = new SessionRepository(
    store,
    { PI_CODING_AGENT_SESSION_DIR: join(root, 'none') },
    join(root, 'agent')
  )
  assert.equal(await repository.delete('wanted'), null)
  assert.equal(existsSync(victim), true)
  assert.equal(store.get('wanted'), null)
})

test('repository caps metadata scanning per file and uses mtime when truncated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-metadata-limit-'))
  const sessions = join(root, 'sessions')
  const sessionFile = join(sessions, 'large.jsonl')
  mkdirSync(sessions)
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      id: 'large',
      cwd: root,
      timestamp: '2026-01-01T00:00:00.000Z'
    })}\n`
  )
  const handle = openSync(sessionFile, 'r+')
  try {
    writeSync(
      handle,
      `\n${JSON.stringify({
        type: 'session_info',
        timestamp: '2026-01-02T00:00:00.000Z',
        name: 'Beyond metadata limit'
      })}\n`,
      9 * 1024 * 1024
    )
  } finally {
    closeSync(handle)
  }
  const mtime = new Date('2026-02-01T00:00:00.000Z')
  utimesSync(sessionFile, mtime, mtime)

  const repository = new SessionRepository(
    new SessionStore(join(root, 'map.json')),
    { PI_CODING_AGENT_SESSION_DIR: sessions },
    join(root, 'agent')
  )
  const session = (await repository.list(root)).find(record => record.sessionId === 'large')
  assert.equal(session?.title, null)
  assert.equal(session?.updatedAt, mtime.toISOString())
})
