import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAdditionalDirectories, workspaceRootsEquivalent } from '../../src/acp/workspace-roots.js'

const isWindows = process.platform === 'win32'

function invalidParamsReason(reason: string): (error: unknown) => boolean {
  return error => {
    const requestError = error as { code?: number; data?: { reason?: string } }
    assert.equal(requestError.code, -32602)
    assert.equal(requestError.data?.reason, reason)
    return true
  }
}

function tempRoot(): { cwd: string; extra: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-roots-cwd-'))
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-roots-extra-'))
  return { cwd, extra }
}

test('normalizeAdditionalDirectories accepts absolute existing directories in request order', () => {
  const { cwd, extra } = tempRoot()
  const second = join(cwd, 'second-root')
  mkdirSync(second)

  assert.deepEqual(normalizeAdditionalDirectories(cwd, [extra, second]), [extra, second])
  assert.deepEqual(normalizeAdditionalDirectories(cwd, undefined), [])
  assert.deepEqual(normalizeAdditionalDirectories(cwd, null), [])
  assert.deepEqual(normalizeAdditionalDirectories(cwd, []), [])
})

test('normalizeAdditionalDirectories rejects invalid entries before any side effects', () => {
  const { cwd } = tempRoot()
  const file = join(cwd, 'plain-file')
  writeFileSync(file, 'x')

  const rejects = (value: unknown, reason: string, label: string) =>
    assert.throws(() => normalizeAdditionalDirectories(cwd, value), invalidParamsReason(reason), label)

  rejects('not-an-array', 'ADDITIONAL_DIRECTORIES_INVALID', 'non-array input')
  rejects(['relative'], 'ADDITIONAL_DIRECTORY_NOT_ABSOLUTE', 'relative path')
  rejects([42], 'ADDITIONAL_DIRECTORY_NOT_ABSOLUTE', 'non-string entry')
  rejects([join(cwd, 'missing')], 'ADDITIONAL_DIRECTORY_NOT_FOUND', 'missing path')
  rejects([file], 'ADDITIONAL_DIRECTORY_NOT_DIRECTORY', 'regular file')
})

test(
  'normalizeAdditionalDirectories drops cwd and duplicate/alias roots keeping first occurrence',
  { skip: isWindows },
  () => {
    const { cwd, extra } = tempRoot()
    const alias = join(cwd, 'extra-alias')
    symlinkSync(extra, alias)
    const second = mkdtempSync(join(tmpdir(), 'pi-acp-roots-second-'))

    assert.deepEqual(normalizeAdditionalDirectories(cwd, [extra, alias, second, extra, cwd]), [extra, second])
  }
)

test('workspaceRootsEquivalent compares ordered roots by resolved identity', { skip: isWindows }, () => {
  const { cwd, extra } = tempRoot()
  const alias = join(cwd, 'extra-alias-2')
  symlinkSync(extra, alias)

  assert.ok(workspaceRootsEquivalent([], []))
  assert.ok(workspaceRootsEquivalent([extra], [alias]))
  assert.ok(!workspaceRootsEquivalent([extra], []))
  assert.ok(!workspaceRootsEquivalent([extra], [alias, cwd]))
  assert.ok(!workspaceRootsEquivalent([alias, cwd], [cwd, alias]))
})

test(
  'normalizeAdditionalDirectories identifies roots by filesystem identity, not realpath',
  { skip: isWindows },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-roots-identity-'))
    const work = join(root, 'work')
    const physical = join(root, 'physical')
    mkdirSync(work)
    mkdirSync(join(physical, 'sub'), { recursive: true })
    symlinkSync(join(physical, 'sub'), join(work, 'link'))
    const viaLink = `${join(work, 'link')}/..`

    // The requested root physically resolves to the project directory (this
    // is what validation accepts via stat), so it must stay distinct from the
    // cwd while aliasing the physical root itself.
    assert.deepEqual(normalizeAdditionalDirectories(work, [viaLink, physical]), [viaLink])
    assert.ok(workspaceRootsEquivalent([viaLink], [physical]))
    assert.ok(!workspaceRootsEquivalent([viaLink], [work]))

    // Bun's realpathSync.native lexically collapses `symlink/..` (empirical:
    // `/work/link/..` -> `/work`), which must not turn a physically distinct
    // root into a cwd alias. Emulate that runtime to prove identity wins over
    // realpath-based comparison everywhere.
    const originalNative = realpathSync.native
    const resolvedCwd = originalNative(work)
    realpathSync.native = ((path: string, ...rest: unknown[]) =>
      path === viaLink
        ? resolvedCwd
        : (originalNative as unknown as (...args: unknown[]) => string)(path, ...rest)) as typeof realpathSync.native
    try {
      assert.deepEqual(
        normalizeAdditionalDirectories(work, [viaLink, physical]),
        [viaLink],
        'a physically distinct root is never dropped as a cwd alias'
      )
      assert.ok(workspaceRootsEquivalent([viaLink], [physical]), 'aliases still dedupe by identity')
      assert.ok(!workspaceRootsEquivalent([viaLink], [work]), 'the cwd stays distinct')
    } finally {
      realpathSync.native = originalNative
    }
  }
)

test('normalizeAdditionalDirectories bounds path displays in errors without losing typed reasons', () => {
  const { cwd } = tempRoot()
  const huge = `/${'a'.repeat(5_000)}`
  const hugeObject = { toString: () => `/${'b'.repeat(5_000)}` }

  const hugeRelative = 'c'.repeat(5_000)
  for (const [candidate, reason] of [
    [huge, /^ADDITIONAL_DIRECTORY_(UNAVAILABLE|NOT_FOUND)$/],
    [hugeRelative, /^ADDITIONAL_DIRECTORY_NOT_ABSOLUTE$/],
    [hugeObject, /^ADDITIONAL_DIRECTORY_NOT_ABSOLUTE$/]
  ] as const) {
    assert.throws(
      () => normalizeAdditionalDirectories(cwd, [candidate]),
      (error: unknown) => {
        const requestError = error as { code?: number; data?: { reason?: string }; message: string }
        assert.equal(requestError.code, -32602)
        assert.match(String(requestError.data?.reason), reason)
        assert.ok(requestError.message.length < 400, `error message must stay bounded: ${requestError.message.length}`)
        assert.ok(requestError.message.includes('...'), 'a clipped path display ends with an ellipsis')
        assert.ok(requestError.message.includes('additionalDirectories[0] '), 'the message keeps its typed prefix')
        return true
      }
    )
  }
})
