import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_PI_VERSION,
  PI_FEATURE_MIN_VERSION,
  PiVersionError,
  assertSupportedPiVersion,
  clearPiVersionCacheForTests,
  comparePiVersions,
  parsePiVersion
} from '../../src/pi-rpc/version.js'
import { resolveWindowsScriptCommand } from '../../src/pi-rpc/command.js'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

const isWindows = process.platform === 'win32'

test('minimum-version feature matrix keeps only newer thinking discovery behind fallback', () => {
  for (const [feature, version] of Object.entries(PI_FEATURE_MIN_VERSION)) {
    if (feature === 'getAvailableThinkingLevels') assert.ok(comparePiVersions(version, MIN_PI_VERSION) > 0)
    else assert.ok(comparePiVersions(version, MIN_PI_VERSION) <= 0, `${feature} must exist at the supported floor`)
  }
})

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

function makeHangingPiStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-version-hanging-'))
  const stub = join(dir, 'pi-hanging')
  writeFileSync(stub, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n', 'utf-8')
  chmodSync(stub, 0o755)
  return stub
}

function makeDelayedCountingPiStub(counter: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-version-shared-'))
  const stub = join(dir, 'pi-shared')
  writeFileSync(
    stub,
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x')\n` +
      `setTimeout(() => console.log(${JSON.stringify(MIN_PI_VERSION)}), 100)\n`,
    'utf-8'
  )
  chmodSync(stub, 0o755)
  return stub
}

test('parsePiVersion accepts semver output with optional v prefix', () => {
  assert.equal(parsePiVersion('0.80.6\n'), '0.80.6')
  assert.equal(parsePiVersion('v0.80.4'), '0.80.4')
  assert.equal(parsePiVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(parsePiVersion('pi help text'), null)
  assert.equal(parsePiVersion(''), null)
  assert.equal(parsePiVersion('0.80'), null)
  assert.equal(parsePiVersion('1.2.3-alpha.1+sha.abc'), '1.2.3-alpha.1+sha.abc')
})

test('parsePiVersion rejects non-standard SemVer forms', () => {
  for (const invalid of [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3-alpha..1',
    '1.2.3+build..1',
    '1.2.3-alpha_1',
    '1.2.3+'
  ]) {
    assert.equal(parsePiVersion(invalid), null, invalid)
  }
})

test('comparePiVersions orders x.y.z numerically', () => {
  assert.equal(comparePiVersions('0.80.4', '0.80.4'), 0)
  assert.equal(comparePiVersions('0.80.6', '0.80.4'), 1)
  assert.equal(comparePiVersions('0.80.3', '0.80.4'), -1)
  assert.equal(comparePiVersions('0.79.10', '0.80.0'), -1)
  assert.equal(comparePiVersions('1.0.0', '0.99.99'), 1)
})

test('comparePiVersions is arbitrary-precision safe for core and prerelease numbers', () => {
  assert.equal(comparePiVersions('999999999999999999999999999999.0.0', '999999999999999999999999999998.999.999'), 1)
  assert.equal(
    comparePiVersions('1.0.0-alpha.999999999999999999999999999999', '1.0.0-alpha.999999999999999999999999999998'),
    1
  )
})

test('comparePiVersions applies full SemVer prerelease precedence', () => {
  // A prerelease sorts below its stable release (SemVer §11).
  assert.equal(comparePiVersions('0.80.4-alpha', '0.80.4'), -1)
  assert.equal(comparePiVersions('0.80.4', '0.80.4-alpha'), 1)
  assert.equal(comparePiVersions('0.80.4-alpha', '0.80.4-alpha'), 0)

  // Numeric identifiers compare numerically and rank below alphanumeric.
  assert.equal(comparePiVersions('1.0.0-alpha.2', '1.0.0-alpha.11'), -1)
  assert.equal(comparePiVersions('1.0.0-1', '1.0.0-alpha'), -1)

  // A shorter identifier list ranks below a longer one with an equal prefix.
  assert.equal(comparePiVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)

  // Alphanumeric identifiers compare lexically.
  assert.equal(comparePiVersions('1.0.0-alpha', '1.0.0-beta'), -1)

  // Build metadata never affects precedence.
  assert.equal(comparePiVersions('1.0.0+build.5', '1.0.0'), 0)
  assert.equal(comparePiVersions('1.0.0-alpha+sha.1', '1.0.0-alpha'), 0)

  // A prerelease of a higher base still ranks above a lower stable base.
  assert.equal(comparePiVersions('0.80.5-alpha', '0.80.4'), 1)
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

test('PiRpcProcess.spawn observes a child that exits immediately after spawn', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-immediate-exit-'))
  const stub = makePiStubIn(dir, 'pi-immediate', MIN_PI_VERSION)
  const proc = await PiRpcProcess.spawn({ cwd: dir, piCommand: stub })
  let timer: NodeJS.Timeout | undefined
  try {
    const termination = await Promise.race([
      new Promise<import('../../src/pi-rpc/process.js').PiRpcTermination>(resolve => proc.onTermination(resolve)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('immediate exit was not observed')), 2_000)
      })
    ])
    assert.equal(termination.reason, 'exit')
    assert.equal(termination.code, 0)
  } finally {
    if (timer) clearTimeout(timer)
  }
})

test('assertSupportedPiVersion aborts an in-flight version child', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const controller = new AbortController()
  const checking = assertSupportedPiVersion(makeHangingPiStub(), process.cwd(), controller.signal)
  setTimeout(() => controller.abort(), 20)

  await assert.rejects(
    checking,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
    'shutdown cancellation must settle before the 15 second preflight timeout'
  )
})

test('one version caller abort does not kill a probe used by another caller', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const counter = join(mkdtempSync(join(tmpdir(), 'pi-acp-version-count-')), 'count')
  const command = makeDelayedCountingPiStub(counter)
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = assertSupportedPiVersion(command, process.cwd(), firstController.signal)
  const second = assertSupportedPiVersion(command, process.cwd(), secondController.signal)

  setTimeout(() => firstController.abort(), 20)
  await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(await second, MIN_PI_VERSION)
  assert.equal(readFileSync(counter, 'utf8'), 'x', 'concurrent callers share one version child')
})

test('assertSupportedPiVersion accepts the minimum and newer versions', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  assert.equal(await assertSupportedPiVersion(makePiStub('pi-ok-min', MIN_PI_VERSION)), MIN_PI_VERSION)
  assert.equal(await assertSupportedPiVersion(makePiStub('pi-ok-newer', '0.80.6')), '0.80.6')
})

test('assertSupportedPiVersion fails closed on versions older than the minimum', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-old', '0.80.3')
  await assert.rejects(
    assertSupportedPiVersion(stub),
    (err: unknown) =>
      err instanceof PiVersionError &&
      err.message.includes('0.80.3') &&
      err.message.includes(MIN_PI_VERSION) &&
      err.message.includes('agent_settled')
  )
})

test('assertSupportedPiVersion fails closed on unparseable version output', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-garbage', 'not a version')
  await assert.rejects(
    assertSupportedPiVersion(stub),
    (err: unknown) => err instanceof PiVersionError && err.message.includes('Could not determine the pi version')
  )
})

test(
  'assertSupportedPiVersion uses cwd for relative commands and isolates the cache by cwd',
  { skip: isWindows },
  async () => {
    clearPiVersionCacheForTests()
    const supportedDir = mkdtempSync(join(tmpdir(), 'pi-acp-version-cwd-supported-'))
    const oldDir = mkdtempSync(join(tmpdir(), 'pi-acp-version-cwd-old-'))
    makePiStubIn(supportedDir, 'pi-relative', '0.80.6')
    makePiStubIn(oldDir, 'pi-relative', '0.80.3')

    assert.equal(await assertSupportedPiVersion('./pi-relative', supportedDir), '0.80.6')
    await assert.rejects(
      assertSupportedPiVersion('./pi-relative', oldDir),
      (err: unknown) => err instanceof PiVersionError && err.message.includes('0.80.3')
    )
  }
)

test(
  'assertSupportedPiVersion fails closed when a runnable version probe exits nonzero',
  { skip: isWindows },
  async () => {
    clearPiVersionCacheForTests()
    const stub = makePiStub('pi-version-fails', 'version unavailable', 7)
    await assert.rejects(
      assertSupportedPiVersion(stub),
      (err: unknown) =>
        err instanceof PiVersionError &&
        err.message.includes('Could not determine the pi version') &&
        err.message.includes('status 7')
    )
  }
)

test('assertSupportedPiVersion defers launch failures to the real spawn', async () => {
  clearPiVersionCacheForTests()
  assert.equal(await assertSupportedPiVersion('/definitely/not/a/real/pi-binary'), null)
})

test('assertSupportedPiVersion does not retain a resolved missing-command result', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-version-late-install-'))
  const command = join(dir, 'pi-late')
  assert.equal(await assertSupportedPiVersion(command, dir), null)

  makePiStubIn(dir, 'pi-late', MIN_PI_VERSION)
  assert.equal(await assertSupportedPiVersion(command, dir), MIN_PI_VERSION)
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

test('PiRpcProcess.spawn reports the child to its owner before resolving', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-onprocess-spawn', '0.80.6')
  const reported: PiRpcProcess[] = []

  const spawning = PiRpcProcess.spawn({
    cwd: process.cwd(),
    piCommand: stub,
    onProcess: proc => reported.push(proc)
  })

  // The asynchronous version preflight runs before the RPC child exists.
  assert.equal(reported.length, 0)

  const proc = await spawning
  assert.equal(proc, reported[0], 'the reported child is the one handed back')
  proc.dispose()
})

test('PiRpcProcess.spawn disposes the child when its ownership hook throws', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-onprocess-throws', '0.80.6')
  const reported: PiRpcProcess[] = []

  await assert.rejects(
    PiRpcProcess.spawn({
      cwd: process.cwd(),
      piCommand: stub,
      onProcess: proc => {
        reported.push(proc)
        throw new Error('ownership registration failed')
      }
    }),
    /ownership registration failed/
  )

  // Failing closed: the child is torn down rather than left running unowned.
  await reported[0]!.whenTerminated()
})
