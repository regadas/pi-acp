import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getGlobalPiSettings, getMergedPiSettings } from '../../src/acp/pi-settings.js'
import { defaultSessionDirectory, resolveSessionDirectory } from '../../src/acp/session-repository.js'

test('pi settings reuse supplied global settings without mutation and preserve fresh external callers', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-pi-settings-'))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  mkdirSync(join(root, '.pi'))
  const globalPath = join(agentDir, 'settings.json')
  const projectPath = join(root, '.pi', 'settings.json')
  writeFileSync(globalPath, JSON.stringify({ sessionDir: '~/global', nested: { global: true, shared: 'global' } }))
  writeFileSync(projectPath, JSON.stringify({ nested: { project: true, shared: 'project' } }))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
    rmSync(root, { recursive: true, force: true })
  })

  const global = getGlobalPiSettings()
  assert.deepEqual(getMergedPiSettings(root, global), {
    sessionDir: '~/global',
    nested: { global: true, project: true, shared: 'project' }
  })
  assert.deepEqual(global, { sessionDir: '~/global', nested: { global: true, shared: 'global' } })
  assert.deepEqual(resolveSessionDirectory(root, {}, agentDir), { path: join(homedir(), 'global'), custom: true })
  writeFileSync(globalPath, JSON.stringify({ sessionDir: 'new-global' }))
  assert.equal(getMergedPiSettings(root).sessionDir, 'new-global')
  assert.deepEqual(resolveSessionDirectory(root, {}, agentDir), { path: resolve(root, 'new-global'), custom: true })
  writeFileSync(projectPath, JSON.stringify({ sessionDir: 'project' }))
  assert.equal(resolveSessionDirectory(root, {}, agentDir).path, resolve(root, 'project'))
  assert.equal(
    resolveSessionDirectory(root, { PI_CODING_AGENT_SESSION_DIR: '~/env' }, agentDir).path,
    join(homedir(), 'env')
  )
  writeFileSync(projectPath, JSON.stringify({ sessionDir: ' ' }))
  assert.deepEqual(resolveSessionDirectory(root, {}, agentDir), {
    path: defaultSessionDirectory(root, agentDir),
    custom: false
  })
  writeFileSync(globalPath, 'malformed')
  writeFileSync(projectPath, '[]')
  assert.deepEqual(getMergedPiSettings(root), {})
})
