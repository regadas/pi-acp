import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
