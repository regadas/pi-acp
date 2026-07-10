import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_PI_VERSION,
  PiVersionError,
  assertSupportedPiVersion,
  clearPiVersionCacheForTests,
  comparePiVersions,
  parsePiVersion
} from '../../src/pi-rpc/version.js'
import { resolveWindowsScriptCommand } from '../../src/pi-rpc/command.js'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

const isWindows = process.platform === 'win32'

function makePiStubIn(dir: string, name: string, versionOutput: string, versionExitCode = 0): string {
  const stub = join(dir, name)
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${versionOutput}'; exit ${versionExitCode}; fi\nexit 0\n`,
    'utf-8'
  )
  chmodSync(stub, 0o755)
  return stub
}

function makePiStub(name: string, versionOutput: string, versionExitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-version-'))
  return makePiStubIn(dir, name, versionOutput, versionExitCode)
}

test('parsePiVersion accepts semver output with optional v prefix', () => {
  assert.equal(parsePiVersion('0.80.6\n'), '0.80.6')
  assert.equal(parsePiVersion('v0.80.4'), '0.80.4')
  assert.equal(parsePiVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(parsePiVersion('pi help text'), null)
  assert.equal(parsePiVersion(''), null)
  assert.equal(parsePiVersion('0.80'), null)
})

test('comparePiVersions orders x.y.z numerically', () => {
  assert.equal(comparePiVersions('0.80.4', '0.80.4'), 0)
  assert.equal(comparePiVersions('0.80.6', '0.80.4'), 1)
  assert.equal(comparePiVersions('0.80.3', '0.80.4'), -1)
  assert.equal(comparePiVersions('0.79.10', '0.80.0'), -1)
  assert.equal(comparePiVersions('1.0.0', '0.99.99'), 1)
})

function fakeWindowsFiles(...paths: string[]): (path: string) => boolean {
  const files = new Set(paths.map(path => path.toLowerCase()))
  return path => files.has(path.toLowerCase())
}

test('resolveWindowsScriptCommand searches cwd, PATH, and explicit paths with Windows semantics', () => {
  assert.equal(
    resolveWindowsScriptCommand(
      'pi.cmd',
      'C:\\workspace',
      'C:\\bin;D:\\tools',
      fakeWindowsFiles('C:\\workspace\\pi.cmd', 'D:\\tools\\pi.cmd')
    ),
    'C:\\workspace\\pi.cmd',
    'cwd takes precedence over PATH'
  )
  assert.equal(
    resolveWindowsScriptCommand('pi.cmd', 'C:\\workspace', 'C:\\bin;D:\\tools', fakeWindowsFiles('D:\\tools\\pi.cmd')),
    'D:\\tools\\pi.cmd'
  )
  assert.equal(
    resolveWindowsScriptCommand(
      '.\\scripts\\pi.bat',
      'C:\\workspace',
      'D:\\tools',
      fakeWindowsFiles('C:\\workspace\\scripts\\pi.bat')
    ),
    'C:\\workspace\\scripts\\pi.bat'
  )
  assert.equal(
    resolveWindowsScriptCommand(
      'D:\\custom\\pi.cmd',
      'C:\\workspace',
      'C:\\bin',
      fakeWindowsFiles('D:\\custom\\pi.cmd')
    ),
    'D:\\custom\\pi.cmd'
  )
  assert.equal(
    resolveWindowsScriptCommand('missing.cmd', 'C:\\workspace', 'C:\\bin;D:\\tools', () => false),
    null
  )
})

test('resolveWindowsScriptCommand anchors relative PATH entries to cwd and supports paths with spaces', () => {
  assert.equal(
    resolveWindowsScriptCommand(
      'pi.cmd',
      'C:\\workspace',
      'tools;D:\\fallback',
      fakeWindowsFiles('C:\\workspace\\tools\\pi.cmd')
    ),
    'C:\\workspace\\tools\\pi.cmd',
    'relative PATH entries use the supplied session cwd'
  )
  assert.equal(
    resolveWindowsScriptCommand(
      'pi.cmd',
      'C:\\workspace',
      'C:\\Program Files\\Pi;D:\\fallback',
      fakeWindowsFiles('C:\\Program Files\\Pi\\pi.cmd')
    ),
    'C:\\Program Files\\Pi\\pi.cmd'
  )
  assert.equal(
    resolveWindowsScriptCommand(
      'pi.cmd',
      'C:\\workspace',
      '"C:\\Program Files\\Pi";D:\\fallback',
      fakeWindowsFiles('C:\\Program Files\\Pi\\pi.cmd')
    ),
    'C:\\Program Files\\Pi\\pi.cmd',
    'surrounding quotes on a PATH entry are ignored'
  )
})

test('assertSupportedPiVersion accepts the minimum and newer versions', { skip: isWindows }, () => {
  clearPiVersionCacheForTests()
  assert.equal(assertSupportedPiVersion(makePiStub('pi-ok-min', MIN_PI_VERSION)), MIN_PI_VERSION)
  assert.equal(assertSupportedPiVersion(makePiStub('pi-ok-newer', '0.80.6')), '0.80.6')
})

test('assertSupportedPiVersion fails closed on versions older than the minimum', { skip: isWindows }, () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-old', '0.80.3')
  assert.throws(
    () => assertSupportedPiVersion(stub),
    (err: unknown) =>
      err instanceof PiVersionError &&
      err.message.includes('0.80.3') &&
      err.message.includes(MIN_PI_VERSION) &&
      err.message.includes('agent_settled')
  )
})

test('assertSupportedPiVersion fails closed on unparseable version output', { skip: isWindows }, () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-garbage', 'not a version')
  assert.throws(
    () => assertSupportedPiVersion(stub),
    (err: unknown) => err instanceof PiVersionError && err.message.includes('Could not determine the pi version')
  )
})

test(
  'assertSupportedPiVersion uses cwd for relative commands and isolates the cache by cwd',
  { skip: isWindows },
  () => {
    clearPiVersionCacheForTests()
    const supportedDir = mkdtempSync(join(tmpdir(), 'pi-acp-version-cwd-supported-'))
    const oldDir = mkdtempSync(join(tmpdir(), 'pi-acp-version-cwd-old-'))
    makePiStubIn(supportedDir, 'pi-relative', '0.80.6')
    makePiStubIn(oldDir, 'pi-relative', '0.80.3')

    assert.equal(assertSupportedPiVersion('./pi-relative', supportedDir), '0.80.6')
    assert.throws(
      () => assertSupportedPiVersion('./pi-relative', oldDir),
      (err: unknown) => err instanceof PiVersionError && err.message.includes('0.80.3')
    )
  }
)

test('assertSupportedPiVersion fails closed when a runnable version probe exits nonzero', { skip: isWindows }, () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-version-fails', 'version unavailable', 7)
  assert.throws(
    () => assertSupportedPiVersion(stub),
    (err: unknown) =>
      err instanceof PiVersionError &&
      err.message.includes('Could not determine the pi version') &&
      err.message.includes('status 7')
  )
})

test('assertSupportedPiVersion defers launch failures to the real spawn', () => {
  clearPiVersionCacheForTests()
  assert.equal(assertSupportedPiVersion('/definitely/not/a/real/pi-binary'), null)
})

test(
  'PiRpcProcess.spawn rejects a relative unsupported command resolved from its cwd',
  { skip: isWindows },
  async () => {
    clearPiVersionCacheForTests()
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-version-spawn-cwd-'))
    makePiStubIn(cwd, 'pi-relative-old', '0.79.8')
    await assert.rejects(
      PiRpcProcess.spawn({ cwd, piCommand: './pi-relative-old' }),
      (err: unknown) =>
        err instanceof PiRpcSpawnError && err.code === 'UNSUPPORTED_PI_VERSION' && err.message.includes('0.79.8')
    )
  }
)

test('PiRpcProcess.spawn reports a missing Windows command script as ENOENT', { skip: !isWindows }, async () => {
  clearPiVersionCacheForTests()
  await assert.rejects(
    PiRpcProcess.spawn({ cwd: process.cwd(), piCommand: 'pi-acp-definitely-missing.cmd' }),
    (err: unknown) =>
      err instanceof PiRpcSpawnError &&
      err.code === 'ENOENT' &&
      err.message.includes('executable not found') &&
      !err.message.includes('UNSUPPORTED_PI_VERSION')
  )
})

test('PiRpcProcess.spawn rejects unsupported pi versions with a clear error', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-old-spawn', '0.79.8')
  await assert.rejects(
    PiRpcProcess.spawn({ cwd: process.cwd(), piCommand: stub }),
    (err: unknown) =>
      err instanceof PiRpcSpawnError &&
      err.code === 'UNSUPPORTED_PI_VERSION' &&
      err.message.includes('0.79.8') &&
      err.message.includes(MIN_PI_VERSION)
  )
})

test('PiRpcProcess.spawn proceeds for supported pi versions', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  // The stub exits immediately in RPC mode; the best-effort get_state
  // handshake tolerates that, so spawn itself must succeed.
  const stub = makePiStub('pi-supported-spawn', '0.80.6')
  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand: stub })
  proc.dispose()
})
