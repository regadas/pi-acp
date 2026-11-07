import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test(
  'project settings resolve a symlink/.. cwd into the physical project',
  { skip: process.platform === 'win32' },
  t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-pi-settings-link-'))
    const physical = join(root, 'physical')
    const lexical = join(root, 'lexical')
    mkdirSync(join(physical, '.pi'), { recursive: true })
    mkdirSync(join(lexical, '.pi'), { recursive: true })
    // link -> physical/nested, so `link/..` physically resolves to `physical`,
    // while a lexical collapse names `lexical` — a different project.
    mkdirSync(join(physical, 'nested'))
    symlinkSync(join(physical, 'nested'), join(lexical, 'link'))
    writeFileSync(join(physical, '.pi', 'settings.json'), JSON.stringify({ sessionDir: 'physical-project' }))
    writeFileSync(join(lexical, '.pi', 'settings.json'), JSON.stringify({ sessionDir: 'lexical-collapse' }))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const merged = getMergedPiSettings(`${join(lexical, 'link')}/..`)
    assert.equal(merged.sessionDir, 'physical-project')
  }
)
