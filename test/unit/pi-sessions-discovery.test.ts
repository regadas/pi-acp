import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findPiSession, listPiSessions } from '../../src/acp/pi-sessions.js'
import { loadSlashCommands } from '../../src/acp/slash-commands.js'

function withAgentDir<T>(dir: string, run: () => T): T {
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return run()
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  }
}

function writeSession(dir: string, name: string, sessionId: string, cwd = '/tmp/project', extraLines: string[] = []) {
  const file = join(dir, name)
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd
  })
  writeFileSync(file, [header, ...extraLines].join('\n') + '\n', 'utf-8')
  return file
}

test('listPiSessions: one unreadable or invalid session file never breaks the listing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  mkdirSync(sessionsDir, { recursive: true })

  writeSession(sessionsDir, '0001_good.jsonl', 'sess-good')
  // Invalid header content.
  writeFileSync(join(sessionsDir, '0002_garbage.jsonl'), 'not json at all\n', 'utf-8')

  const unreadable = writeSession(sessionsDir, '0003_unreadable.jsonl', 'sess-unreadable')
  const canRevokeRead = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0
  if (canRevokeRead) chmodSync(unreadable, 0o000)

  try {
    const listed = withAgentDir(root, () => listPiSessions())
    assert.ok(
      listed.some(s => s.sessionId === 'sess-good'),
      'the readable session is listed'
    )
    if (canRevokeRead) {
      assert.ok(!listed.some(s => s.sessionId === 'sess-unreadable'), 'the unreadable session is skipped, not fatal')
    }
  } finally {
    if (canRevokeRead) chmodSync(unreadable, 0o600)
  }
})

test('listPiSessions: fallback titles come from a bounded head read of large files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  mkdirSync(sessionsDir, { recursive: true })

  // > 1MB session file with the first user message early: the bounded head
  // read must find the title without reading the whole file.
  const filler = JSON.stringify({
    type: 'custom',
    id: 'x',
    parentId: null,
    customType: 'noise',
    data: 'y'.repeat(4096)
  })
  writeSession(sessionsDir, '0001_big.jsonl', 'sess-big', '/tmp/project', [
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: 'find me early' }
    }),
    ...Array.from({ length: 400 }, () => filler)
  ])

  // A file whose head contains no user message yields a null title, bounded.
  writeSession(sessionsDir, '0002_untitled.jsonl', 'sess-untitled', '/tmp/project', [
    ...Array.from({ length: 400 }, () => filler)
  ])

  const listed = withAgentDir(root, () => listPiSessions())
  assert.equal(listed.find(s => s.sessionId === 'sess-big')?.title, 'find me early')
  assert.equal(listed.find(s => s.sessionId === 'sess-untitled')?.title, null)
})

test('listPiSessions: an early session name is found from the bounded head, never a whole-file scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  mkdirSync(sessionsDir, { recursive: true })
  const filler = JSON.stringify({ type: 'custom', data: 'z'.repeat(4096) })
  writeSession(sessionsDir, 'named.jsonl', 'sess-named', '/tmp/project', [
    JSON.stringify({ type: 'session_info', name: 'Early bounded name' }),
    ...Array.from({ length: 400 }, () => filler)
  ])

  const listed = withAgentDir(root, () => listPiSessions())
  assert.equal(listed.find(session => session.sessionId === 'sess-named')?.title, 'Early bounded name')
})

test('findPiSession: targeted header scan finds identity without tail/title work', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  const sessionsDir = join(root, 'sessions', '--proj--')
  mkdirSync(sessionsDir, { recursive: true })

  for (let index = 0; index < 30; index++) {
    writeSession(sessionsDir, `00${String(index).padStart(2, '0')}_s.jsonl`, `sess-${index}`, `/tmp/project-${index}`)
  }
  // Garbage files must be skipped, not fatal.
  writeFileSync(join(sessionsDir, '0099_garbage.jsonl'), '{broken\n', 'utf-8')

  const found = withAgentDir(root, () => findPiSession('sess-17'))
  assert.ok(found)
  assert.equal(found!.sessionId, 'sess-17')
  assert.equal(found!.cwd, '/tmp/project-17')
  assert.ok(found!.sessionFile.endsWith('_s.jsonl'))

  assert.equal(
    withAgentDir(root, () => findPiSession('sess-does-not-exist')),
    null
  )
})

test('findPiSession: targeted recursion stops before visiting directories after an early match', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-targeted-'))
  const matchingDir = join(root, '00-match')
  const laterDir = join(root, '99-must-not-visit')
  mkdirSync(matchingDir, { recursive: true })
  mkdirSync(laterDir, { recursive: true })
  writeSession(matchingDir, 'match.jsonl', 'target')
  writeSession(laterDir, 'later.jsonl', 'other')

  const visited: string[] = []
  const found = findPiSession('target', {
    sessionsDir: root,
    onDirectoryVisited: dir => visited.push(dir)
  })

  assert.equal(found?.sessionId, 'target')
  assert.deepEqual(visited, [root, matchingDir])
  assert.ok(!visited.includes(laterDir), 'the recursive walk returned immediately after the header match')
})

test('loadSlashCommands: user prompts resolve through PI_CODING_AGENT_DIR', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  const promptsDir = join(root, 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'ship-it.md'), '---\ndescription: Ship the change\n---\nShip {{args}} now.\n', 'utf-8')

  const emptyCwd = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-cwd-'))
  const commands = withAgentDir(root, () => loadSlashCommands(emptyCwd))
  const shipIt = commands.find(c => c.name === 'ship-it')
  assert.ok(shipIt, 'prompt template from the overridden agent dir is discovered')
  assert.match(shipIt!.description, /Ship the change/)
})
