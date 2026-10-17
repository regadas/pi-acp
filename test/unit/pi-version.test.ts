import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIN_PI_VERSION,
  PI_FEATURE_MIN_VERSION,
  PiVersionError,
  assertSupportedPiVersion,
  clearPiVersionCacheForTests,
  comparePiVersions,
  parsePiVersion
} from '../../src/pi-rpc/version.js'
import { findExecutableOnPath, resolveWindowsScriptCommand } from '../../src/pi-rpc/command.js'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

const isWindows = process.platform === 'win32'
const hostBun = isWindows ? null : findExecutableOnPath('bun')
const bunDir = hostBun ? dirname(hostBun) : ''

test('supported Pi floor is 1.2.0 and covers every historical feature floor', () => {
  assert.equal(MIN_PI_VERSION, '1.2.0')
  for (const [feature, version] of Object.entries(PI_FEATURE_MIN_VERSION))
    assert.ok(comparePiVersions(version, MIN_PI_VERSION) <= 0, `${feature} must exist at the supported floor`)
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

for (const resumed of [false, true]) {
  test(
    `PiRpcProcess.spawn leaves prompt resources to Pi for ${resumed ? 'resumed' : 'new'} sessions`,
    { skip: isWindows },
    async () => {
      clearPiVersionCacheForTests()
      const dir = mkdtempSync(join(tmpdir(), 'pi-acp-argv-'))
      const stub = join(dir, 'pi-args')
      const capture = join(dir, 'args.json')
      writeFileSync(
        stub,
        '#!/usr/bin/env node\n' +
          `if (process.argv[2] === '--version') console.log(${JSON.stringify(MIN_PI_VERSION)});\n` +
          `else require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`
      )
      chmodSync(stub, 0o755)
      const sessionPath = join(dir, 'session.jsonl')
      let proc: PiRpcProcess | undefined
      try {
        proc = await PiRpcProcess.spawn({ cwd: dir, piCommand: stub, ...(resumed ? { sessionPath } : {}) })
        await proc.whenTerminated()
        const args: string[] = JSON.parse(readFileSync(capture, 'utf8'))
        assert.equal(args.includes('--append-system-prompt'), false, 'adapter argv must not override APPEND_SYSTEM')
        assert.deepEqual(args.slice(0, 4), ['--mode', 'rpc', '--no-themes', '--extension'])
        assert.match(args[4] ?? '', /acp-extension\.(ts|js)$/)
        assert.deepEqual(args.slice(5), resumed ? ['--session', sessionPath] : [])
      } finally {
        proc?.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
}

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

test(
  'assertSupportedPiVersion: a hanging Windows .cmd wrapper version probe abort kills the whole tree',
  { skip: isWindows ? false : 'Windows-only: exercises the real cmd.exe wrapper and taskkill' },
  async t => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-version-win-tree-'))
    const pidFile = join(dir, 'version-pids.txt')
    const grandchildFixture = fileURLToPath(new URL('../fixtures/fake-pi-cmd-grandchild.mjs', import.meta.url))
    // npm-style launcher: cmd.exe relays to a node grandchild exactly like a
    // default `pi` install on Windows. The grandchild hangs on --version and
    // holds the inherited stdio pipes, so only a whole-tree kill can settle
    // the aborted probe (the probe settles on close, never on a root kill).
    writeFileSync(join(dir, 'pi-fixture.cmd'), `@echo off\r\n"${process.execPath}" "${grandchildFixture}" %*\r\n`)
    const previousPidFile = process.env.PI_ACP_TEST_TREE_PID_FILE
    const previousHang = process.env.PI_ACP_TEST_HANG_VERSION
    process.env.PI_ACP_TEST_TREE_PID_FILE = pidFile
    process.env.PI_ACP_TEST_HANG_VERSION = '1'
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let wrapperPid = 0
    let grandchildPid = 0
    t.after(() => {
      if (previousPidFile === undefined) delete process.env.PI_ACP_TEST_TREE_PID_FILE
      else process.env.PI_ACP_TEST_TREE_PID_FILE = previousPidFile
      if (previousHang === undefined) delete process.env.PI_ACP_TEST_HANG_VERSION
      else process.env.PI_ACP_TEST_HANG_VERSION = previousHang
      // Cleanup must not leak processes even when an assertion fails first.
      for (const pid of [wrapperPid, grandchildPid]) {
        if (pid > 0 && alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* raced natural exit */
          }
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    })

    const controller = new AbortController()
    const checking = assertSupportedPiVersion(join(dir, 'pi-fixture.cmd'), dir, controller.signal)
    // The grandchild creates the pid file before it finishes writing both
    // pids, so existence alone can observe an empty file: poll until exactly
    // two positive numeric PID tokens are readable (bounded).
    const readPidPair = (): [number, number] | null => {
      try {
        const tokens = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
        if (tokens.length === 2 && tokens.every(pid => Number.isInteger(pid) && pid > 0)) {
          return [tokens[0]!, tokens[1]!]
        }
      } catch {
        /* Both pids are not readable yet. */
      }
      return null
    }
    const reportDeadline = Date.now() + 10_000
    let pids = readPidPair()
    while (Date.now() < reportDeadline && !pids) {
      await new Promise(r => setTimeout(r, 25))
      pids = readPidPair()
    }
    ;[grandchildPid, wrapperPid] = pids!
    assert.ok(grandchildPid > 0 && wrapperPid > 0, 'the hanging grandchild must report both pids')
    assert.ok(alive(wrapperPid) && alive(grandchildPid), 'wrapper and grandchild must be alive before abort')

    controller.abort()
    await assert.rejects(
      checking,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
      'the aborted probe must settle through tree termination, not the 15s timeout'
    )
    // The probe rejects only on close, which the pipe-holding grandchild
    // releases when the whole tree dies: the settled rejection proves it.
    assert.equal(alive(grandchildPid), false, 'the hanging pi grandchild must be dead after probe abort')
    assert.equal(alive(wrapperPid), false, 'the cmd.exe wrapper must be dead after probe abort')
  }
)

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
  assert.equal(await assertSupportedPiVersion(makePiStub('pi-ok-newer', '1.2.1')), '1.2.1')
})

test('assertSupportedPiVersion fails closed on versions older than the minimum', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-old', '1.0.4')
  await assert.rejects(
    assertSupportedPiVersion(stub),
    (err: unknown) =>
      err instanceof PiVersionError &&
      err.message.includes('1.0.4') &&
      err.message.includes(MIN_PI_VERSION) &&
      err.message.includes('agent_before_settle')
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
    makePiStubIn(supportedDir, 'pi-relative', '1.2.1')
    makePiStubIn(oldDir, 'pi-relative', '1.0.4')

    assert.equal(await assertSupportedPiVersion('./pi-relative', supportedDir), '1.2.1')
    await assert.rejects(
      assertSupportedPiVersion('./pi-relative', oldDir),
      (err: unknown) => err instanceof PiVersionError && err.message.includes('1.0.4')
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
  const stub = makePiStub('pi-supported-spawn', '1.2.1')
  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand: stub })
  proc.dispose()
})

test('PiRpcProcess.spawn reports the child to its owner before resolving', { skip: isWindows }, async () => {
  clearPiVersionCacheForTests()
  const stub = makePiStub('pi-onprocess-spawn', '1.2.1')
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
  const stub = makePiStub('pi-onprocess-throws', '1.2.1')
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

/** npm-style `pi` symlink to a JavaScript entry, printing its runtime's marker version. */
function makeJsPiStub(dir: string, bunVersion: string, nodeVersion: string): void {
  const cli = join(dir, 'cli.mjs')
  writeFileSync(
    cli,
    '#!/usr/bin/env node\n' +
      `if (process.argv.includes('--version')) console.log(process.versions.bun ? ${JSON.stringify(bunVersion)} : ${JSON.stringify(nodeVersion)})\n` +
      'else process.exit(0)\n',
    'utf-8'
  )
  chmodSync(cli, 0o755)
  symlinkSync(cli, join(dir, 'pi'))
}

/**
 * A PATH entry holding only `node` (as a symlink), so shebang-based probes
 * stay hermetic even when the host keeps Node and Bun in one bin directory.
 */
function makeNodeOnlyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-node-only-'))
  symlinkSync(process.execPath, join(dir, 'node'))
  return dir
}

function withPath<T>(entries: readonly string[], run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH
  process.env.PATH = entries.join(':')
  return run().finally(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    clearPiVersionCacheForTests()
  })
}

test('assertSupportedPiVersion probes a default JavaScript Pi install through Bun', { skip: !hostBun }, async () => {
  clearPiVersionCacheForTests()
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bun-probe-'))
  const nodeDir = makeNodeOnlyPath()
  try {
    makeJsPiStub(dir, '1.2.1', '1.2.2')

    // The fixture comes first so a real `pi` in Bun's bin dir cannot shadow it.
    await withPath([dir, bunDir, nodeDir], async () => {
      assert.equal(await assertSupportedPiVersion('pi', dir, undefined, true), '1.2.1')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(nodeDir, { recursive: true, force: true })
  }
})

test(
  'assertSupportedPiVersion probes a JavaScript Pi install through its Node shebang without Bun',
  {
    skip: isWindows
  },
  async () => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-node-probe-'))
    const nodeDir = makeNodeOnlyPath()
    try {
      makeJsPiStub(dir, '1.2.1', '1.2.2')

      await withPath([dir, nodeDir], async () => {
        assert.equal(await assertSupportedPiVersion('pi', dir, undefined, true), '1.2.2')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(nodeDir, { recursive: true, force: true })
    }
  }
)

test(
  'assertSupportedPiVersion preserves explicit command overrides even with Bun installed',
  {
    skip: !hostBun
  },
  async () => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bun-override-'))
    const nodeDir = makeNodeOnlyPath()
    try {
      const cli = join(dir, 'cli.mjs')
      makeJsPiStub(dir, '1.2.1', '1.2.2')

      await withPath([nodeDir, bunDir], async () => {
        assert.equal(await assertSupportedPiVersion(cli), '1.2.2')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(nodeDir, { recursive: true, force: true })
    }
  }
)

test(
  'assertSupportedPiVersion caches default and override probes separately',
  {
    skip: !hostBun
  },
  async () => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bun-cache-'))
    const nodeDir = makeNodeOnlyPath()
    try {
      makeJsPiStub(dir, '1.2.1', '1.2.2')

      await withPath([dir, bunDir, nodeDir], async () => {
        // Both call orders share one cache: the probes must stay
        // runtime-separated instead of the first result winning.
        assert.equal(await assertSupportedPiVersion('pi', dir, undefined, false), '1.2.2')
        assert.equal(await assertSupportedPiVersion('pi', dir, undefined, true), '1.2.1')
        assert.equal(await assertSupportedPiVersion('pi', dir, undefined, false), '1.2.2')
        assert.equal(await assertSupportedPiVersion('pi', dir, undefined, true), '1.2.1')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(nodeDir, { recursive: true, force: true })
    }
  }
)

test(
  'PiRpcProcess.spawn keeps an explicit bare `pi` override on its own runtime even with Bun on PATH',
  {
    skip: isWindows
  },
  async () => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bun-bare-override-'))
    const nodeDir = makeNodeOnlyPath()
    const captured = join(dir, 'argv.json')
    const cli = join(dir, 'cli.mjs')
    writeFileSync(
      cli,
      '#!/usr/bin/env node\n' +
        `import { writeFileSync } from 'node:fs'\n` +
        `if (process.argv.includes('--version')) console.log(process.versions.bun ? '1.2.1' : '1.2.2')\n` +
        `else writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ argv: process.argv.slice(2), runtime: process.versions.bun ?? 'node' }))\n`,
      'utf-8'
    )
    chmodSync(cli, 0o755)
    symlinkSync(cli, join(dir, 'pi'))
    // A `bun` on PATH proves the override stays verbatim instead of rerouting;
    // the fake bun records nothing, so a wrongful reroute fails the capture.
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(join(dir, 'bun'), 0o755)

    let proc: PiRpcProcess | undefined
    try {
      proc = await withPath([dir, nodeDir], () => PiRpcProcess.spawn({ cwd: dir, piCommand: 'pi' }))
      await proc.whenTerminated()
      const capture = JSON.parse(readFileSync(captured, 'utf8')) as { argv: string[]; runtime: string }
      assert.equal(capture.runtime, 'node', 'an explicit bare `pi` override must not reroute to Bun')
      assert.deepEqual(capture.argv.slice(0, 4), ['--mode', 'rpc', '--no-themes', '--extension'])
    } finally {
      proc?.dispose()
      rmSync(dir, { recursive: true, force: true })
      rmSync(nodeDir, { recursive: true, force: true })
    }
  }
)

test(
  'PiRpcProcess.spawn passes adapter args to a default JavaScript Pi install under Bun',
  {
    skip: !hostBun
  },
  async () => {
    clearPiVersionCacheForTests()
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bun-spawn-'))
    const nodeDir = makeNodeOnlyPath()
    const captured = join(dir, 'argv.json')
    const cli = join(dir, 'cli.mjs')
    writeFileSync(
      cli,
      '#!/usr/bin/env node\n' +
        `import { writeFileSync } from 'node:fs'\n` +
        `if (process.argv.includes('--version')) console.log(process.versions.bun ? '1.2.1' : '1.2.2')\n` +
        `else writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ argv: process.argv.slice(2), runtime: process.versions.bun ?? 'node' }))\n`,
      'utf-8'
    )
    chmodSync(cli, 0o755)
    symlinkSync(cli, join(dir, 'pi'))

    let proc: PiRpcProcess | undefined
    try {
      proc = await withPath([dir, bunDir, nodeDir], () => PiRpcProcess.spawn({ cwd: dir }))
      await proc.whenTerminated()
      const capture = JSON.parse(readFileSync(captured, 'utf8')) as { argv: string[]; runtime: string }
      assert.match(capture.runtime, /\d/, 'the RPC child must actually run under Bun')
      assert.deepEqual(capture.argv.slice(0, 4), ['--mode', 'rpc', '--no-themes', '--extension'])
      assert.match(
        capture.argv[4] ?? '',
        /acp-extension\.(ts|js)$/,
        'adapter args reach the Bun-launched entry unchanged'
      )
    } finally {
      proc?.dispose()
      rmSync(dir, { recursive: true, force: true })
      rmSync(nodeDir, { recursive: true, force: true })
    }
  }
)
