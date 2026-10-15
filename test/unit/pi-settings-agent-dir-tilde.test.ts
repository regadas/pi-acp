import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAgentDir, getGlobalPiSettings } from '../../src/acp/pi-settings.js'
import { resolveSessionDirectory } from '../../src/acp/session-repository.js'

function sandboxedHome(t: import('node:test').TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-agent-dir-tilde-'))
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('getAgentDir expands a literal tilde PI_CODING_AGENT_DIR against home like pi', t => {
  const home = sandboxedHome(t)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = '~/custom-agent'
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })

  assert.equal(getAgentDir(), join(home, 'custom-agent'))
})

test('getAgentDir maps a lone tilde to home and keeps non-tilde paths resolved as before', t => {
  const home = sandboxedHome(t)
  const cases: Array<[string, string]> = [
    ['~', home],
    ['~/nested/deep', join(home, 'nested', 'deep')],
    [join(home, 'absolute-agent'), join(home, 'absolute-agent')],
    ['relative-agent', resolve('relative-agent')],
    ['~other-user/agent', resolve('~other-user/agent')]
  ]
  for (const [configured, expected] of cases) {
    process.env.PI_CODING_AGENT_DIR = configured
    assert.equal(getAgentDir(), expected, `PI_CODING_AGENT_DIR=${configured}`)
  }
  delete process.env.PI_CODING_AGENT_DIR
  assert.equal(getAgentDir(), join(home, '.pi', 'agent'))
})

test('a literal tilde agent dir serves global settings and session directory discovery', t => {
  const home = sandboxedHome(t)
  const agentDir = join(home, 'custom-agent')
  mkdirSync(join(agentDir, 'sessions'), { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~/global-sessions' }))
  const project = join(home, 'project')
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = '~/custom-agent'
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })

  assert.deepEqual(getGlobalPiSettings(), { sessionDir: '~/global-sessions' })
  assert.deepEqual(resolveSessionDirectory(project), { path: join(home, 'global-sessions'), custom: true })
  assert.deepEqual(resolveSessionDirectory(project, { PI_CODING_AGENT_SESSION_DIR: '~/env-sessions' }), {
    path: join(home, 'env-sessions'),
    custom: true
  })
})
