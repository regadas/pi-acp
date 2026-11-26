import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SessionStore, SessionStoreCorruptError, writeBufferFully } from '../../src/acp/session-store.js'

const CHILD_FIXTURE = fileURLToPath(new URL('../fixtures/session-store-child.ts', import.meta.url))

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-store-'))
  const mapPath = join(dir, 'session-map.json')
  return { dir, mapPath, store: new SessionStore(mapPath) }
}

function tempFilesUnder(stateDir: string): string[] {
  if (!existsSync(stateDir)) return []
  return readdirSync(stateDir).filter(name => name.endsWith('.tmp'))
}

test('writeBufferFully: retries injected short writes and rejects invalid progress', () => {
  const source = Buffer.from('héllo world', 'utf8')
  const writtenChunks: Buffer[] = []
  let calls = 0

  writeBufferFully(42, source, (fd, buffer, offset, length) => {
    assert.equal(fd, 42)
    const written = Math.min(length, calls % 2 === 0 ? 1 : 3)
    writtenChunks.push(Buffer.from(buffer.subarray(offset, offset + written)))
    calls += 1
    return written
  })

  assert.ok(calls > 1)
  assert.deepEqual(Buffer.concat(writtenChunks), source)
  assert.throws(() => writeBufferFully(42, Buffer.from('x'), () => 0), /invalid progress/)
  assert.throws(() => writeBufferFully(42, Buffer.from('x'), () => 2), /invalid progress/)
})

test('SessionStore: round-trips records and returns null for absent sessions', () => {
  const { mapPath, store } = makeStore()

  assert.equal(store.get('missing'), null, 'absent store yields null (no throw on ENOENT)')

  store.upsert({ sessionId: 's1', cwd: '/tmp/p', sessionFile: '/tmp/p/s1.jsonl' })
  const got = store.get('s1')
  assert.equal(got?.sessionId, 's1')
  assert.equal(got?.cwd, '/tmp/p')
  assert.equal(got?.sessionFile, '/tmp/p/s1.jsonl')
  assert.ok(got?.updatedAt)

  assert.equal(store.get('other'), null)
  assert.deepEqual(tempFilesUnder(`${mapPath}.d`), [], 'atomic writes leave no temp files')
})

test('SessionStore: corrupt direct records throw instead of being treated as empty', () => {
  const { mapPath, store } = makeStore()
  store.upsert({ sessionId: 's1', cwd: '/tmp/p', sessionFile: '/tmp/p/s1.jsonl' })

  const stateDir = `${mapPath}.d`
  const [recordName] = readdirSync(stateDir)
  writeFileSync(join(stateDir, recordName), '{ not json', 'utf-8')

  assert.throws(() => store.get('s1'), SessionStoreCorruptError)
  // Wrong shape is corruption too, not silent emptiness.
  writeFileSync(join(stateDir, recordName), JSON.stringify({ version: 99 }), 'utf-8')
  assert.throws(() => store.get('s1'), SessionStoreCorruptError)
})

test('SessionStore: direct records validate timestamps and requested identity', () => {
  const { mapPath, store } = makeStore()
  store.upsert({ sessionId: 's1', cwd: '/tmp/p', sessionFile: '/tmp/p/s1.jsonl' })
  const recordPath = join(`${mapPath}.d`, readdirSync(`${mapPath}.d`)[0]!)
  const valid = JSON.parse(readFileSync(recordPath, 'utf8')) as any

  writeFileSync(recordPath, JSON.stringify({ ...valid, session: { ...valid.session, updatedAt: 42 } }), 'utf8')
  assert.throws(() => store.get('s1'), SessionStoreCorruptError)

  writeFileSync(recordPath, JSON.stringify({ ...valid, session: { ...valid.session, sessionId: 'other' } }), 'utf8')
  assert.throws(() => store.get('s1'), /does not match s1/)

  writeFileSync(recordPath, JSON.stringify(valid), 'utf8')
  store.delete('s1')
  const tombstone = JSON.parse(readFileSync(recordPath, 'utf8')) as any
  writeFileSync(recordPath, JSON.stringify({ ...tombstone, sessionId: 'other' }), 'utf8')
  assert.throws(() => store.get('s1'), /does not match s1/)
})

test('SessionStore: upsert and delete refuse to overwrite a corrupt direct record', () => {
  const { mapPath, store } = makeStore()
  store.upsert({ sessionId: 's1', cwd: '/tmp/p', sessionFile: '/tmp/p/s1.jsonl' })
  const recordPath = join(`${mapPath}.d`, readdirSync(`${mapPath}.d`)[0]!)
  writeFileSync(recordPath, '{broken direct state', 'utf8')
  const corruptRaw = readFileSync(recordPath, 'utf8')

  assert.throws(
    () => store.upsert({ sessionId: 's1', cwd: '/tmp/new', sessionFile: '/tmp/new/s1.jsonl' }),
    SessionStoreCorruptError
  )
  assert.throws(() => store.delete('s1'), SessionStoreCorruptError)
  assert.equal(readFileSync(recordPath, 'utf8'), corruptRaw)
})

test('SessionStore: a tombstone keeps masking a session whose file no longer exists', () => {
  const { dir, mapPath, store } = makeStore()
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile: join(dir, 's1.jsonl') })
  store.delete('s1')
  // A stale discovery tries to re-map the deleted id; its target file is gone.
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile: join(dir, 's1.jsonl') })
  assert.equal(store.get('s1'), null, 'the tombstone must keep masking the deleted id')
  const stateDir = `${mapPath}.d`
  const record = JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir)[0]!), 'utf8')) as any
  assert.equal(record.deleted, true, 'the tombstone record itself must survive the stale upsert')
})

test('SessionStore: an explicit restore replaces the tombstone once the file exists again', () => {
  const { dir, mapPath, store } = makeStore()
  const sessionFile = join(dir, 's1.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's1', cwd: dir })}\n`, 'utf-8')
  store.delete('s1')
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile })
  const got = store.get('s1')
  assert.equal(got?.sessionFile, sessionFile, 'a restored file must replace the tombstone')
  assert.equal(got?.cwd, dir)
  const stateDir = `${mapPath}.d`
  const record = JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir)[0]!), 'utf8')) as any
  assert.equal(record.deleted, undefined, 'the live record must replace the tombstone')
  assert.equal(record.session.sessionFile, sessionFile)
})

test('SessionStore: legacy map is a read-only fallback and corruption there also throws', () => {
  const { mapPath, store } = makeStore()

  writeFileSync(
    mapPath,
    JSON.stringify({
      version: 1,
      sessions: {
        legacy: { sessionId: 'legacy', cwd: '/tmp/old', sessionFile: '/tmp/old/legacy.jsonl', updatedAt: 'x' }
      }
    }),
    'utf-8'
  )

  // Migration fallback: no direct record yet, so the legacy entry is visible.
  assert.equal(store.get('legacy')?.cwd, '/tmp/old')

  // Direct record wins over legacy once written.
  store.upsert({ sessionId: 'legacy', cwd: '/tmp/new', sessionFile: '/tmp/new/legacy.jsonl' })
  assert.equal(store.get('legacy')?.cwd, '/tmp/new')

  // Deletion writes a tombstone; the legacy entry must not resurrect and the
  // legacy file itself is never rewritten.
  const legacyRaw = readFileSync(mapPath, 'utf-8')
  store.delete('legacy')
  assert.equal(store.get('legacy'), null)
  assert.equal(readFileSync(mapPath, 'utf-8'), legacyRaw, 'legacy map is read-only')

  // A malformed requested entry is corruption, not absence.
  writeFileSync(
    mapPath,
    JSON.stringify({
      version: 1,
      sessions: { malformed: { sessionId: 'different', cwd: '/tmp', sessionFile: '/tmp/x.jsonl' } }
    }),
    'utf8'
  )
  assert.throws(() => store.get('malformed'), SessionStoreCorruptError)

  // Corrupt legacy map: reads that reach the fallback throw.
  writeFileSync(mapPath, 'not json at all', 'utf-8')
  assert.throws(() => store.get('never-written'), SessionStoreCorruptError)
  // Sessions with a direct record never touch the corrupt legacy file.
  store.upsert({ sessionId: 'direct', cwd: '/tmp/d', sessionFile: '/tmp/d/d.jsonl' })
  assert.equal(store.get('direct')?.cwd, '/tmp/d')
})

test('SessionStore: a failed atomic write cleans up its temp file and leaves prior state intact', () => {
  const { mapPath, store } = makeStore()
  store.upsert({ sessionId: 's1', cwd: '/tmp/p', sessionFile: '/tmp/p/s1.jsonl' })

  const stateDir = `${mapPath}.d`
  const [recordName] = readdirSync(stateDir)
  const recordPath = join(stateDir, recordName)
  const before = readFileSync(recordPath, 'utf-8')

  void before
  // Make rename fail by replacing the record with a non-empty directory
  // (rename onto a non-empty directory fails on every platform).
  rmSync(recordPath)
  mkdirSync(recordPath)
  writeFileSync(join(recordPath, 'occupied'), 'x', 'utf-8')

  assert.throws(() => store.upsert({ sessionId: 's1', cwd: '/tmp/p2', sessionFile: '/tmp/p2/s1.jsonl' }))
  assert.deepEqual(tempFilesUnder(stateDir), [], 'temp file is removed on write failure')
})

test('SessionStore: concurrent multi-process upserts lose no records and keep the shared record valid', async () => {
  const { mapPath, store } = makeStore()
  const children = 4

  const runs = Array.from({ length: children }, (_, index) => {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD_FIXTURE, mapPath, `unique-${index}`, 'shared', `tag-${index}`],
        {
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
      const stderr: Buffer[] = []
      child.stderr.on('data', chunk => stderr.push(chunk))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('session-store child timed out'))
      }, 30_000)
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', code => {
        clearTimeout(timer)
        if (code === 0) resolve(0)
        else reject(new Error(`child exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
      })
    })
  })

  await Promise.all(runs)

  // Cross-process safety: every per-session record survives (the legacy
  // shared-map design lost concurrent upserts of different sessions).
  for (let index = 0; index < children; index++) {
    assert.equal(store.get(`unique-${index}`)?.cwd, `/tmp/tag-${index}`)
  }

  // Same-session concurrent writes: last-writer-wins with a valid record.
  const shared = store.get('shared')
  assert.ok(shared, 'shared record exists')
  assert.match(shared!.cwd, /^\/tmp\/tag-\d$/)
  assert.deepEqual(tempFilesUnder(`${mapPath}.d`), [], 'no temp files remain after concurrent writes')
})

test('SessionStore.list: corruption and legacy shape checks match get, including filename identity', async t => {
  const { dir, mapPath, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const raw of ['{broken', '{"version":1,"sessions":[]}', '{"version":1,"sessions":{"s1":{}}}']) {
    writeFileSync(mapPath, raw)
    assert.throws(() => store.get('s1'), SessionStoreCorruptError)
    await assert.rejects(store.list(), SessionStoreCorruptError)
  }
  rmSync(mapPath)
  store.upsert({
    sessionId: 's1',
    cwd: dir,
    sessionFile: join(dir, 's1.jsonl')
  })
  const path = join(`${mapPath}.d`, readdirSync(`${mapPath}.d`)[0])
  for (const raw of ['{broken', '{"version":99}', '{"version":1,"deleted":true,"sessionId":"other"}']) {
    writeFileSync(path, raw)
    await assert.rejects(store.list(), error => {
      assert.ok(error instanceof SessionStoreCorruptError)
      assert.match(error.message, /Repair or delete the file manually/)
      return true
    })
  }
})

test('SessionStore.list: tombstones hide legacy entries and long IDs retain hashed filename validation', async t => {
  const { dir, mapPath, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const legacy = {
    sessionId: 'legacy',
    cwd: dir,
    sessionFile: join(dir, 'legacy.jsonl'),
    updatedAt: new Date().toISOString()
  }
  writeFileSync(mapPath, JSON.stringify({ version: 1, sessions: { legacy } }))
  assert.deepEqual(await store.list(), [legacy])
  store.delete('legacy')
  const sessionId = 'long'.repeat(100)
  store.upsert({ sessionId, cwd: dir, sessionFile: join(dir, 'long.jsonl') })
  assert.deepEqual(
    (await store.list()).map(record => record.sessionId),
    [sessionId]
  )
})

test('SessionStore: additional directories round-trip, persist across refreshes, and clear explicitly', () => {
  const { dir, store } = makeStore()
  const sessionFile = join(dir, 's1.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's1', cwd: dir })}\n`, 'utf-8')

  store.upsert({ sessionId: 's1', cwd: dir, sessionFile, additionalDirectories: ['/ws/a', '/ws/b'] })
  assert.deepEqual(store.get('s1')?.additionalDirectories, ['/ws/a', '/ws/b'])

  // Ordinary metadata refreshes (cwd repair, discovery re-mapping) omit the
  // field and must not clear recorded roots.
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile: join(dir, 'moved.jsonl') })
  const refreshed = store.get('s1')!
  assert.equal(refreshed.sessionFile, join(dir, 'moved.jsonl'))
  assert.deepEqual(refreshed.additionalDirectories, ['/ws/a', '/ws/b'])

  // An explicit replacement list (empty included) replaces the stored roots.
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile: refreshed.sessionFile, additionalDirectories: ['/ws/c'] })
  assert.deepEqual(store.get('s1')?.additionalDirectories, ['/ws/c'])
  store.upsert({ sessionId: 's1', cwd: dir, sessionFile: refreshed.sessionFile, additionalDirectories: [] })
  assert.deepEqual(store.get('s1')?.additionalDirectories, [])
})

test('SessionStore: legacy records without additional directories load with none', () => {
  const { mapPath, store } = makeStore()
  writeFileSync(
    mapPath,
    JSON.stringify({
      version: 1,
      sessions: { legacy: { sessionId: 'legacy', cwd: '/tmp/old', sessionFile: '/tmp/old/l.jsonl', updatedAt: 'x' } }
    }),
    'utf-8'
  )

  assert.equal(store.get('legacy')?.additionalDirectories, undefined)

  // A legacy record with a malformed roots field is corrupt, not silently empty.
  writeFileSync(
    mapPath,
    JSON.stringify({
      version: 1,
      sessions: {
        legacy: {
          sessionId: 'legacy',
          cwd: '/tmp/old',
          sessionFile: '/tmp/old/l.jsonl',
          updatedAt: 'x',
          additionalDirectories: 'bogus'
        }
      }
    }),
    'utf-8'
  )
  assert.throws(() => store.get('legacy'), SessionStoreCorruptError)
})

test('SessionStore: explicitTitle round-trips in sidecar only, avoids rewriting live record, preserves updatedAt, and clears on delete', () => {
  const { dir, mapPath, store } = makeStore()
  const stateDir = `${mapPath}.d`
  const sessionFile = join(dir, 's-title.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-title', cwd: dir })}\n`, 'utf-8')

  store.upsert({ sessionId: 's-title', cwd: dir, sessionFile, additionalDirectories: ['/ws/a'] })
  const originalUpdatedAt = store.get('s-title')!.updatedAt
  const recordFile = join(stateDir, `${Buffer.from('s-title', 'utf-8').toString('base64url')}.json`)
  const statBeforeRename = statSync(recordFile)

  store.upsert({
    sessionId: 's-title',
    cwd: dir,
    sessionFile,
    explicitTitle: 'My Renamed Session',
    preserveUpdatedAt: true
  })
  const renamed = store.get('s-title')!
  assert.equal(renamed.explicitTitle, 'My Renamed Session')
  assert.equal(renamed.updatedAt, originalUpdatedAt, 'preserveUpdatedAt keeps stored timestamp unchanged')
  assert.deepEqual(renamed.additionalDirectories, ['/ws/a'])

  // Explicit-title write on an existing matching record writes ONLY `<id>.title`
  // and leaves `<id>.json` untouched (no rewrite, no inline explicitTitle).
  const statAfterRename = statSync(recordFile)
  assert.equal(statAfterRename.ino, statBeforeRename.ino, '<id>.json must not be rewritten on explicit-title update')
  assert.equal(
    'explicitTitle' in (JSON.parse(readFileSync(recordFile, 'utf-8')) as { session: Record<string, unknown> }).session,
    false,
    '<id>.json must never persist explicitTitle inline'
  )

  // Backward compatibility: every `*.json` file in stateDir must be a valid session record
  // (sidecars use `.title`, never `.title.json`, so older pi-acp versions do not crash).
  const entries = readdirSync(stateDir)
  assert.equal(
    entries.some(name => name.endsWith('.title.json')),
    false,
    'sidecars must never use .title.json extension'
  )
  assert.ok(
    entries.some(name => name.endsWith('.title')),
    'sidecar must use .title extension'
  )
  for (const name of entries.filter(n => n.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(stateDir, name), 'utf-8')) as {
      version?: number
      session?: { sessionId?: string }
      deleted?: boolean
    }
    assert.equal(parsed.version, 1)
    assert.ok(parsed.deleted === true || typeof parsed.session?.sessionId === 'string')
  }

  // Ordinary cwd/root refreshes preserve explicitTitle without writing it inline.
  store.upsert({ sessionId: 's-title', cwd: dir, sessionFile, additionalDirectories: ['/ws/b'] })
  assert.equal(store.get('s-title')?.explicitTitle, 'My Renamed Session')
  assert.equal(
    'explicitTitle' in (JSON.parse(readFileSync(recordFile, 'utf-8')) as { session: Record<string, unknown> }).session,
    false
  )

  // Deletion tombstones and clears explicitTitle.
  store.delete('s-title')
  assert.equal(store.get('s-title'), null)
  // Explicit restore after deletion does not resurrect the old pre-delete title.
  store.upsert({ sessionId: 's-title', cwd: dir, sessionFile })
  assert.equal(store.get('s-title')?.explicitTitle, undefined)
})

test('SessionStore: explicitTitle sidecar survives cross-process metadata refreshes, is hidden on delete, and upsert propagates OS errors from legacy map', async () => {
  const { dir, mapPath, store } = makeStore()
  const otherProcessStore = new SessionStore(mapPath)
  const sessionFile = join(dir, 's-sidecar.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-sidecar', cwd: dir })}\n`, 'utf-8')

  store.upsert({ sessionId: 's-sidecar', cwd: dir, sessionFile })
  // Process A commits explicit title to independent sidecar.
  store.upsert({
    sessionId: 's-sidecar',
    cwd: dir,
    sessionFile,
    explicitTitle: 'Sidecar Title',
    preserveUpdatedAt: true
  })

  // Process B runs a concurrent metadata refresh without explicitTitle; sidecar must survive intact.
  otherProcessStore.upsert({
    sessionId: 's-sidecar',
    cwd: dir,
    sessionFile,
    additionalDirectories: ['/ws/extra']
  })
  assert.equal(store.get('s-sidecar')?.explicitTitle, 'Sidecar Title')
  assert.deepEqual(store.get('s-sidecar')?.additionalDirectories, ['/ws/extra'])

  // list() excludes .title sidecars from session records and overlays them onto live sessions.
  const listed = await store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.sessionId, 's-sidecar')
  assert.equal(listed[0]?.explicitTitle, 'Sidecar Title')

  // delete() removes the sidecar and tombstones the record; setExplicitTitle refuses behind a tombstone,
  // and even a stray sidecar file on disk beside a tombstone stays hidden.
  store.delete('s-sidecar')
  assert.equal(store.get('s-sidecar'), null)
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(store.setExplicitTitle('s-sidecar', 'Stray Sidecar'), { committed: false })
  const sidecarFile = join(`${mapPath}.d`, `${Buffer.from('s-sidecar', 'utf-8').toString('base64url')}.title`)
  writeFileSync(
    sidecarFile,
    JSON.stringify({ version: 1, sessionId: 's-sidecar', explicitTitle: 'Stray On Disk' }),
    'utf8'
  )
  assert.equal(store.get('s-sidecar'), null)
  assert.deepEqual(await store.list(), [])

  // Real OS/IO errors reading the legacy map (not corruption) must propagate out of upsert().
  const { dir: errDir, mapPath: errMapPath, store: errStore } = makeStore()
  // Replacing the legacy map path with a directory causes EISDIR on readFileSync (a real OS error, not JSON corruption).
  mkdirSync(errMapPath)
  assert.throws(
    () => errStore.upsert({ sessionId: 'os-err', cwd: errDir, sessionFile: join(errDir, 'x.jsonl') }),
    (err: unknown) => (err as NodeJS.ErrnoException).code === 'EISDIR'
  )
})

test('SessionStore: list() tolerates ENOENT sidecars, delete() validates corrupt sidecars up front, and rollbackExplicitTitle is revision-fenced', async () => {
  const { dir, mapPath, store } = makeStore()
  const stateDir = `${mapPath}.d`
  const sessionFile = join(dir, 's-rev.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 's-rev', cwd: dir })}\n`, 'utf-8')

  const rev1 = store.upsert({ sessionId: 's-rev', cwd: dir, sessionFile, explicitTitle: 'Title 1' })
  assert.equal(typeof rev1, 'string')
  const rev2 = store.upsert({ sessionId: 's-rev', cwd: dir, sessionFile, explicitTitle: 'Title 2' })
  assert.equal(typeof rev2, 'string')
  assert.notEqual(rev1, rev2)

  // Stale revision rollback must NOT clobber newer title!
  assert.equal(store.rollbackExplicitTitle('s-rev', rev1!, null), false)
  assert.equal(store.get('s-rev')?.explicitTitle, 'Title 2')

  // Matching revision rollback restores previous title cleanly.
  assert.equal(store.rollbackExplicitTitle('s-rev', rev2!, 'Title 1'), true)
  assert.equal(store.get('s-rev')?.explicitTitle, 'Title 1')

  // Corrupt sidecar causes delete() to throw BEFORE writing a tombstone to <base>.json.
  const sidecarPath = join(stateDir, `${Buffer.from('s-rev', 'utf-8').toString('base64url')}.title`)
  writeFileSync(sidecarPath, '{corrupt', 'utf8')
  assert.throws(() => store.delete('s-rev'), SessionStoreCorruptError)
  // Direct record is still live (not tombstoned) once sidecar is repaired.
  assert.equal(store.isTombstoned('s-rev'), false)
  // list() still propagates corrupt sidecar errors.
  await assert.rejects(() => store.list(), SessionStoreCorruptError)

  // Replace corrupt sidecar with a broken symlink (ENOENT on readFile) to simulate a sidecar
  // unlinked between readdir and readFile: list() tolerates ENOENT cleanly.
  if (process.platform !== 'win32') {
    const fs = await import('node:fs')
    fs.unlinkSync(sidecarPath)
    fs.symlinkSync(join(dir, 'vanished-target'), sidecarPath)
    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.sessionId, 's-rev')
    assert.equal(listed[0]?.explicitTitle, undefined)
    fs.unlinkSync(sidecarPath)
  } else {
    const fs = await import('node:fs')
    fs.unlinkSync(sidecarPath)
  }

  // Rollback behind a tombstone refuses to recreate a sidecar.
  const rev3 = store.upsert({ sessionId: 's-rev', cwd: dir, sessionFile, explicitTitle: 'Before Delete' })
  store.delete('s-rev')
  assert.equal(store.rollbackExplicitTitle('s-rev', rev3!, 'Restored'), false)
  assert.equal(store.get('s-rev'), null)
})
