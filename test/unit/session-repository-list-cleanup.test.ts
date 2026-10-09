import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionRepository } from '../../src/acp/session-repository.js'
import { SessionStore } from '../../src/acp/session-store.js'

const MIB = 1024 * 1024
const TIMESTAMP = '2026-01-02T03:04:05.000Z'

function fixture(t: TestContext, custom = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-acp-list-cleanup-'))
  const agentDir = join(root, 'agent')
  const sessions = join(agentDir, 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const store = new SessionStore(join(root, 'map.json'))
  const repository = new SessionRepository(store, custom ? { PI_CODING_AGENT_SESSION_DIR: sessions } : {}, agentDir)
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, agentDir, sessions, store, repository }
}

function writeSession(path: string, id: string, cwd: string, title = id, timestamp = TIMESTAMP): string {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(
    path,
    `${JSON.stringify({ type: 'session', id, cwd })}\n${JSON.stringify({
      type: 'message',
      timestamp,
      message: { role: 'user', content: title }
    })}\n`
  )
  return path
}

function countScans(t: TestContext): string[] {
  const scanned: string[] = []
  const create = fs.createReadStream
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof create>) => {
    scanned.push(String(args[0]))
    return create(...args)
  })
  syncBuiltinESMExports()
  return scanned
}

test('repository.list prunes only default artifact discovery, honors mapped headers, and leaves delete exhaustive', async t => {
  const { root, sessions, store, repository } = fixture(t, false)
  const nested = writeSession(join(sessions, '--project--', '2026-01-01_session', 'child.jsonl'), 'child', root)
  const artifactDir = join(sessions, '--project--', '2026-01-01_session', 'subagent-artifacts')
  writeSession(join(dirname(artifactDir), 'subagent-artifacts-old', 'sibling.jsonl'), 'sibling', root)
  const hidden = writeSession(join(artifactDir, 'deep', 'hidden.jsonl'), 'hidden', root)
  const mapped = writeSession(join(artifactDir, 'mapped.jsonl'), 'mapped', root)
  const duplicate = writeSession(join(artifactDir, 'duplicate.jsonl'), 'child', root)
  const invalid = join(artifactDir, 'invalid.jsonl')
  fs.writeFileSync(invalid, '{"type":"message"}\n')
  store.upsert({ sessionId: 'mapped', cwd: root, sessionFile: mapped })
  store.upsert({ sessionId: 'tampered', cwd: root, sessionFile: invalid })
  const realReaddir = fs.promises.readdir
  const enumerated: string[] = []
  t.mock.method(fs.promises, 'readdir', (...args: Parameters<typeof realReaddir>) => {
    enumerated.push(String(args[0]))
    return realReaddir(...args)
  })
  syncBuiltinESMExports()

  assert.deepEqual(
    (await repository.list(root)).map(record => record.sessionId),
    ['child', 'mapped', 'sibling']
  )
  assert.ok(enumerated.includes(dirname(nested)), 'instrumentation must observe real nested session discovery')
  assert.equal(
    enumerated.some(path => path === artifactDir || path.startsWith(join(artifactDir, '/'))),
    false
  )
  assert.equal((await repository.find('hidden', root))?.sessionFile, hidden)
  assert.ok(await repository.delete('child'))
  assert.equal(fs.existsSync(nested), false)
  assert.equal(fs.existsSync(duplicate), false, 'deletion must still discover duplicates in artifact trees')
  assert.equal(fs.existsSync(invalid), true)
})

test('repository.list keeps recursive custom discovery even in subagent-artifacts', async t => {
  const { root, sessions, repository } = fixture(t)
  writeSession(join(sessions, 'subagent-artifacts', 'nested', 'session.jsonl'), 'custom-child', root)
  assert.deepEqual(
    (await repository.list(root)).map(record => record.sessionId),
    ['custom-child']
  )
})

test('repository header reads stop after a small first-line chunk and close the handle', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const path = writeSession(join(sessions, 'short.jsonl'), 'short', root)
  fs.appendFileSync(path, 'x'.repeat(2 * MIB))
  store.upsert({ sessionId: 'short', cwd: root, sessionFile: path })
  const realOpen = fs.promises.open
  const lengths: number[] = []
  let reads = 0
  let closes = 0
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args)
    const read = handle.read.bind(handle)
    const close = handle.close.bind(handle)
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      lengths.push(length)
      reads++
      return read(buffer, offset, length, position)
    })
    t.mock.method(handle, 'close', async () => {
      closes++
      return close()
    })
    return handle
  })
  syncBuiltinESMExports()

  assert.equal((await repository.find('short', root))?.sessionId, 'short')
  assert.equal(reads, 1)
  assert.ok(
    lengths.every(length => length <= 4096),
    'short headers must not request a 1 MiB read'
  )
  assert.equal(closes, 1)
})

test(
  'repository.list resolves each raw cwd once per request and refreshes physical identities',
  { skip: process.platform === 'win32' },
  async t => {
    const { root, sessions, repository } = fixture(t)
    const local = join(root, 'local')
    const foreign = join(root, 'foreign')
    fs.mkdirSync(local)
    fs.mkdirSync(foreign)
    const alias = join(root, 'alias')
    fs.symlinkSync(local, alias, 'dir')
    for (let index = 0; index < 8; index++) {
      writeSession(join(sessions, `${index}.jsonl`), `session-${index}`, local)
    }
    const realpath = fs.realpathSync.native
    const resolved: string[] = []
    t.mock.method(fs.realpathSync, 'native', (...args: Parameters<typeof realpath>) => {
      resolved.push(String(args[0]))
      return realpath(...args)
    })

    assert.equal((await repository.list(alias)).length, 8)
    assert.deepEqual(resolved.sort(), [alias, local].sort())
    fs.unlinkSync(alias)
    fs.symlinkSync(foreign, alias, 'dir')
    resolved.length = 0
    assert.deepEqual(await repository.list(alias), [])
    assert.deepEqual(resolved.sort(), [alias, local].sort(), 'cwd cache must not survive a request')
  }
)

test('repository.list reads global settings once and project settings once per distinct cwd with fresh requests', async t => {
  const { root, agentDir, sessions, store, repository } = fixture(t, false)
  const other = join(root, 'other')
  const globalPath = join(agentDir, 'settings.json')
  const projectPath = join(root, '.pi', 'settings.json')
  const otherProjectPath = join(other, '.pi', 'settings.json')
  fs.mkdirSync(join(root, '.pi'))
  fs.mkdirSync(join(other, '.pi'), { recursive: true })
  fs.writeFileSync(globalPath, JSON.stringify({ sessionDir: sessions }))
  fs.writeFileSync(projectPath, '{}')
  fs.writeFileSync(otherProjectPath, '{}')
  for (let index = 0; index < 8; index++) {
    const cwd = index < 4 ? root : other
    const path = writeSession(join(sessions, `${index}.jsonl`), `session-${index}`, cwd)
    store.upsert({ sessionId: `session-${index}`, cwd, sessionFile: path })
  }
  const read = fs.readFileSync
  const reads: string[] = []
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
    reads.push(String(args[0]))
    return read(...args)
  })
  syncBuiltinESMExports()

  assert.equal((await repository.list(root)).length, 4)
  assert.equal(reads.filter(path => path === globalPath).length, 1)
  assert.equal(reads.filter(path => path === projectPath).length, 1)
  assert.equal(reads.filter(path => path === otherProjectPath).length, 1)
  const next = join(root, 'next')
  writeSession(join(next, 'new.jsonl'), 'new', root)
  fs.writeFileSync(globalPath, JSON.stringify({ sessionDir: next }))
  reads.length = 0
  assert.ok((await repository.list(root)).some(record => record.sessionId === 'new'))
  assert.equal(reads.filter(path => path === globalPath).length, 1)
  assert.equal(reads.filter(path => path === projectPath).length, 1)
  assert.equal(reads.filter(path => path === otherProjectPath).length, 1)
  const projectNext = join(root, 'project-next')
  writeSession(join(projectNext, 'project-new.jsonl'), 'project-new', root)
  fs.writeFileSync(projectPath, JSON.stringify({ sessionDir: projectNext }))
  reads.length = 0
  assert.ok((await repository.list(root)).some(record => record.sessionId === 'project-new'))
  assert.equal(reads.filter(path => path === globalPath).length, 1)
  assert.equal(reads.filter(path => path === projectPath).length, 1)
})

test('repository.list scans canonical mapped duplicates first without scanning losing histories, including foreign mappings', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const foreign = join(root, 'foreign')
  const mapped = writeSession(join(sessions, 'a-mapped.jsonl'), 'local', root, 'canonical')
  writeSession(join(sessions, 'z-newer.jsonl'), 'local', root, 'loser', '2027-01-01T00:00:00Z')
  const foreignMapped = writeSession(join(sessions, 'foreign-mapped.jsonl'), 'foreign', foreign)
  writeSession(join(sessions, 'foreign-local-copy.jsonl'), 'foreign', root)
  store.upsert({ sessionId: 'local', cwd: root, sessionFile: mapped })
  store.upsert({ sessionId: 'foreign', cwd: root, sessionFile: foreignMapped })
  const scanned = countScans(t)

  assert.deepEqual(
    (await repository.list(root)).map(record => [record.sessionId, record.title]),
    [['local', 'canonical']]
  )
  assert.deepEqual(scanned.sort(), [mapped, foreignMapped].sort())
})

test('repository.list defers stat to missing timestamps and normalizes only the selected timestamp', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const timestamped = writeSession(join(sessions, 'timestamped.jsonl'), 'timestamped', root)
  const missing = join(sessions, 'missing.jsonl')
  fs.writeFileSync(missing, `${JSON.stringify({ type: 'session', id: 'missing', cwd: root })}\n`)
  store.upsert({ sessionId: 'timestamped', cwd: root, sessionFile: timestamped })
  store.upsert({ sessionId: 'missing', cwd: root, sessionFile: missing })
  for (let index = 0; index < 20; index++) {
    fs.appendFileSync(timestamped, `${JSON.stringify({ type: 'session_info', timestamp: TIMESTAMP, name: 'title' })}\n`)
  }
  const stat = fs.promises.stat
  const stats: string[] = []
  t.mock.method(fs.promises, 'stat', (...args: Parameters<typeof stat>) => {
    stats.push(String(args[0]))
    return stat(...args)
  })
  const iso = Date.prototype.toISOString
  let normalizations = 0
  t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
    normalizations++
    return iso.call(this)
  })
  syncBuiltinESMExports()

  const records = await repository.list(root)
  assert.equal(records.find(record => record.sessionId === 'timestamped')?.updatedAt, TIMESTAMP)
  assert.deepEqual(stats, [missing])
  assert.equal(normalizations, 2, 'only the final metadata timestamp and fallback mtime need normalization')
})

function paddedRecord(value: Record<string, unknown>, bytes: number): string {
  const record = JSON.stringify(value)
  return record + ' '.repeat(bytes - Buffer.byteLength(record))
}

test('repository headers preserve split UTF-8, CRLF, unterminated EOF, and the 1 MiB cap', async t => {
  const { root, sessions, repository } = fixture(t)
  const prefix = '{"padding":"'
  const unicodeHeader = `${prefix}${'x'.repeat(4095 - Buffer.byteLength(prefix))}😀","type":"session","id":"unicode","cwd":${JSON.stringify(root)}}\r\n`
  fs.writeFileSync(join(sessions, 'unicode.jsonl'), unicodeHeader)
  fs.writeFileSync(
    join(sessions, 'unterminated.jsonl'),
    JSON.stringify({ type: 'session', id: 'unterminated', cwd: root })
  )
  const header = { type: 'session', id: 'limit', cwd: root }
  fs.writeFileSync(join(sessions, 'limit.jsonl'), paddedRecord(header, MIB - 1) + '\n')
  fs.writeFileSync(join(sessions, 'overlong.jsonl'), paddedRecord({ ...header, id: 'overlong' }, MIB) + '\n')
  fs.writeFileSync(
    join(sessions, 'exact-unterminated.jsonl'),
    paddedRecord({ ...header, id: 'exact-unterminated' }, MIB)
  )
  fs.writeFileSync(join(sessions, 'malformed.jsonl'), '{not a header}\n')
  fs.writeFileSync(join(sessions, 'empty.jsonl'), '')

  assert.deepEqual((await repository.list(root)).map(record => record.sessionId).sort(), [
    'limit',
    'unicode',
    'unterminated'
  ])
})

test('repository incremental header read errors close handles and propagate resource exhaustion', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const path = join(sessions, 'header.jsonl')
  fs.writeFileSync(path, paddedRecord({ type: 'session', id: 'header', cwd: root }, 8192) + '\n')
  store.upsert({ sessionId: 'header', cwd: root, sessionFile: path })
  const realOpen = fs.promises.open
  let code = 'EMFILE'
  let opened = 0
  let closed = 0
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args)
    opened++
    const read = handle.read.bind(handle)
    const close = handle.close.bind(handle)
    let reads = 0
    t.mock.method(handle, 'read', (buffer: Buffer, offset: number, length: number, position: number) => {
      if (++reads === 2) return Promise.reject(Object.assign(new Error('read failed'), { code }))
      return read(buffer, offset, length, position)
    })
    t.mock.method(handle, 'close', async () => {
      closed++
      return close()
    })
    return handle
  })
  syncBuiltinESMExports()

  for (code of ['EMFILE', 'ENFILE', 'ENOMEM']) {
    await assert.rejects(repository.find('header', root), { code })
    assert.equal(closed, opened)
  }
  code = 'EIO'
  assert.equal(await repository.find('header', root), null)
  assert.equal(closed, opened)
})

test(
  'repository.list cwd caching retains physical dot-segment and deleted-cwd comparisons',
  {
    skip: process.platform === 'win32'
  },
  async t => {
    const { root, sessions, repository } = fixture(t)
    const local = join(root, 'workspace', 'project')
    const foreign = join(root, 'other', 'project')
    fs.mkdirSync(local, { recursive: true })
    fs.mkdirSync(foreign, { recursive: true })
    fs.mkdirSync(join(root, 'other', 'nested'))
    fs.symlinkSync(join(root, 'other', 'nested'), join(root, 'workspace', 'link'), 'dir')
    const physicalForeign = `${root}/workspace/link/../project`
    writeSession(join(sessions, 'local.jsonl'), 'local', local)
    writeSession(join(sessions, 'foreign.jsonl'), 'foreign', physicalForeign)
    writeSession(join(sessions, 'deleted.jsonl'), 'deleted', join(root, 'deleted'))

    assert.deepEqual(
      (await repository.list(local)).map(record => record.sessionId),
      ['local']
    )
    assert.deepEqual(
      (await repository.list(foreign)).map(record => record.sessionId),
      ['foreign']
    )
    assert.deepEqual(
      (await repository.list(`${root}/deleted///`)).map(record => record.sessionId),
      ['deleted']
    )
  }
)

test('repository.list environment sessionDir bypasses settings reads', async t => {
  const { root, agentDir, sessions, store, repository } = fixture(t)
  const globalPath = join(agentDir, 'settings.json')
  const projectPath = join(root, '.pi', 'settings.json')
  fs.mkdirSync(join(root, '.pi'))
  fs.writeFileSync(globalPath, JSON.stringify({ sessionDir: 'ignored-global' }))
  fs.writeFileSync(projectPath, JSON.stringify({ sessionDir: 'ignored-project' }))
  const path = writeSession(join(sessions, 'env.jsonl'), 'env', root)
  store.upsert({ sessionId: 'env', cwd: root, sessionFile: path })
  const read = fs.readFileSync
  const reads: string[] = []
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
    reads.push(String(args[0]))
    return read(...args)
  })
  syncBuiltinESMExports()

  assert.deepEqual(
    (await repository.list(root)).map(record => record.sessionId),
    ['env']
  )
  assert.equal(reads.includes(globalPath), false)
  assert.equal(reads.includes(projectPath), false)
})

test('repository.list mapped fallback preserves header identities, unmapped foreign winners, and deterministic ties', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const foreign = join(root, 'foreign')
  const tampered = writeSession(join(sessions, 'tampered.jsonl'), 'actual-identity', root)
  store.upsert({ sessionId: 'wanted', cwd: root, sessionFile: tampered })
  writeSession(join(sessions, 'wanted.jsonl'), 'wanted', root)
  store.upsert({ sessionId: 'missing', cwd: root, sessionFile: join(sessions, 'absent.jsonl') })
  writeSession(join(sessions, 'missing.jsonl'), 'missing', root)
  writeSession(join(sessions, 'old-local.jsonl'), 'duplicate', root, 'local', '2026-01-01T00:00:00Z')
  const foreignWinner = writeSession(join(sessions, 'new-foreign.jsonl'), 'duplicate', foreign)
  writeSession(join(sessions, 'tie-a.jsonl'), 'tie', root, 'tie-a')
  const tieWinner = writeSession(join(sessions, 'tie-z.jsonl'), 'tie', root, 'tie-z')

  const local = await repository.list(root)
  assert.deepEqual(
    local.map(record => record.sessionId),
    ['actual-identity', 'missing', 'tie', 'wanted']
  )
  assert.equal(local.find(record => record.sessionId === 'tie')?.sessionFile, tieWinner)
  assert.equal((await repository.list()).find(record => record.sessionId === 'duplicate')?.sessionFile, foreignWinner)
})

test('repository.list falls back when a mapped file disappears after header validation', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const mapped = writeSession(join(sessions, 'mapped.jsonl'), 'duplicate', root)
  const fallback = writeSession(join(sessions, 'fallback.jsonl'), 'duplicate', root)
  store.upsert({ sessionId: 'duplicate', cwd: root, sessionFile: mapped })
  const create = fs.createReadStream
  const scanned: string[] = []
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof create>) => {
    const path = String(args[0])
    scanned.push(path)
    if (path === mapped) fs.unlinkSync(mapped)
    return create(...args)
  })
  syncBuiltinESMExports()

  assert.deepEqual(
    (await repository.list(root)).map(record => record.sessionFile),
    [fallback]
  )
  assert.deepEqual(scanned, [mapped, fallback], 'mapped failure must not suppress usable competitors')
})

test('repository metadata uses stable in-chunk slices without Buffer copies or concat', async t => {
  const { root, sessions, repository } = fixture(t)
  writeSession(join(sessions, 'single-chunk.jsonl'), 'single-chunk', root)
  const from = Buffer.from
  const concat = Buffer.concat
  let copies = 0
  let concatenations = 0
  t.mock.method(Buffer, 'from', (...args: Parameters<typeof from>) => {
    if (Buffer.isBuffer(args[0])) copies++
    return from(...args)
  })
  t.mock.method(Buffer, 'concat', (...args: Parameters<typeof concat>) => {
    concatenations++
    return concat(...args)
  })

  assert.equal((await repository.list(root))[0]?.title, 'single-chunk')
  assert.equal(copies, 0)
  assert.equal(concatenations, 0)
})

test('repository metadata preserves split CRLF/newline/UTF-8 and last-message timestamp preference', async t => {
  const { root, sessions, repository } = fixture(t)
  const path = writeSession(join(sessions, 'split.jsonl'), 'split', root)
  const lines = [
    JSON.stringify({ type: 'session', id: 'split', cwd: root, timestamp: '2028-01-01T00:00:00Z' }),
    '{malformed',
    JSON.stringify({
      type: 'message',
      timestamp: '2026-03-01T04:05:06+02:00',
      message: { role: 'user', content: [{ type: 'text', text: '😀 café' }] }
    }),
    JSON.stringify({ type: 'session_info', timestamp: '2030-01-01T00:00:00Z', name: ' First title ' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-01-01T01:00:00+01:00',
      message: { role: 'assistant', content: 'response' }
    }),
    JSON.stringify({
      type: 'message',
      timestamp: 'invalid',
      message: { role: 'assistant', content: 'invalid timestamp' }
    }),
    JSON.stringify({ type: 'session_info', timestamp: '2031-01-01T00:00:00Z', name: ' Final title 😀 ' })
  ]
  fs.writeFileSync(path, lines.join('\r\n'))
  const create = fs.createReadStream
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof create>) =>
    create(args[0], { ...(typeof args[1] === 'object' ? args[1] : {}), highWaterMark: 1 })
  )
  syncBuiltinESMExports()

  const [record] = await repository.list(root)
  assert.equal(record?.title, 'Final title 😀')
  assert.equal(
    record?.updatedAt,
    '2026-01-01T00:00:00.000Z',
    'last valid message record wins, not maximum time or later session_info'
  )
})

test('repository metadata enforces byte-based record caps and recovers after oversized and malformed records', async t => {
  const { root, sessions, repository } = fixture(t)
  const path = join(sessions, 'records.jsonl')
  const title = { type: 'session_info', name: 'Exact-limit title 😀', timestamp: TIMESTAMP }
  fs.writeFileSync(
    path,
    [
      JSON.stringify({ type: 'session', id: 'records', cwd: root }),
      paddedRecord(title, MIB),
      paddedRecord({ ...title, name: 'Oversized title' }, MIB + 1),
      '{malformed',
      JSON.stringify({ type: 'message', timestamp: 'bad', message: { role: 'user', content: 'fallback' } })
    ].join('\n') + '\n'
  )
  const [record] = await repository.list(root)
  assert.equal(record?.title, title.name)
  assert.equal(record?.updatedAt, TIMESTAMP)
  fs.appendFileSync(
    path,
    JSON.stringify({ type: 'session_info', name: 'Recovered after oversize', timestamp: 'invalid' })
  )
  assert.equal((await repository.list(root))[0]?.title, 'Recovered after oversize')
})

test('repository metadata distinguishes exact-limit EOF from truncation and keeps titles anywhere within budget', async t => {
  const { root, sessions, store, repository } = fixture(t)
  const path = join(sessions, 'budget.jsonl')
  store.upsert({ sessionId: 'budget', cwd: root, sessionFile: path })
  const header = JSON.stringify({ type: 'session', id: 'budget', cwd: root }) + '\n'
  const message =
    JSON.stringify({ type: 'message', timestamp: TIMESTAMP, message: { role: 'user', content: 'fallback' } }) + '\n'
  const title = JSON.stringify({ type: 'session_info', name: 'At the budget edge', timestamp: '2030-01-01T00:00:00Z' })
  const file = header + message + 'x'.repeat(8 * MIB - Buffer.byteLength(header + message + title) - 1) + '\n' + title
  assert.equal(Buffer.byteLength(file), 8 * MIB)
  const mtime = new Date('2026-02-01T00:00:00.000Z')
  const create = fs.createReadStream
  const streams: fs.ReadStream[] = []
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof create>) => {
    const input = create(...args)
    streams.push(input)
    return input
  })
  const iso = Date.prototype.toISOString
  let normalizations = 0
  t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
    normalizations++
    return iso.call(this)
  })
  syncBuiltinESMExports()

  fs.writeFileSync(path, file)
  fs.utimesSync(path, mtime, mtime)
  const [exact] = await repository.list(root)
  assert.equal(exact?.title, 'At the budget edge')
  assert.equal(exact?.updatedAt, TIMESTAMP)
  assert.equal(streams[0]?.bytesRead, 8 * MIB)
  assert.equal(normalizations, 1)

  fs.appendFileSync(path, ' ')
  fs.utimesSync(path, mtime, mtime)
  normalizations = 0
  const [truncated] = await repository.list(root)
  assert.equal(truncated?.title, 'fallback', 'a record cut off by the scan budget is not parsed')
  assert.equal(truncated?.updatedAt, iso.call(mtime))
  assert.equal(streams[1]?.bytesRead, 8 * MIB + 1)
  assert.equal(normalizations, 1, 'truncated scans only normalize the selected mtime')

  fs.writeFileSync(path, file.slice(0, -title.length - 2) + '\n' + title + '\nignored')
  fs.utimesSync(path, mtime, mtime)
  const [completeTitle] = await repository.list(root)
  assert.equal(completeTitle?.title, 'At the budget edge')
  assert.equal(completeTitle?.updatedAt, iso.call(mtime))
  assert.equal(streams[2]?.bytesRead, 8 * MIB + 1)
})

test('repository.list propagates metadata stream and fallback stat resource errors', async t => {
  const { root, sessions, repository } = fixture(t)
  const path = writeSession(join(sessions, 'errors.jsonl'), 'errors', root)
  const create = fs.createReadStream
  let streamError: string | null = 'ENOMEM'
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof create>) => {
    const input = create(...args)
    if (streamError) input.destroy(Object.assign(new Error('stream failed'), { code: streamError }))
    return input
  })
  const stat = fs.promises.stat
  let statError: string | null = null
  t.mock.method(fs.promises, 'stat', (...args: Parameters<typeof stat>) => {
    if (statError) return Promise.reject(Object.assign(new Error('stat failed'), { code: statError }))
    return stat(...args)
  })
  syncBuiltinESMExports()

  await assert.rejects(repository.list(root), { code: 'ENOMEM' })
  streamError = 'EIO'
  assert.equal((await repository.list(root))[0]?.title, null, 'non-resource scan failures retain mtime fallback')
  streamError = null
  fs.writeFileSync(path, `${JSON.stringify({ type: 'session', id: 'errors', cwd: root })}\n`)
  statError = 'ENFILE'
  await assert.rejects(repository.list(root), { code: 'ENFILE' })
  statError = 'ENOENT'
  assert.deepEqual(await repository.list(root), [])
})

test('repository metadata falls back to the last valid record timestamp and first user title', async t => {
  const { root, sessions, repository } = fixture(t)
  const path = join(sessions, 'fallback.jsonl')
  const firstTitle = '😀 first user '.repeat(10)
  fs.writeFileSync(
    path,
    [
      JSON.stringify({ type: 'session', id: 'fallback', cwd: root, timestamp: '2030-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'message',
        timestamp: 'invalid',
        message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: firstTitle }] }
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'second user' } }),
      JSON.stringify({ type: 'session_info', name: ' ', timestamp: '2026-01-01T01:00:00+01:00' }),
      JSON.stringify({ type: 'session_info', name: '', timestamp: 'bad' })
    ].join('\n')
  )
  const [record] = await repository.list(root)
  assert.equal(record?.title, firstTitle.slice(0, 80))
  assert.equal(record?.updatedAt, '2026-01-01T00:00:00.000Z')
})
