import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  WORKSPACE_INSTRUCTIONS_SECTION,
  buildWorkspaceInstructionsSection,
  parseWorkspaceRootsEnv,
  readWorkspaceInstructions
} from '../../src/pi-rpc/workspace-instructions.js'

const isWindows = process.platform === 'win32'

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}

test('readWorkspaceInstructions follows pi candidate precedence within each root only', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-ws-prec-'))
  const other = mkdtempSync(join(tmpdir(), 'pi-acp-ws-prec-other-'))
  write(join(root, 'AGENTS.override.md'), 'override wins')
  write(join(root, 'AGENTS.md'), 'plain agents')
  write(join(root, 'CLAUDE.md'), 'claude ignored once AGENTS.md exists')
  write(join(other, 'CLAUDE.md'), 'claude fallback')

  assert.deepEqual(readWorkspaceInstructions([root, other]), [
    { root, file: join(root, 'AGENTS.override.md'), content: 'override wins', error: null },
    { root: other, file: join(other, 'CLAUDE.md'), content: 'claude fallback', error: null }
  ])
})

test('readWorkspaceInstructions never walks additional-root ancestors', () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-acp-ws-walk-'))
  const root = join(parent, 'nested')
  mkdirSync(root)
  write(join(parent, 'AGENTS.md'), 'parent instructions must not load')

  const [entry] = readWorkspaceInstructions([root])
  assert.deepEqual(entry, { root, file: null, content: null, error: null })
})

test('readWorkspaceInstructions surfaces real read failures instead of dropping context', { skip: isWindows }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-ws-read-'))
  const file = join(root, 'AGENTS.md')
  // A self-referential symlink is deterministically unreadable for every uid
  // (chmod 000 is not, and Windows/POSIX permission semantics differ).
  symlinkSync(file, file)

  const [entry] = readWorkspaceInstructions([root])
  assert.equal(entry.root, root)
  assert.equal(entry.file, file)
  assert.equal(entry.content, null)
  assert.match(String(entry.error), /ELOOP/)
})

test('readWorkspaceInstructions spells candidate file paths with the native separator', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-ws-sep-'))
  write(join(root, 'AGENTS.md'), 'separator guidance')

  const [entry] = readWorkspaceInstructions([root])
  assert.equal(entry.file, join(root, 'AGENTS.md'), 'a plain root spells like a native join')
  assert.equal(entry.content, 'separator guidance')

  const [trailing] = readWorkspaceInstructions([`${root}${sep}`])
  assert.equal(trailing.file, join(root, 'AGENTS.md'), 'a trailing separator never doubles')
  assert.equal(trailing.content, 'separator guidance')
})

test(
  'readWorkspaceInstructions preserves physical symlink-plus-dotdot resolution when appending file names',
  { skip: isWindows },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-ws-phys-'))
    const project = join(root, 'other-project')
    const sub = join(project, 'sub')
    mkdirSync(sub, { recursive: true })
    write(join(project, 'AGENTS.md'), 'PHYSICAL_ROOT_INSTRUCTIONS')
    write(join(root, 'AGENTS.md'), 'LEXICAL_ROOT_INSTRUCTIONS')
    symlinkSync(sub, join(root, 'work-link'))

    // `work-link/..` physically resolves to the project directory (this is
    // also what validation accepts via stat), so its instruction file is the
    // physical one; a lexical join would collapse the dotdot and read the
    // wrong directory instead.
    const requested = `${join(root, 'work-link')}/..`
    const [entry] = readWorkspaceInstructions([requested])
    assert.equal(entry.error, null)
    assert.equal(entry.content, 'PHYSICAL_ROOT_INSTRUCTIONS')
  }
)

test('buildWorkspaceInstructionsSection labels each root and stays stable across repeated turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-ws-section-'))
  write(join(root, 'AGENTS.md'), 'root-scoped guidance')

  const entries = readWorkspaceInstructions([root])
  const section = buildWorkspaceInstructionsSection(entries)!
  assert.ok(section.includes(`root="${root}"`))
  assert.ok(section.includes('root-scoped guidance'))
  assert.ok(/apply only within their own root/.test(section), 'scope label must be explicit')
  assert.equal(section, buildWorkspaceInstructionsSection(readWorkspaceInstructions([root])), 'idempotent per run')

  const empty = mkdtempSync(join(tmpdir(), 'pi-acp-ws-section-empty-'))
  const withMissing = buildWorkspaceInstructionsSection(readWorkspaceInstructions([root, empty]))!
  assert.ok(withMissing.includes(empty), 'every active root is exposed')
  assert.ok(/no instruction file/.test(withMissing))
})

test('buildWorkspaceInstructionsSection returns null for no roots; env parsing is strict', () => {
  assert.equal(buildWorkspaceInstructionsSection([]), null)
  assert.equal(WORKSPACE_INSTRUCTIONS_SECTION, 'acp_workspace_instructions')

  assert.deepEqual(parseWorkspaceRootsEnv(undefined), [])
  assert.deepEqual(parseWorkspaceRootsEnv(''), [])
  assert.deepEqual(parseWorkspaceRootsEnv(JSON.stringify(['/a', '/b'])), ['/a', '/b'])
  assert.deepEqual(parseWorkspaceRootsEnv(JSON.stringify(['/a', 42])), [])
  assert.deepEqual(parseWorkspaceRootsEnv('["/a"'), [])
  assert.deepEqual(parseWorkspaceRootsEnv(JSON.stringify('/a')), [])
})
