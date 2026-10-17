import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertValidSessionCwd, normalizeCwdForComparison, sessionCwdsEquivalent } from '../../src/acp/session-cwd.js'

function expectInvalidCwd(reason: string): (error: unknown) => boolean {
  return error => {
    const requestError = error as {
      code?: number
      data?: { reason?: string }
      message?: string
    }
    assert.equal(requestError.code, -32602)
    assert.equal(requestError.data?.reason, reason)
    return true
  }
}

test('assertValidSessionCwd accepts existing absolute directories', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
  assert.doesNotThrow(() => assertValidSessionCwd(cwd))
  assert.doesNotThrow(() => assertValidSessionCwd(`${cwd}/`))
})

test('assertValidSessionCwd rejects relative, missing, and non-directory paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-invalid-'))
  const file = join(cwd, 'file.txt')
  const missing = join(cwd, 'missing')
  writeFileSync(file, 'not a directory\n', 'utf8')

  assert.throws(() => assertValidSessionCwd('relative/path'), expectInvalidCwd('CWD_NOT_ABSOLUTE'))
  assert.throws(() => assertValidSessionCwd(missing), expectInvalidCwd('CWD_NOT_FOUND'))
  assert.throws(() => assertValidSessionCwd(file), expectInvalidCwd('CWD_NOT_DIRECTORY'))
})

test('assertValidSessionCwd bounds paths included in errors', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-bounded-'))
  const oversized = join(cwd, 'x'.repeat(1_000))

  assert.throws(
    () => assertValidSessionCwd(oversized),
    error => {
      const requestError = error as { code?: number; message?: string }
      assert.equal(requestError.code, -32602)
      assert.ok((requestError.message?.length ?? Number.POSITIVE_INFINITY) < 400)
      assert.match(requestError.message ?? '', /\.\.\./)
      return true
    }
  )
})

test('cwd comparison normalizes separators, trailing separators, dot segments, and Windows case', () => {
  assert.equal(normalizeCwdForComparison('/workspace/project///', 'posix'), '/workspace/project')
  assert.ok(sessionCwdsEquivalent('/workspace/other/../project/', '/workspace/project', 'posix'))
  assert.equal(sessionCwdsEquivalent('/workspace/project\\', '/workspace/project', 'posix'), false)

  assert.equal(normalizeCwdForComparison('C:/Work/Project///', 'win32'), 'c:\\work\\project')
  assert.ok(sessionCwdsEquivalent('C:\\Work\\Project\\', 'c:/work/project', 'win32'))
  assert.ok(sessionCwdsEquivalent('C:\\Work\\Other\\..\\Project', 'c:/work/project/', 'win32'))
  assert.equal(sessionCwdsEquivalent('C:\\Work\\Project', 'D:\\Work\\Project', 'win32'), false)
})

test(
  'cwd comparison rejects symlinked dot-segment paths that name a different physical directory',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-symlink-'))
    const workspace = join(root, 'workspace')
    const other = join(root, 'other')
    mkdirSync(join(workspace, 'project'), { recursive: true })
    mkdirSync(join(other, 'project'), { recursive: true })
    mkdirSync(join(other, 'nested'), { recursive: true })
    // `workspace/link` escapes to `other`, so `link/..` is `other`, not `workspace`.
    symlinkSync(join(other, 'nested'), join(workspace, 'link'))

    const stored = join(workspace, 'project')
    // Built by concatenation: path.join would collapse `..` before comparison.
    const aliased = `${workspace}/link/../project`

    assert.ok(
      sessionCwdsEquivalent(stored, aliased, 'posix'),
      'lexical collapse alone cannot tell these directories apart'
    )
    // The physical target is runtime evidence: Node's realpath resolves
    // `link/..` physically, Bun's collapses it lexically, so pin the invariant
    // both rely on — the two paths name different directories on disk.
    assert.notEqual(statSync(aliased).ino, statSync(stored).ino, 'the paths name different physical directories')
    assert.equal(sessionCwdsEquivalent(stored, aliased), false, 'runtime comparison must resolve both paths physically')
    assert.ok(sessionCwdsEquivalent(stored, `${workspace}/link/../../workspace/project`))
  }
)

test('cwd comparison equates symlinked aliases of the same physical directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-alias-'))
  const resolved = realpathSync.native(root)

  assert.ok(sessionCwdsEquivalent(root, resolved), 'both sides are compared physically')
  assert.ok(sessionCwdsEquivalent(resolved, `${root}/`))
})

test('cwd comparison falls back to lexical form for paths that do not exist', () => {
  assert.ok(sessionCwdsEquivalent('/deleted/session/cwd', '/deleted/session/cwd/'))
  assert.equal(sessionCwdsEquivalent('/deleted/session/cwd', '/deleted/other/cwd'), false)
})

test('cwd normalization preserves filesystem roots', () => {
  assert.equal(normalizeCwdForComparison('/', 'posix'), '/')
  assert.equal(normalizeCwdForComparison('C:\\', 'win32'), 'c:\\')
  assert.equal(normalizeCwdForComparison('\\\\Server\\Share\\', 'win32'), '\\\\server\\share\\')
})

test(
  'cwd comparison decides by stat identity when realpath lexically collapses symlink dot-segments',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-identity-'))
    const workspace = join(root, 'workspace')
    const other = join(root, 'other')
    mkdirSync(join(workspace, 'project'), { recursive: true })
    mkdirSync(join(other, 'project'), { recursive: true })
    mkdirSync(join(other, 'nested'), { recursive: true })
    symlinkSync(join(other, 'nested'), join(workspace, 'link'))
    // `workspace/link/..` is physically `other`, so the raw path names
    // other/project while lexically collapsing to workspace/project.
    const raw = `${workspace}/link/../project`
    const workspaceProject = join(workspace, 'project')
    const otherProject = join(other, 'project')

    // Bun 1.4.2's realpathSync.native lexically collapses `symlink/..` and
    // resolves the raw path to workspace/project; emulate that runtime so the
    // assertions prove the stat dev/ino identity decides, not the realpath.
    const originalNative = realpathSync.native
    const collapsed = originalNative(workspaceProject)
    realpathSync.native = ((path: string, ...rest: unknown[]) =>
      path === raw
        ? collapsed
        : (originalNative as unknown as (...args: unknown[]) => string)(path, ...rest)) as typeof realpathSync.native
    try {
      assert.equal(realpathSync.native(raw), collapsed, 'precondition: the emulated runtime lies about the raw path')
      assert.notEqual(statSync(raw).ino, statSync(workspaceProject).ino)
      assert.equal(
        sessionCwdsEquivalent(raw, workspaceProject),
        false,
        'different real directories must stay distinct despite an equal collapsed realpath'
      )
      assert.ok(
        sessionCwdsEquivalent(raw, otherProject),
        'the same physical directory must alias despite a different collapsed realpath'
      )
    } finally {
      realpathSync.native = originalNative
    }
  }
)
