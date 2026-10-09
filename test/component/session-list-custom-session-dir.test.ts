import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionRepository } from '../../src/acp/session-repository.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('SessionRepository respects custom sessionDir from pi settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-custom-dir-'))
  const customDir = join(root, 'somewhere-else')
  const nestedDir = join(customDir, 'project', 'history')
  mkdirSync(nestedDir, { recursive: true })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: customDir }))
  const sessionFile = join(nestedDir, 's.jsonl')
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', id: 'sess-custom', cwd: '/tmp/project' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n'
  )

  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  try {
    const repository = new SessionRepository(new SessionStore(join(root, 'map.json')), {}, root)
    assert.equal((await repository.find('sess-custom', '/tmp/project'))?.sessionFile, sessionFile)
    const sessions = await repository.list('/tmp/project')
    assert.equal(sessions.find(session => session.sessionId === 'sess-custom')?.sessionFile, sessionFile)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
})

test('PiAcpAgent deletes history listed from another cwd with a relative session directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-custom-dir-delete-'))
  const cwd = join(root, 'project')
  assert.notEqual(cwd, process.cwd())
  const sessions = join(cwd, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const sessionFile = join(sessions, 'listed.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'listed', cwd })}\n`)
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const previousAcpDir = process.env.PI_ACP_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_CODING_AGENT_SESSION_DIR = 'sessions'
  process.env.PI_ACP_DIR = join(root, 'acp')
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir
    if (previousAcpDir === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = previousAcpDir
    rmSync(root, { recursive: true, force: true })
  })
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  t.after(() => agent.dispose())

  assert.deepEqual(
    (await agent.listSessions({ cwd })).sessions.map(session => session.sessionId),
    ['listed']
  )
  assert.deepEqual(await agent.deleteSession({ sessionId: 'listed' }), {})
  assert.equal(existsSync(sessionFile), false, 'successful deletion must remove the listed history')
  assert.deepEqual((await agent.listSessions({ cwd })).sessions, [])
  assert.deepEqual(await agent.deleteSession({ sessionId: 'listed' }), {})
})

test(
  'SessionRepository filters custom sessions by equivalent cwd aliases',
  { skip: process.platform === 'win32' ? 'directory symlinks may require elevated privileges' : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-custom-dir-alias-'))
    const workspace = join(root, 'workspace')
    const alias = join(root, 'workspace-alias')
    const customDir = join(root, 'sessions')
    mkdirSync(workspace)
    mkdirSync(customDir)
    symlinkSync(workspace, alias, 'dir')
    writeFileSync(
      join(customDir, 's.jsonl'),
      [
        JSON.stringify({ type: 'session', id: 'sess-alias', cwd: workspace }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: 'hi' }
        })
      ].join('\n') + '\n'
    )

    const repository = new SessionRepository(
      new SessionStore(join(root, 'map.json')),
      { PI_CODING_AGENT_SESSION_DIR: customDir },
      join(root, 'agent')
    )
    assert.deepEqual(
      (await repository.list(alias)).map(session => session.sessionId),
      ['sess-alias']
    )
  }
)
