import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findExecutableOnPath } from '../../src/pi-rpc/command.js'

const isWindows = process.platform === 'win32'
const hostBun = isWindows ? null : findExecutableOnPath('bun')
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const entry = join(repoRoot, 'src/index.ts')

function withFakeBun(status: number): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-bun-'))
  const marker = join(dir, 'argv')
  writeFileSync(
    join(dir, 'bun'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit ${status}\n`,
    'utf-8'
  )
  chmodSync(join(dir, 'bun'), 0o755)
  return { dir, marker }
}

/** A PATH entry holding only `node`, so a co-installed Bun cannot make a Node-run test flaky. */
function makeNodeOnlyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-node-'))
  symlinkSync(process.execPath, join(dir, 'node'))
  return dir
}

/**
 * A client's fresh-launch env: an inherited `PI_ACP_REEXEC` would trip the
 * entry's once-guard and an inherited `PI_ACP_PI_COMMAND` would reroute pi
 * launches away from the fixture. Intentional values come through
 * `overrides`, which are applied after the scrub.
 */
function freshLaunchEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.PI_ACP_REEXEC
  delete env.PI_ACP_PI_COMMAND
  return { ...env, ...overrides }
}

/** Drives a spawned adapter over ACP stdio; stdin stays held open until the test closes it. */
function driveAdapter(child: ChildProcessWithoutNullStreams) {
  const replies: Array<Record<string, unknown>> = []
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim()) replies.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  }
  const waitFor = async (id: number, what: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const reply = replies.find(message => message.id === id)
      if (reply) return reply
      assert.ok(Date.now() < deadline, `no ${what} reply under Bun; stderr: ${stderr}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  // A live getter: returning the string value would freeze the empty
  // snapshot and silence every later failure diagnostic.
  return {
    replies,
    get stderr() {
      return stderr
    },
    closed,
    send,
    waitFor
  }
}

test('driveAdapter exposes stderr emitted after the helper returned', { skip: isWindows }, async () => {
  const child = spawn(
    process.execPath,
    ['-e', "setTimeout(() => { console.error('late stderr'); process.exit(0) }, 50)"],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const adapter = driveAdapter(child)
  child.stdin.end()
  const exit = await adapter.closed
  assert.equal(exit.code, 0)
  assert.match(adapter.stderr, /late stderr/, 'the live getter must observe stderr emitted after the initial snapshot')
})

test('adapter entry re-execs Bun when it is on PATH', { skip: isWindows }, () => {
  const { dir, marker } = withFakeBun(42)
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--forwarded', 'flag'], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, dirname(process.execPath)].join(':') }),
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 42, 'the entry must exit with the re-executed runtime status')
    const argv = readFileSync(marker, 'utf8').trim().split('\n')
    assert.ok(argv[0]?.endsWith('src/index.ts'), `re-exec target must be the entry itself, got: ${argv[0]}`)
    assert.deepEqual(argv.slice(1), ['--forwarded', 'flag'], 'client args must reach the re-executed runtime')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adapter entry re-execs Bun when launched through an npm-style bin symlink', { skip: isWindows }, () => {
  const { dir, marker } = withFakeBun(42)
  const binDir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-bin-'))
  try {
    symlinkSync(entry, join(binDir, 'pi-acp'))
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(binDir, 'pi-acp')], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, dirname(process.execPath)].join(':') }),
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 42, 'the symlinked launch must still re-exec Bun')
    const argv = readFileSync(marker, 'utf8').trim().split('\n')
    assert.ok(argv[0]?.endsWith('src/index.ts'), `re-exec target must be the real entry, got: ${argv[0]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
})

test('adapter entry stays on this Node process when Bun is unavailable', { skip: isWindows }, () => {
  const nodeDir = makeNodeOnlyPath()
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: nodeDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, result.stderr.toString())
  } finally {
    rmSync(nodeDir, { recursive: true, force: true })
  }
})

test('adapter entry runs directly under Bun without re-exec', { skip: !hostBun }, () => {
  const { dir } = withFakeBun(42)
  try {
    const result = spawnSync(hostBun!, [entry], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, dirname(process.execPath)].join(':') }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, 'a re-exec loop would exit with the fake bun status 42')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The re-exec must replace the process in place: the client signals the PID it
 * spawned, and that PID must be the re-executed runtime with its own signal
 * handlers (here: a trapping stub), not a Node trampoline that dies under it.
 */
test(
  're-exec keeps the client PID: SIGTERM reaches the re-executed runtime with stdin still open',
  {
    skip: isWindows,
    timeout: 60_000
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-signal-'))
    const marker = join(dir, 'trapped')
    const pidFile = join(dir, 'pid')
    writeFileSync(
      join(dir, 'bun'),
      `#!/bin/sh\n` +
        // The trap must be installed before the ready-pid write: a SIGTERM
        // landing between the two would kill an untrapping shell.
        `trap 'printf trapped > ${JSON.stringify(marker)}; exit 7' TERM\n` +
        `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}\n` +
        `while :; do /bin/sleep 1; done\n`,
      'utf-8'
    )
    chmodSync(join(dir, 'bun'), 0o755)

    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, dirname(process.execPath)].join(':') }),
      // stdin stays a held-open pipe: the signal must not depend on EOF.
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    try {
      const deadline = Date.now() + 30_000
      let recordedPid = ''
      for (;;) {
        try {
          recordedPid = readFileSync(pidFile, 'utf8').trim()
        } catch {
          /* the re-executed runtime has not written it yet */
        }
        if (recordedPid) break
        assert.ok(Date.now() < deadline, 'the re-executed runtime never started')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(recordedPid, String(child.pid), 'execve must replace the process in place')
      child.kill('SIGTERM')
      const exit = await closed
      assert.equal(
        exit.code,
        7,
        `the re-executed runtime must handle the signal itself (got ${exit.code ?? exit.signal})`
      )
      assert.equal(readFileSync(marker, 'utf8'), 'trapped')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('adapter entry does not loop through a Node-backed bun shim', { skip: isWindows, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-shim-'))
  const nodeDir = makeNodeOnlyPath()
  try {
    // A `bun` that is really a Node script re-invoking the entry: without the
    // once-guard the entry would execve this shim again, forever.
    writeFileSync(
      join(dir, 'bun'),
      '#!/usr/bin/env node\n' +
        "const { spawnSync } = require('node:child_process')\n" +
        "const result = spawnSync(process.execPath, ['--import', 'tsx', ...process.argv.slice(2)], { stdio: 'inherit' })\n" +
        'process.exit(result.status ?? 1)\n',
      'utf-8'
    )
    chmodSync(join(dir, 'bun'), 0o755)
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, nodeDir].join(':') }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `the guarded second pass must stay on Node: ${result.stderr?.toString() ?? ''}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(nodeDir, { recursive: true, force: true })
  }
})

test('adapter serves ACP over stdio when run directly by Bun', { skip: !hostBun, timeout: 60_000 }, async () => {
  const child = spawn(hostBun!, [entry], {
    cwd: repoRoot,
    env: freshLaunchEnv(),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const adapter = driveAdapter(child)
  try {
    adapter.send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const initialized = await adapter.waitFor(1, 'initialize')
    assert.equal(initialized.error, undefined)
    assert.ok(initialized.result, `initialize must succeed under Bun; stderr: ${adapter.stderr}`)
    child.stdin.end()
    const exit = await adapter.closed
    assert.equal(exit.code, 0, `adapter must shut down cleanly on stdin EOF under Bun; stderr: ${adapter.stderr}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

/**
 * The re-exec'd runtime is the process the client signals, so SIGTERM must
 * reach `main.ts`'s handler: the coordinator's `process.exit(0)` gives code 0,
 * while an unhandled signal death would report `signal: 'SIGTERM'` instead.
 */
test(
  'SIGTERM under Bun exits through the shutdown handler with stdin held open',
  {
    skip: !hostBun,
    timeout: 60_000
  },
  async () => {
    const child = spawn(hostBun!, [entry], {
      cwd: repoRoot,
      env: freshLaunchEnv(),
      // stdin stays a held-open pipe: shutdown must be signal-driven, not EOF-driven.
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const adapter = driveAdapter(child)
    try {
      adapter.send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
      const initialized = await adapter.waitFor(1, 'initialize')
      assert.ok(initialized.result, `initialize must succeed under Bun; stderr: ${adapter.stderr}`)
      child.kill('SIGTERM')
      const exit = await adapter.closed
      assert.equal(
        exit.code,
        0,
        `SIGTERM must run the coordinator's process.exit(0), got ${exit.code ?? exit.signal}; stderr: ${adapter.stderr}`
      )
      assert.equal(exit.signal, null, 'the signal must be consumed by the handler, not kill the process')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
)

/**
 * A stub `pi` speaking just the session/new preflight RPCs: version probe,
 * state/models/thinking-levels calls, and a TERM trap recording its disposal.
 * Storage is redirected into the fixture dir so nothing touches the host.
 */
function withStubPi(): { dir: string; sessionsDir: string; disposedMarker: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-session-'))
  const sessionsDir = join(dir, 'sessions')
  const disposedMarker = join(dir, 'disposed')
  const stub = join(dir, 'pi')
  writeFileSync(
    stub,
    `#!/usr/bin/env node\n` +
      `const fs = require('node:fs')\n` +
      `if (process.argv.includes('--version')) { process.stdout.write('1.2.0\\n'); process.exit(0) }\n` +
      `const replies = {\n` +
      `  get_state: { sessionId: 'stub-session', sessionFile: ${JSON.stringify(join(sessionsDir, 'stub-session.jsonl'))}, model: { provider: 'stub', id: 'stub-model' }, thinkingLevel: 'off' },\n` +
      `  get_available_models: { models: [{ provider: 'stub', id: 'stub-model', name: 'Stub Model' }] },\n` +
      `  get_available_thinking_levels: { levels: ['off'] }\n` +
      `}\n` +
      `let buffer = ''\n` +
      `process.stdin.setEncoding('utf8').on('data', chunk => {\n` +
      `  buffer += chunk\n` +
      `  let index\n` +
      `  while ((index = buffer.indexOf('\\n')) >= 0) {\n` +
      `    const line = buffer.slice(0, index)\n` +
      `    buffer = buffer.slice(index + 1)\n` +
      `    let msg = null\n` +
      `    try { msg = JSON.parse(line) } catch {}\n` +
      `    if (msg && typeof msg.id === 'string' && typeof msg.type === 'string') {\n` +
      `      process.stdout.write(JSON.stringify({\n` +
      `        type: 'response', id: msg.id, command: msg.type,\n` +
      `        success: Object.prototype.hasOwnProperty.call(replies, msg.type),\n` +
      `        data: replies[msg.type] ?? null\n` +
      `      }) + '\\n')\n` +
      `    }\n` +
      `  }\n` +
      `})\n` +
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(disposedMarker)}, 'disposed'); process.exit(0) })\n`,
    'utf-8'
  )
  chmodSync(stub, 0o755)
  return { dir, sessionsDir, disposedMarker, path: stub }
}

test('SIGTERM under Bun disposes the live pi session child', { skip: !hostBun, timeout: 60_000 }, async () => {
  const stub = withStubPi()
  try {
    const child = spawn(hostBun!, [entry], {
      cwd: repoRoot,
      env: freshLaunchEnv({
        PATH: [stub.dir, dirname(process.execPath)].join(':'),
        PI_ACP_PI_COMMAND: stub.path,
        PI_ACP_DIR: join(stub.dir, 'pi-acp-store'),
        PI_CODING_AGENT_SESSION_DIR: stub.sessionsDir
      }),
      // stdin stays a held-open pipe: shutdown must be signal-driven, not EOF-driven.
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const adapter = driveAdapter(child)
    try {
      adapter.send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
      assert.ok((await adapter.waitFor(1, 'initialize')).result, `stderr: ${adapter.stderr}`)
      adapter.send(2, 'session/new', { cwd: repoRoot, mcpServers: [] })
      const created = await adapter.waitFor(2, 'session/new')
      assert.equal(
        created.error,
        undefined,
        `session/new must succeed against the stub pi: ${JSON.stringify(created.error)}`
      )
      child.kill('SIGTERM')
      const exit = await adapter.closed
      assert.equal(
        exit.code,
        0,
        `SIGTERM must exit through the coordinator, got ${exit.code ?? exit.signal}; stderr: ${adapter.stderr}`
      )
      assert.equal(
        readFileSync(stub.disposedMarker, 'utf8'),
        'disposed',
        'the shutdown coordinator must terminate the session pi child'
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})

test('entry scrubs PI_ACP_REEXEC before main so pi children never inherit it', { skip: isWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-marker-'))
  const marker = join(dir, 'pi-saw')
  writeFileSync(
    join(dir, 'pi'),
    `#!/bin/sh\n` +
      `if [ -n "\${PI_ACP_REEXEC:-}" ]; then printf set > ${JSON.stringify(marker)};` +
      ` else printf unset > ${JSON.stringify(marker)}; fi\n` +
      `exit 0\n`,
    'utf-8'
  )
  chmodSync(join(dir, 'pi'), 0o755)
  try {
    // A deliberately inherited marker models a launch from an adapter-spawned
    // environment; --terminal-login reaches main's pi spawn without a session.
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--terminal-login'], {
      cwd: repoRoot,
      env: { ...freshLaunchEnv({ PATH: dir }), PI_ACP_REEXEC: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, result.stderr.toString())
    assert.equal(readFileSync(marker, 'utf8'), 'unset', 'pi must not see the once-marker')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A terminal-login fixture: an eligible default `pi` (a symlink to a
 * Node-shebang .js entry recording its runtime) plus a `bun` that records the
 * argv it is handed. Nothing here touches real credentials.
 */
function withTerminalLoginFixture(): {
  dir: string
  nodeDir: string
  cli: string
  bunArgv: string
  piRuntime: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-entry-login-'))
  const nodeDir = makeNodeOnlyPath()
  const bunArgv = join(dir, 'bun-argv')
  const piRuntime = join(dir, 'pi-runtime')
  const cli = join(dir, 'cli.js')
  writeFileSync(
    cli,
    '#!/usr/bin/env node\n' +
      `require('node:fs').writeFileSync(${JSON.stringify(piRuntime)}, process.versions.bun ?? 'node')\n`,
    'utf-8'
  )
  chmodSync(cli, 0o755)
  symlinkSync(cli, join(dir, 'pi'))
  writeFileSync(join(dir, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(bunArgv)}\nexit 7\n`, 'utf-8')
  chmodSync(join(dir, 'bun'), 0o755)
  return { dir, nodeDir, cli, bunArgv, piRuntime }
}

test('terminal login launches a default JavaScript Pi through Bun', { skip: isWindows }, () => {
  const { dir, nodeDir, cli, bunArgv } = withTerminalLoginFixture()
  try {
    // The once-marker keeps this Node pass out of the entry's own re-exec, so
    // the launch under test is main's pi invocation, not the entry's.
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--terminal-login'], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, nodeDir].join(':'), PI_ACP_REEXEC: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 7, `the default JS Pi must launch through Bun; stderr: ${result.stderr}`)
    const argv = readFileSync(bunArgv, 'utf8').trim().split('\n')
    assert.equal(argv[0], realpathSync(cli), `bun must receive the resolved pi entry, got: ${argv[0]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(nodeDir, { recursive: true, force: true })
  }
})

test('terminal login keeps a bare PI_ACP_PI_COMMAND on its original runtime', { skip: isWindows }, () => {
  const { dir, nodeDir, bunArgv, piRuntime } = withTerminalLoginFixture()
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--terminal-login'], {
      cwd: repoRoot,
      env: freshLaunchEnv({ PATH: [dir, nodeDir].join(':'), PI_ACP_REEXEC: '1', PI_ACP_PI_COMMAND: 'pi' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `pi itself must run; stderr: ${result.stderr}`)
    assert.equal(readFileSync(piRuntime, 'utf8'), 'node', 'the bare override must run through its own shebang runtime')
    assert.equal(existsSync(bunArgv), false, 'the override must not reroute through Bun')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(nodeDir, { recursive: true, force: true })
  }
})
