import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPiInvocation, findExecutableOnPath, resolveWindowsScriptCommand } from '../../src/pi-rpc/command.js'

const isWindows = process.platform === 'win32'
const hostBun = isWindows ? null : findExecutableOnPath('bun')
const commandSrc = fileURLToPath(new URL('../../src/pi-rpc/command.ts', import.meta.url))

test('buildPiInvocation launches native executables directly', () => {
  assert.deepEqual(buildPiInvocation('/opt/pi', ['--session', '/tmp/a b.jsonl'], { platform: 'linux' }), {
    executable: '/opt/pi',
    args: ['--session', '/tmp/a b.jsonl']
  })
})

test('buildPiInvocation resolves Windows batch launchers and escapes command syntax', () => {
  const invocation = buildPiInvocation('pi.cmd', ['--session', 'C:\\x y\\a"&|<>^()%!.jsonl'], {
    platform: 'win32',
    cwd: 'C:\\work',
    env: { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    fileExists: path => path === 'C:\\bin\\pi.cmd'
  })
  assert.equal(invocation?.executable, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(invocation?.windowsVerbatimArguments, true)
  assert.deepEqual(invocation?.args.slice(0, 3), ['/d', '/s', '/c'])
  const commandLine = invocation?.args[3] ?? ''
  for (const escaped of ['^&', '^|', '^<', '^>', '^^', '^(', '^)', '%%', '^!']) assert.ok(commandLine.includes(escaped))
  assert.doesNotMatch(invocation?.args[3] ?? '', /shell:true/)
})

test('resolveWindowsScriptCommand does not accept a missing launcher', () => {
  assert.equal(
    resolveWindowsScriptCommand('pi.cmd', 'C:\\work', 'C:\\bin', () => false),
    null
  )
})

function makeRuntimeFixture(): {
  dir: string
  binDir: string
  writeExecutable: (path: string, content: string) => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const writeExecutable = (path: string, content: string) => {
    writeFileSync(path, content, 'utf-8')
    chmodSync(path, 0o755)
  }
  return { dir, binDir, writeExecutable }
}

function withCleanedFixture(t: { after: (fn: () => void) => void }) {
  const fixture = makeRuntimeFixture()
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }))
  return fixture
}

function linkDefaultPi(binDir: string, writeExecutable: (path: string, content: string) => void): string {
  const cli = join(binDir, 'cli.js')
  writeExecutable(cli, '#!/usr/bin/env node\n')
  symlinkSync(cli, join(binDir, 'pi'))
  return cli
}

test('buildPiInvocation prefers Bun for a default direct JavaScript Pi install', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  const cli = linkDefaultPi(binDir, writeExecutable)
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const invocation = buildPiInvocation('pi', ['--mode', 'rpc'], {
    platform: 'linux',
    env: { PATH: binDir },
    defaultCommand: true
  })

  assert.deepEqual(invocation, { executable: join(binDir, 'bun'), args: [realpathSync(cli), '--mode', 'rpc'] })
})

test('buildPiInvocation keeps the plain command when Bun is unavailable', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  linkDefaultPi(binDir, writeExecutable)

  const invocation = buildPiInvocation('pi', ['--mode', 'rpc'], {
    platform: 'linux',
    env: { PATH: binDir },
    defaultCommand: true
  })

  assert.deepEqual(invocation, { executable: 'pi', args: ['--mode', 'rpc'] })
})

test('buildPiInvocation preserves custom command overrides verbatim', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  linkDefaultPi(binDir, writeExecutable)
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const invocation = buildPiInvocation('pi', ['--mode', 'rpc'], { platform: 'linux', env: { PATH: binDir } })

  assert.deepEqual(invocation, { executable: 'pi', args: ['--mode', 'rpc'] })
})

test(
  'buildPiInvocation leaves shell launchers and standalone binaries on their own runtime',
  { skip: isWindows },
  t => {
    const { binDir, writeExecutable } = withCleanedFixture(t)
    writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

    writeExecutable(join(binDir, 'pi'), '#!/bin/sh\nexec pi-real "$@"\n')
    assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
      executable: 'pi',
      args: []
    })

    writeExecutable(join(binDir, 'pi'), '\u007fELF standalone binary')
    assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
      executable: 'pi',
      args: []
    })
  }
)

test(
  'buildPiInvocation leaves .js-suffixed shell launchers and binaries on their own runtime',
  { skip: isWindows },
  t => {
    const { binDir, writeExecutable } = withCleanedFixture(t)
    writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

    const launcher = join(binDir, 'launcher.js')
    writeExecutable(launcher, '#!/bin/sh\nexec pi-real "$@"\n')
    symlinkSync(launcher, join(binDir, 'pi'))
    assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
      executable: 'pi',
      args: []
    })

    const binary = join(binDir, 'pi-binary.js')
    writeExecutable(binary, '\u007fELF standalone binary')
    rmSync(join(binDir, 'pi'))
    symlinkSync(binary, join(binDir, 'pi'))
    assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
      executable: 'pi',
      args: []
    })
  }
)

test('buildPiInvocation reroutes Bun-shebang entries and stays conservative otherwise', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const bunEntry = join(binDir, 'bun-cli.js')
  writeExecutable(bunEntry, '#!/usr/bin/env bun\n')
  symlinkSync(bunEntry, join(binDir, 'pi'))
  assert.equal(
    buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true })?.executable,
    join(binDir, 'bun')
  )

  const directNodeEntry = join(binDir, 'node-cli.js')
  writeExecutable(directNodeEntry, '#!/usr/bin/node\n')
  rmSync(join(binDir, 'pi'))
  symlinkSync(directNodeEntry, join(binDir, 'pi'))
  assert.equal(
    buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true })?.executable,
    join(binDir, 'bun')
  )

  const flagged = join(binDir, 'flagged.js')
  writeExecutable(flagged, '#!/usr/bin/env -S node --max-old-space-size=4096\n')
  rmSync(join(binDir, 'pi'))
  symlinkSync(flagged, join(binDir, 'pi'))
  assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
    executable: 'pi',
    args: []
  })

  const unknown = join(binDir, 'unknown.js')
  writeExecutable(unknown, '#!/usr/bin/env python3\n')
  rmSync(join(binDir, 'pi'))
  symlinkSync(unknown, join(binDir, 'pi'))
  assert.deepEqual(buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true }), {
    executable: 'pi',
    args: []
  })
})

test('buildPiInvocation falls back to the bare default command when pi is not on PATH', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const invocation = buildPiInvocation('pi', [], { platform: 'linux', env: { PATH: binDir }, defaultCommand: true })

  assert.deepEqual(invocation, { executable: 'pi', args: [] })
})

test('buildPiInvocation resolves empty PATH entries to the cwd like execvp', { skip: isWindows }, t => {
  const { dir, writeExecutable } = withCleanedFixture(t)
  const cli = join(dir, 'cli.js')
  writeExecutable(cli, '#!/usr/bin/env node\n')
  symlinkSync(cli, join(dir, 'pi'))
  writeExecutable(join(dir, 'bun'), '#!/bin/sh\nexit 0\n')

  const invocation = buildPiInvocation('pi', [], {
    platform: 'linux',
    env: { PATH: '' },
    cwd: dir,
    defaultCommand: true
  })

  assert.equal(invocation?.executable, join(dir, 'bun'))
  assert.equal(invocation?.args[0], realpathSync(cli))
})

test('findExecutableOnPath treats an absent PATH as the execvp default, never the cwd', { skip: isWindows }, t => {
  const { dir, writeExecutable } = withCleanedFixture(t)
  writeExecutable(join(dir, 'bun'), '#!/bin/sh\nexit 0\n')

  const found = findExecutableOnPath('bun', { cwd: dir, env: {} })

  assert.ok(
    found === null || found === '/usr/bin/bun' || found === '/bin/bun',
    `an absent PATH must not resolve through the cwd: ${found}`
  )
})

test('findExecutableOnPath reads only the exact POSIX PATH key', { skip: isWindows }, t => {
  const { binDir, writeExecutable } = withCleanedFixture(t)
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const found = findExecutableOnPath('bun', { cwd: binDir, env: { Path: binDir } })

  assert.ok(
    found === null || found === '/usr/bin/bun' || found === '/bin/bun',
    `\`Path\` must not stand in for the exact \`PATH\` key: ${found}`
  )
})

test('findExecutableOnPath resolves .. through symlinked PATH entries like execvp', { skip: isWindows }, t => {
  const { dir, binDir, writeExecutable } = withCleanedFixture(t)
  mkdirSync(join(dir, 'real', 'bin'), { recursive: true })
  mkdirSync(join(dir, 'real', 'inner'))
  writeExecutable(join(dir, 'real', 'bin', 'bun'), '#!/bin/sh\n# resolved-through-symlink\n')
  // Lexical normalization of `<dir>/link/../bin` lands here, in the fixture's bin dir.
  writeExecutable(join(binDir, 'bun'), '#!/bin/sh\n# lexical-decoy\n')
  symlinkSync(join(dir, 'real', 'inner'), join(dir, 'link'))

  const found = findExecutableOnPath('bun', { env: { PATH: `${dir}/link/../bin` } })

  // The kernel resolves `link` and then `..`, so the candidate must be the
  // file behind the symlink, not the lexically normalized decoy.
  assert.ok(found, 'the symlinked PATH entry must resolve through the filesystem')
  assert.ok(readFileSync(found, 'utf8').includes('resolved-through-symlink'), `wrong entry picked: ${found}`)
})

test('buildPiInvocation keeps the original command when the PATH to pi contains ..', { skip: isWindows }, t => {
  const { dir, binDir, writeExecutable } = withCleanedFixture(t)
  const bunDir = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-bun-'))
  t.after(() => rmSync(bunDir, { recursive: true, force: true }))
  writeExecutable(join(bunDir, 'bun'), '#!/bin/sh\nexit 0\n')

  const realBin = join(dir, 'real', 'bin')
  mkdirSync(realBin, { recursive: true })
  mkdirSync(join(dir, 'real', 'inner'), { recursive: true })
  const cli = join(realBin, 'cli.js')
  writeExecutable(cli, '#!/usr/bin/env node\n')
  symlinkSync(cli, join(realBin, 'pi'))
  // Lexical collapse of `<dir>/link/../bin` lands on this equally eligible
  // entry: such candidates are ambiguous, so the original command survives
  // and the launch path keeps kernel resolution.
  writeExecutable(join(binDir, 'cli.js'), '#!/usr/bin/env node\n')
  symlinkSync(join(binDir, 'cli.js'), join(binDir, 'pi'))
  symlinkSync(join(dir, 'real', 'inner'), join(dir, 'link'))

  const invocation = buildPiInvocation('pi', ['--mode', 'rpc'], {
    platform: 'linux',
    env: { PATH: `${bunDir}:${dir}/link/../bin` },
    defaultCommand: true
  })

  assert.deepEqual(invocation, { executable: 'pi', args: ['--mode', 'rpc'] })
})

test(
  'buildPiInvocation reroutes under the real Bun runtime except for .. PATH candidates',
  { skip: isWindows || !hostBun, timeout: 60_000 },
  t => {
    const { dir, binDir, writeExecutable } = withCleanedFixture(t)
    const bunDir = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-bun-'))
    t.after(() => rmSync(bunDir, { recursive: true, force: true }))
    writeExecutable(join(bunDir, 'bun'), '#!/bin/sh\nexit 0\n')

    // The reported decoy layout: `link` hides a directory switch, so
    // `link/../bin` resolves physically to `real/bin` but lexically to `bin`.
    // Both `pi` entries are hardlinks of one eligible module importing
    // `./runtime.mjs`, and the sibling modules differ, so inode identity
    // cannot tell the two module trees apart.
    const realBin = join(dir, 'real', 'bin')
    mkdirSync(realBin, { recursive: true })
    mkdirSync(join(dir, 'real', 'inner'), { recursive: true })
    const realCli = join(realBin, 'cli.js')
    writeExecutable(realCli, '#!/usr/bin/env node\nimport { where } from "./runtime.mjs"\nconsole.log(where)\n')
    writeFileSync(join(realBin, 'runtime.mjs'), 'export const where = "physical"\n')
    linkSync(realCli, join(binDir, 'cli.js'))
    writeFileSync(join(binDir, 'runtime.mjs'), 'export const where = "decoy"\n')
    symlinkSync(realCli, join(realBin, 'pi'))
    symlinkSync(join(binDir, 'cli.js'), join(binDir, 'pi'))
    symlinkSync(join(dir, 'real', 'inner'), join(dir, 'link'))
    assert.equal(statSync(realCli).ino, statSync(join(binDir, 'cli.js')).ino, 'the decoy entry must be a hardlink')

    const plainDir = join(dir, 'plain')
    mkdirSync(plainDir)
    const plainCli = join(plainDir, 'cli.js')
    writeExecutable(plainCli, '#!/usr/bin/env node\n')
    symlinkSync(plainCli, join(plainDir, 'pi'))

    // Resolution must run under the host Bun runtime, whose realpathSync
    // collapses `..` lexically: the hardlinked decoy must keep the plain
    // command while an ordinary unambiguous install still prefers Bun.
    const driver = join(dir, 'driver.ts')
    writeFileSync(
      driver,
      `import { spawnSync } from 'node:child_process'\n` +
        `import { buildPiInvocation } from ${JSON.stringify(commandSrc)}\n` +
        `for (const [label, path] of ${JSON.stringify([
          ['hardlink', `${bunDir}:${dir}/link/../bin`],
          ['plain', `${bunDir}:${plainDir}`]
        ])}) {\n` +
        `  console.log(label + ' ' + JSON.stringify(buildPiInvocation('pi', ['--mode', 'rpc'], { platform: 'linux', env: { PATH: path }, defaultCommand: true })))\n` +
        `}\n` +
        `for (const [label, entry] of ${JSON.stringify([
          ['physical-sibling', realCli],
          ['lexical-sibling', join(binDir, 'cli.js')]
        ])}) {\n` +
        `  const run = spawnSync(${JSON.stringify(hostBun)}, [entry], { encoding: 'utf8' })\n` +
        `  console.log(label + ' ' + JSON.stringify((run.stdout || '').trim()))\n` +
        `}\n`,
      'utf-8'
    )
    const result = spawnSync(hostBun!, [driver], {
      cwd: dir,
      env: { PATH: `${bunDir}:${binDir}` },
      encoding: 'utf8',
      timeout: 60_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `the driver must run under the host Bun: ${result.stderr}`)
    const driverValue = (key: string): unknown => {
      const line = result.stdout
        .trim()
        .split('\n')
        .find(candidate => candidate.startsWith(`${key} `))
      assert.ok(line, `the driver must print the ${key} case: ${result.stdout}`)
      return JSON.parse(line.slice(key.length + 1))
    }
    assert.deepEqual(driverValue('hardlink'), { executable: 'pi', args: ['--mode', 'rpc'] })
    assert.deepEqual(driverValue('plain'), {
      executable: join(bunDir, 'bun'),
      args: [realpathSync(plainCli), '--mode', 'rpc']
    })
    assert.equal(driverValue('physical-sibling'), 'physical')
    assert.equal(driverValue('lexical-sibling'), 'decoy')
  }
)

test('buildPiInvocation keeps Windows launches unchanged for the default command', () => {
  const invocation = buildPiInvocation('pi.cmd', ['--session', 'C:\\x y\\s.jsonl'], {
    platform: 'win32',
    cwd: 'C:\\work',
    env: { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    fileExists: path => path === 'C:\\bin\\pi.cmd',
    defaultCommand: true
  })
  assert.equal(invocation?.executable, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(invocation?.windowsVerbatimArguments, true)
})
