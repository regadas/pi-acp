import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
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

test('repository keeps a mapped duplicate canonical for find and list while delete removes both', async () => {
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

  assert.equal((await repository.find('duplicate', root))?.sessionFile, oldFile)
  assert.deepEqual(
    (await repository.list(root)).map(record => [record.sessionFile, record.title]),
    [[oldFile, 'Old']]
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

test('repository.find uses a validated mapped file without enumerating or scanning metadata', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-mapped-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const sessionFile = join(sessions, 'wanted.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n`)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: '/stale/cwd', sessionFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  const realReaddir = fs.promises.readdir
  const realCreateReadStream = fs.createReadStream
  let enumerations = 0
  let metadataScans = 0
  t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof realReaddir>) => {
    enumerations++
    return realReaddir(...args)
  })
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof realCreateReadStream>) => {
    metadataScans++
    return realCreateReadStream(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const record = await repository.find('wanted', root)
  assert.equal(record?.sessionFile, sessionFile)
  assert.equal(record?.cwd, root, 'the JSONL header, not stale store metadata, owns cwd')
  assert.equal(enumerations, 0, 'mapped lookup must not enumerate directories')
  assert.equal(metadataScans, 0, 'mapped lookup must not scan transcript metadata')
})

test('repository.find repairs missing and mismatched stored paths through discovery', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-repair-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const store = new SessionStore(join(root, 'map.json'))
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  for (const kind of ['missing', 'mismatched']) {
    const id = `wanted-${kind}`
    const stale = join(sessions, `stale-${kind}.jsonl`)
    const actual = join(sessions, `${id}.jsonl`)
    if (kind === 'mismatched') writeFileSync(stale, `${JSON.stringify({ type: 'session', id: 'other', cwd: root })}\n`)
    writeFileSync(actual, `${JSON.stringify({ type: 'session', id, cwd: root })}\n`)
    store.upsert({ sessionId: id, cwd: root, sessionFile: stale })

    assert.equal((await repository.find(id, root))?.sessionFile, actual)
    assert.equal(store.get(id)?.sessionFile, actual)
  }
})

test('repository.find overlaps header reads with bounded concurrency', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-concurrent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  for (let i = 0; i < 64; i++) {
    writeFileSync(join(sessions, `${i}.jsonl`), `${JSON.stringify({ type: 'session', id: `id-${i}`, cwd: root })}\n`)
  }

  const realOpen = fs.promises.open
  let pending = 0
  let maxPending = 0
  let opened!: () => void
  const firstOpen = new Promise<void>(resolve => (opened = resolve))
  let release!: () => void
  const allowOpens = new Promise<void>(resolve => (release = resolve))
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
    pending++
    maxPending = Math.max(maxPending, pending)
    opened()
    await allowOpens
    pending--
    return realOpen(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const repository = new SessionRepository(
    new SessionStore(join(root, 'map.json')),
    { PI_CODING_AGENT_SESSION_DIR: sessions },
    join(root, 'agent')
  )
  const found = repository.find('id-63', root)
  await firstOpen
  await new Promise<void>(resolve => setImmediate(resolve))
  const opensBeforeRelease = maxPending
  release()
  assert.equal((await found)?.sessionId, 'id-63')
  assert.ok(opensBeforeRelease > 1, 'header reads must overlap')
  assert.ok(opensBeforeRelease <= 16, 'header reads must not create unbounded open requests')
})

test('repository.find sticks to a valid mapped duplicate across roots', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-roots-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storedDir = join(root, 'a-stored')
  const discoveryDir = join(root, 'z-discovery')
  mkdirSync(storedDir)
  mkdirSync(discoveryDir)
  const storedFile = join(storedDir, 'duplicate.jsonl')
  const discoveredFile = join(discoveryDir, 'duplicate.jsonl')
  for (const path of [storedFile, discoveredFile]) {
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', id: 'duplicate', cwd: root })}\n${JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: path } })}\n`
    )
  }
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'duplicate', cwd: root, sessionFile: storedFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: discoveryDir }, join(root, 'agent'))
  assert.equal((await repository.find('duplicate', root))?.sessionFile, storedFile)
  assert.equal(store.get('duplicate')?.sessionFile, storedFile)
  assert.equal(await repository.delete('duplicate'), discoveredFile)
  assert.equal(existsSync(storedFile), false)
  assert.equal(existsSync(discoveredFile), false)
  assert.equal(await repository.find('duplicate', root), null)
})

test('repository.find repairs stale stored cwd for cwd-relative duplicate discovery on delete', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-stale-cwd-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'actual')
  const sessions = join(cwd, 'sessions')
  const nested = join(sessions, 'nested')
  mkdirSync(nested, { recursive: true })
  const mappedFile = join(nested, 'duplicate.jsonl')
  const siblingFile = join(sessions, 'duplicate.jsonl')
  for (const path of [mappedFile, siblingFile]) {
    writeFileSync(path, `${JSON.stringify({ type: 'session', id: 'duplicate', cwd })}\n`)
  }
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'duplicate', cwd: join(root, 'stale'), sessionFile: mappedFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: 'sessions' }, join(root, 'agent'))

  assert.equal((await repository.find('duplicate', cwd))?.sessionFile, mappedFile)
  assert.equal(store.get('duplicate')?.cwd, cwd)
  assert.equal(store.get('duplicate')?.sessionFile, mappedFile)
  assert.notEqual(await repository.delete('duplicate'), null)
  assert.equal(existsSync(mappedFile), false)
  assert.equal(existsSync(siblingFile), false)
  assert.equal(await repository.find('duplicate', cwd), null)
})

test('repository.find propagates file descriptor exhaustion from the mapped file', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-find-exhaustion-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const sessionFile = join(sessions, 'wanted.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n`)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile })
  const realOpen = fs.promises.open
  t.mock.method(fs.promises, 'open', (...args: Parameters<typeof realOpen>) => {
    if (args[0] === sessionFile) return Promise.reject(Object.assign(new Error('open failed'), { code: 'EMFILE' }))
    return realOpen(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))
  await assert.rejects(repository.find('wanted', root), { code: 'EMFILE' })
  assert.equal(store.get('wanted')?.sessionFile, sessionFile)
})

test('repository.delete fails closed on a file descriptor exhaustion error', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-exhaustion-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const storedFile = join(sessions, 'stored.jsonl')
  const blockedFile = join(sessions, 'blocked.jsonl')
  for (const path of [storedFile, blockedFile]) {
    writeFileSync(path, `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n`)
  }
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: storedFile })
  const realOpen = fs.promises.open
  t.mock.method(fs.promises, 'open', (...args: Parameters<typeof realOpen>) => {
    if (args[0] === blockedFile) return Promise.reject(Object.assign(new Error('open failed'), { code: 'EMFILE' }))
    return realOpen(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))
  await assert.rejects(repository.delete('wanted'), { code: 'EMFILE' })
  assert.equal(existsSync(storedFile), true)
  assert.equal(existsSync(blockedFile), true)
  assert.equal(store.get('wanted')?.sessionFile, storedFile)
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

test('repository.list: foreign metadata scan work is skipped except for competing duplicate IDs', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-cost-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const local = join(root, 'local')
  const foreign = join(root, 'foreign')
  function add(name: string, id: string, cwd: string, timestamp: string) {
    const path = join(sessions, name + '.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session', id, cwd }),
        JSON.stringify({
          type: 'message',
          timestamp,
          message: { role: 'user', content: name }
        })
      ].join('\n') + '\n'
    )
    return path
  }
  add('old-local', 'duplicate', local, '2026-01-01T00:00:00Z')
  add('new-foreign', 'duplicate', foreign, '2026-01-02T00:00:00Z')
  const wanted = add('wanted', 'wanted', local, '2026-01-01T00:00:00Z')
  for (let i = 0; i < 30; i++) add(`foreign-${i}`, `foreign-${i}`, foreign, '2026-01-01T00:00:00Z')
  const scanned: string[] = []
  const create = fs.createReadStream
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    scanned.push(String(args[0]))
    return create(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const repository = new SessionRepository(
    new SessionStore(join(root, 'map.json')),
    { PI_CODING_AGENT_SESSION_DIR: sessions },
    join(root, 'agent')
  )
  assert.deepEqual(
    (await repository.list(local)).map(record => record.sessionFile),
    [wanted]
  )
  assert.equal(scanned.length, 3, 'only scoped records and their duplicate competitors require full metadata')
  scanned.length = 0
  assert.equal((await repository.list()).length, 32, 'unscoped cross-project discovery remains available')
  assert.equal(scanned.length, 33)
})
