import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
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

test('repository.list retains only validated in-scope winners without replacing a mapped foreign owner', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-list-mappings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const foreign = join(root, 'foreign')
  const sessions = join(cwd, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const writeSession = (name: string, id: string, owner: string, timestamp: string) => {
    const path = join(sessions, `${name}.jsonl`)
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', id, cwd: owner })}\n${JSON.stringify({ type: 'session_info', timestamp, name })}\n`
    )
    return path
  }
  const oldFile = writeSession('old-local', 'wanted', cwd, '2026-01-01T00:00:00Z')
  const wantedFile = writeSession('new-local', 'wanted', cwd, '2026-01-02T00:00:00Z')
  writeSession('foreign', 'foreign', foreign, '2026-01-01T00:00:00Z')
  writeSession('old-local-copy', 'foreign-winner', cwd, '2026-01-01T00:00:00Z')
  writeSession('new-foreign-copy', 'foreign-winner', foreign, '2026-01-02T00:00:00Z')
  const mappedForeign = writeSession('mapped-foreign', 'mapped', foreign, '2026-01-01T00:00:00Z')
  writeSession('new-local-copy', 'mapped', cwd, '2026-01-02T00:00:00Z')
  const invalidFile = join(sessions, 'invalid.jsonl')
  writeFileSync(invalidFile, `${JSON.stringify({ type: 'message', id: 'invalid', cwd })}\n`)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'mapped', cwd: foreign, sessionFile: mappedForeign })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: 'sessions' }, join(root, 'agent'))

  assert.deepEqual(
    (await repository.list(cwd)).map(record => [record.sessionId, record.sessionFile]),
    [['wanted', wantedFile]]
  )
  assert.equal(store.get('wanted')?.sessionFile, wantedFile)
  assert.equal(store.get('wanted')?.cwd, cwd)
  for (const id of ['foreign', 'foreign-winner', 'invalid']) assert.equal(store.get(id), null)
  assert.equal(store.get('mapped')?.sessionFile, mappedForeign)
  assert.equal(store.get('mapped')?.cwd, foreign)
  const upsert = t.mock.method(store, 'upsert')
  assert.deepEqual(
    (await repository.list(cwd)).map(record => record.sessionFile),
    [wantedFile]
  )
  assert.equal(upsert.mock.callCount(), 0, 'unchanged validated mappings must not be rewritten')

  assert.equal(await repository.delete('wanted'), wantedFile)
  assert.equal(existsSync(oldFile), false)
  assert.equal(existsSync(wantedFile), false)
  assert.equal(existsSync(mappedForeign), true)
  assert.equal(existsSync(invalidFile), true)
  assert.equal(store.get('wanted'), null)
  assert.deepEqual(await repository.list(cwd), [])
})

test('repository.list preserves a canonical owner established after its mapping snapshot', async t => {
  for (const owner of ['foreign', 'local']) {
    await t.test(owner, async t => {
      const { rmSync } = await import('node:fs')
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-list-owner-race-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const cwd = join(root, 'project')
      const canonicalCwd = owner === 'foreign' ? join(root, 'other-project') : cwd
      const writeSession = (project: string, name: string, timestamp: string) => {
        const sessions = join(project, 'sessions')
        mkdirSync(sessions, { recursive: true })
        const path = join(sessions, `${name}.jsonl`)
        writeFileSync(
          path,
          `${JSON.stringify({ type: 'session', id: 'duplicate', cwd: project })}\n${JSON.stringify({ type: 'session_info', timestamp, name })}\n`
        )
        return path
      }
      const localFile = writeSession(cwd, 'newer-local', '2026-01-02T00:00:00Z')
      const canonicalFile = writeSession(canonicalCwd, 'canonical', '2026-01-01T00:00:00Z')
      const store = new SessionStore(join(root, 'map.json'))
      const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: 'sessions' }, join(root, 'agent'))
      const realList = store.list.bind(store)
      let captured!: () => void
      const snapshotCaptured = new Promise<void>(resolve => (captured = resolve))
      let release!: () => void
      const resumeList = new Promise<void>(resolve => (release = resolve))
      t.mock.method(store, 'list', async () => {
        const snapshot = await realList()
        captured()
        await resumeList
        return snapshot
      })

      const listing = repository.list(cwd)
      await snapshotCaptured
      try {
        assert.equal(store.get('duplicate'), null)
        if (owner === 'foreign') {
          assert.equal((await repository.find('duplicate', canonicalCwd))?.sessionFile, canonicalFile)
        } else {
          repository.upsert({
            sessionId: 'duplicate',
            cwd: canonicalCwd,
            sessionFile: canonicalFile
          })
        }
        assert.equal(store.get('duplicate')?.sessionFile, canonicalFile)
      } finally {
        release()
      }
      const records = await listing
      assert.equal(store.get('duplicate')?.sessionFile, canonicalFile, 'stale listing must not replace the owner')
      assert.equal(store.get('duplicate')?.cwd, canonicalCwd)
      assert.deepEqual(
        records.map(record => [record.sessionFile, record.title]),
        owner === 'foreign' ? [] : [[canonicalFile, 'canonical']],
        'listing must use the current validated canonical record, not expose a stale duplicate'
      )
      assert.equal((await repository.find('duplicate', canonicalCwd))?.sessionFile, canonicalFile)
      assert.equal(existsSync(localFile), true)
      assert.equal(existsSync(canonicalFile), true)
    })
  }
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

test('repository.delete preserves mappings and all copies on unexpected header IO failures', async t => {
  for (const stage of ['open', 'read']) {
    for (const blocked of ['mapped', 'discovered']) {
      for (const code of ['EACCES', 'EIO']) {
        await t.test(`${stage} ${blocked} ${code}`, async t => {
          const { default: fs } = await import('node:fs')
          const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-unreadable-delete-'))
          t.after(() => fs.rmSync(root, { recursive: true, force: true }))
          const sessions = join(root, 'sessions')
          mkdirSync(sessions)
          const storedFile = join(sessions, 'stored.jsonl')
          const discoveredFile = join(sessions, 'discovered.jsonl')
          const content = `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n`
          for (const path of [storedFile, discoveredFile]) writeFileSync(path, content)
          const mapPath = join(root, 'map.json')
          const store = new SessionStore(mapPath)
          store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: storedFile })
          const mapping = store.get('wanted')
          const blockedFile = blocked === 'mapped' ? storedFile : discoveredFile
          const error = Object.assign(new Error('header failed'), { code })
          const realOpen = fs.promises.open
          let closed = false
          t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
            if (args[0] === blockedFile && stage === 'open') throw error
            const handle = await realOpen(...args)
            if (args[0] === blockedFile) {
              t.mock.method(handle, 'read', async () => {
                throw error
              })
              const close = handle.close.bind(handle)
              t.mock.method(handle, 'close', async () => {
                await close()
                closed = true
              })
            }
            return handle
          })
          syncBuiltinESMExports()
          t.after(() => {
            t.mock.restoreAll()
            syncBuiltinESMExports()
          })
          const repository = new SessionRepository(
            store,
            { PI_CODING_AGENT_SESSION_DIR: sessions },
            join(root, 'agent')
          )

          await assert.rejects(repository.delete('wanted'), error)
          for (const path of [storedFile, discoveredFile]) assert.equal(fs.readFileSync(path, 'utf8'), content)
          assert.deepEqual(store.get('wanted'), mapping)
          assert.deepEqual(new SessionStore(mapPath).get('wanted'), mapping)
          if (stage === 'read') assert.equal(closed, true, 'failed header reads must close their handle')
        })
      }
    }
  }
})

test('repository.delete remains idempotent for a legitimately missing mapped file', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-missing-delete-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  const sessionFile = join(sessions, 'missing.jsonl')
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'missing', cwd: root, sessionFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  assert.equal(await repository.delete('missing'), null)
  assert.equal(existsSync(sessionFile), false)
  assert.equal(store.get('missing'), null)
  assert.equal(await repository.delete('missing'), null)
})

test('repository.delete remains idempotent when a mapped file ancestor is not a directory', async t => {
  const { readFileSync, rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-enotdir-delete-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  writeFileSync(sessions, 'not a directory')
  const sessionFile = join(sessions, 'missing.jsonl')
  const mapPath = join(root, 'map.json')
  const store = new SessionStore(mapPath)
  store.upsert({ sessionId: 'missing', cwd: root, sessionFile })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  assert.equal(existsSync(sessionFile), false)
  assert.equal(await repository.delete('missing'), null)
  assert.equal(readFileSync(sessions, 'utf8'), 'not a directory')
  assert.equal(store.get('missing'), null)
  assert.equal(new SessionStore(mapPath).get('missing'), null)
  assert.equal(await repository.delete('missing'), null)
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

test('repository carries additional directories through find and list refreshes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-roots-'))
  const sessions = join(root, 'sessions')
  const sessionFile = join(sessions, 'roots.jsonl')
  mkdirSync(sessions)
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', id: 'with-roots', cwd: root }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n'
  )
  const unmapped = join(sessions, 'unmapped.jsonl')
  writeFileSync(
    unmapped,
    [
      JSON.stringify({ type: 'session', id: 'no-mapping', cwd: root }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n'
  )

  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'with-roots', cwd: root, sessionFile, additionalDirectories: ['/ws/one', '/ws/two'] })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  // find() reports the stored ordered roots for a mapped record...
  assert.deepEqual((await repository.find('with-roots', root))?.additionalDirectories, ['/ws/one', '/ws/two'])
  // ...and none for a session discovered without adapter metadata.
  assert.deepEqual((await repository.find('no-mapping', root))?.additionalDirectories, [])

  const listed = await repository.list(root)
  assert.deepEqual(
    listed.map(record => [record.sessionId, record.additionalDirectories]),
    [
      ['with-roots', ['/ws/one', '/ws/two']],
      ['no-mapping', []]
    ]
  )

  // A discovery upsert must not clear the recorded roots.
  store.upsert({ sessionId: 'with-roots', cwd: root, sessionFile: join(sessions, 'displaced.jsonl') })
  assert.deepEqual(store.get('with-roots')?.additionalDirectories, ['/ws/one', '/ws/two'])
  assert.deepEqual((await repository.find('with-roots', root))?.additionalDirectories, ['/ws/one', '/ws/two'])
})

test('repository.list scopes sessions by cwd filesystem identity, not realpath', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-cwd-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const parent = join(root, 'paths')
  const workspaceProject = join(parent, 'project')
  const otherProject = join(parent, 'other', 'project')
  mkdirSync(join(parent, 'other', 'nested'), { recursive: true })
  mkdirSync(workspaceProject)
  mkdirSync(otherProject)
  symlinkSync(join(parent, 'other', 'nested'), join(parent, 'link'))
  // `parent/link/..` is physically `parent/other`, so the raw path records a
  // session in otherProject even though it lexically collapses to workspaceProject.
  const raw = `${parent}/link/../project`
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const writeSession = (name: string, cwd: string) =>
    writeFileSync(join(sessions, `${name}.jsonl`), `${JSON.stringify({ type: 'session', id: name, cwd })}\n`)
  writeSession('raw-cwd', raw)
  writeSession('direct-cwd', workspaceProject)
  const repository = new SessionRepository(
    new SessionStore(join(root, 'map.json')),
    { PI_CODING_AGENT_SESSION_DIR: sessions },
    join(root, 'agent')
  )

  assert.deepEqual(
    (await repository.list(workspaceProject)).map(record => record.sessionId),
    ['direct-cwd'],
    'a physically different directory reached through symlink/.. stays out of scope'
  )
  assert.deepEqual(
    (await repository.list(raw)).map(record => record.sessionId),
    ['raw-cwd'],
    'the raw path scopes to its physical target only'
  )

  // Bun 1.4.2's realpathSync.native lexically collapses `symlink/..` and
  // resolves the raw path to workspaceProject; emulate that runtime to
  // prove list filtering discriminates by identity, not the lying realpath.
  const originalNative = realpathSync.native
  const collapsed = originalNative(workspaceProject)
  realpathSync.native = ((path: string, ...rest: unknown[]) =>
    path === raw
      ? collapsed
      : (originalNative as unknown as (...args: unknown[]) => string)(path, ...rest)) as typeof realpathSync.native
  try {
    assert.equal(realpathSync.native(raw), collapsed, 'precondition: the emulated runtime lies about the raw path')
    assert.deepEqual(
      (await repository.list(workspaceProject)).map(record => record.sessionId),
      ['direct-cwd'],
      'identity, not the collapsed realpath, decides list scope'
    )
    assert.deepEqual(
      (await repository.list(raw)).map(record => record.sessionId),
      ['raw-cwd'],
      'the physically aliased session stays reachable through the raw path'
    )
  } finally {
    realpathSync.native = originalNative
  }
})

test('repository resolves blank and out-of-root missing mappings to null and tombstones them', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-unusable-mappings-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(sessions)
  mkdirSync(elsewhere)
  // A valid sibling of the missing mapped file, same session id: scanning
  // the missing file's parent directory would discover, remap, and unlink it.
  const sentinel = join(elsewhere, 'gone.jsonl')
  writeFileSync(sentinel, `${JSON.stringify({ type: 'session', id: 'gone', cwd: root })}\n`)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'blank', cwd: root, sessionFile: '' })
  store.upsert({ sessionId: 'gone', cwd: root, sessionFile: join(elsewhere, 'absent.jsonl') })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  const realReaddir = fs.promises.readdir
  const enumerated: string[] = []
  t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof realReaddir>) => {
    enumerated.push(String(args[0]))
    return realReaddir(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  assert.equal(await repository.find('blank', root), null)
  assert.equal(await repository.find('gone', root), null)
  assert.equal(await repository.delete('blank'), null)
  assert.equal(store.get('blank'), null, 'a blank mapping tombstones instead of failing')
  assert.equal(await repository.delete('gone'), null)
  assert.equal(store.get('gone'), null, 'a missing out-of-root mapping tombstones instead of failing')
  assert.equal(existsSync(sentinel), true, 'the parent directory of the missing file is never scanned or swept')
  assert.deepEqual(
    [...new Set(enumerated)],
    [sessions],
    'only the configured root is enumerated, never a cwd or missing-file-parent walk'
  )
})

test('repository.find repairs an in-root missing mapping inside a dotdot-prefixed directory', async t => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-dotdot-archive-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  mkdirSync(join(sessions, '..archive'), { recursive: true })
  const actual = join(sessions, 'wanted.jsonl')
  writeFileSync(actual, `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n`)
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: join(sessions, '..archive', 'old.jsonl') })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  // `..archive` is an ordinary in-root directory name: the missing mapping
  // stays repairable through configured-root discovery.
  assert.equal((await repository.find('wanted', root))?.sessionFile, actual)
  assert.equal(store.get('wanted')?.sessionFile, actual)
})

test('repository projects an out-of-root mapping directly and never scans its parent directory', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-out-of-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(sessions)
  mkdirSync(elsewhere)
  const mapped = join(elsewhere, 'mapped.jsonl')
  const newerDuplicate = join(elsewhere, 'newer-duplicate.jsonl')
  const writeSession = (path: string, timestamp: string) =>
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', id: 'wanted', cwd: root })}\n${JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: path } })}\n`
    )
  writeSession(mapped, '2026-01-01T00:00:00.000Z')
  writeSession(newerDuplicate, '2026-01-02T00:00:00.000Z')
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: mapped })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  const realReaddir = fs.promises.readdir
  const enumerated: string[] = []
  t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof realReaddir>) => {
    enumerated.push(String(args[0]))
    return realReaddir(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  assert.equal((await repository.find('wanted', root))?.sessionFile, mapped, 'the mapped file is used directly')
  // A parent-directory scan would surface the newer duplicate: it would win
  // the newest comparison and be unlinked alongside the mapped file.
  assert.equal(await repository.delete('wanted'), mapped, 'only the mapped file, never the out-of-root sibling')
  assert.equal(existsSync(mapped), false)
  assert.equal(existsSync(newerDuplicate), true, 'the parent directory was never scanned or swept')
  assert.equal(await repository.find('wanted', root), null)
  assert.deepEqual(
    [...new Set(enumerated)],
    [sessions],
    'find and delete enumerate only the configured root, never the mapped file parent'
  )
})

test('repository.list projects an out-of-root mapping without surfacing its unmapped siblings', async t => {
  const { default: fs } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-repository-out-of-root-list-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(sessions)
  mkdirSync(elsewhere)
  const writeSession = (path: string, id: string, timestamp: string) =>
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', id, cwd: root })}\n${JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: id } })}\n`
    )
  const mapped = join(elsewhere, 'mapped.jsonl')
  writeSession(mapped, 'wanted', '2026-01-01T00:00:00.000Z')
  writeSession(join(elsewhere, 'sibling.jsonl'), 'sibling', '2026-01-02T00:00:00.000Z')
  const store = new SessionStore(join(root, 'map.json'))
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: mapped })
  const repository = new SessionRepository(store, { PI_CODING_AGENT_SESSION_DIR: sessions }, join(root, 'agent'))

  const realReaddir = fs.promises.readdir
  const enumerated: string[] = []
  t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof realReaddir>) => {
    enumerated.push(String(args[0]))
    return realReaddir(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  assert.deepEqual(
    (await repository.list(root)).map(record => [record.sessionId, record.sessionFile]),
    [['wanted', mapped]]
  )
  assert.deepEqual(
    [...new Set(enumerated)],
    [join(root, 'map.json.d'), sessions],
    'list enumerates only the configured discovery root and its own state directory, never the mapped file parent'
  )
})
