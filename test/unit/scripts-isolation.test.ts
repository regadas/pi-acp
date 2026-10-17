import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Recursive path -> kind snapshot; any creation, deletion or rewrite shows up as a diff. */
function snapshotTree(root: string): Record<string, 'file' | 'dir' | 'symlink'> {
  const tree: Record<string, 'file' | 'dir' | 'symlink'> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      tree[path] = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file'
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  return tree
}

/**
 * The hostile environment a developer shell may export: real-looking user
 * paths with marker content, an override pi command that must never run, a
 * stale reexec marker and provider credentials that must not reach probes.
 * The nested child also gets a private temp root: os.tmpdir() is shared with
 * any concurrently running `npm test`/`npm run smoke`, so cleanup assertions
 * must not observe the global listing.
 */
function sentinelUserState(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const acpDir = join(root, 'sentinel-pi-acp')
  const agentDir = join(root, 'sentinel-agent')
  const sessionsDir = join(root, 'sentinel-sessions')
  const tmpRoot = join(root, 'tmp')
  for (const dir of [join(home, '.pi'), acpDir, agentDir, sessionsDir, tmpRoot]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.pi', 'user-marker'), 'sentinel')
  for (const dir of [acpDir, agentDir, sessionsDir]) writeFileSync(join(dir, 'user-marker'), 'sentinel')
  const piOverride = join(root, 'sentinel-pi-command')
  writeFileSync(piOverride, `#!/bin/sh\nprintf leak > ${JSON.stringify(join(acpDir, 'pi-command-leak'))}\nexit 42\n`)
  chmodSync(piOverride, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_ACP_DIR: acpDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_ACP_PI_COMMAND: piOverride,
    PI_ACP_REEXEC: '1',
    ANTHROPIC_API_KEY: 'sentinel-anthropic-credential',
    OPENAI_API_KEY: 'sentinel-openai-credential',
    TMPDIR: tmpRoot,
    TEMP: tmpRoot,
    TMP: tmpRoot
  }
  // This regression itself runs as a node --test child; those runner-internal
  // markers would make a nested `node --test` refuse to run files at all.
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  const trees = () => ({
    home: snapshotTree(home),
    acpDir: snapshotTree(acpDir),
    agentDir: snapshotTree(agentDir),
    sessionsDir: snapshotTree(sessionsDir)
  })
  return { root, env, tmpRoot, trees }
}

test('test runner: selected tests run against disposable user state and leave inherited paths untouched', async () => {
  const state = sentinelUserState('pi-acp-isolated-probe-runner-')
  // A minimal suite for the actual runner: importing the real leaky test file
  // registers its tests, so the runner spawns exactly one tsx child instead of
  // recompiling the whole suite beside the concurrently running outer one.
  const runnerCwd = join(state.root, 'runner-cwd')
  mkdirSync(join(runnerCwd, 'test'), { recursive: true })
  symlinkSync(join(repoRoot, 'node_modules'), join(runnerCwd, 'node_modules'))
  writeFileSync(
    join(runnerCwd, 'test', 'isolation-probe.test.ts'),
    `import ${JSON.stringify(
      pathToFileURL(join(repoRoot, 'test/unit/new-session-runtime-startup-errors.test.ts')).href
    )}\n`
  )
  // Concurrent same-prefix activity in the shared os.tmpdir(): another
  // `npm test`/`npm run smoke` running at the same time holds its own
  // `pi-acp-test-env-*` root open for the duration of this nested run.
  // mkdtemp owns this path uniquely: a `Date.now()` name could collide with
  // a concurrent runner, and the loser's cleanup would remove the winner's
  // root.
  const concurrentRoot = mkdtempSync(join(tmpdir(), 'pi-acp-test-env-held-'))
  try {
    const before = state.trees()
    // An owned same-prefix root in the private temp dir: the nested runner
    // must clean up its own root and leave foreign roots alone.
    const ownedRoot = mkdtempSync(join(state.tmpRoot, 'pi-acp-test-env-owned-'))
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      let stdout = ''
      let stderr = ''
      const child = spawn(
        process.execPath,
        [
          join(repoRoot, 'scripts/test.mjs'),
          '--test-name-pattern=Internal error on non-auth model probe failures after spawn',
          '--test-reporter=tap'
        ],
        { cwd: runnerCwd, env: state.env }
      )
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      child.stdout?.setEncoding('utf8').on('data', chunk => {
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8').on('data', chunk => {
        stderr += chunk
      })
      child.on('error', error => {
        stderr += String(error)
      })
      child.on('close', status => {
        clearTimeout(killTimer)
        resolve({ status, stdout, stderr })
      })
    })
    assert.equal(result.status, 0, `isolated runner failed:\n${result.stdout}\n${result.stderr}`)
    assert.match(
      result.stdout,
      /ok \d+ - PiAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn/
    )
    assert.deepEqual(state.trees(), before, 'inherited user paths must stay untouched')
    // Cleanup is proven on the private temp root the child actually uses; a
    // concurrently held same-prefix directory in the shared os.tmpdir() must
    // not be able to fail this assertion. The owned same-prefix root must
    // survive: the runner removes only its own allocation. Foreign tool
    // caches (e.g. tsx) are not the runner's disposable state either.
    assert.deepEqual(
      readdirSync(state.tmpRoot).filter(name => name.startsWith('pi-acp-test-env-')),
      [basename(ownedRoot)],
      'the runner must clean up its own disposable root and leave foreign same-prefix roots alone'
    )
  } finally {
    rmSync(concurrentRoot, { recursive: true, force: true })
    rmSync(state.root, { recursive: true, force: true })
  }
})

test('isolatedEnv scrubs inherited adapter-internal bridge keys', () => {
  const observed = join(tmpdir(), `pi-acp-isolated-env-${process.pid}.json`)
  const probe = [
    `import { isolatedEnv } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/isolated-env.mjs')).href)}`,
    "import { writeFileSync } from 'node:fs'",
    `const env = isolatedEnv({ ...process.env, PI_ACP_WORKSPACE_ROOTS: '["/poisoned"]' }, ` +
      `{ home: '/h', workspace: '/w', acpDir: '/a', agentDir: '/g', root: '/r' })`,
    `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({`,
    '  roots: env.PI_ACP_WORKSPACE_ROOTS ?? null,',
    '  piCommand: env.PI_ACP_PI_COMMAND ?? null',
    '}))'
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, PI_ACP_WORKSPACE_ROOTS: '["/inherited/outer-root"]', PI_ACP_PI_COMMAND: '/bin/false' },
    encoding: 'utf8'
  })
  try {
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `isolated-env probe failed:\n${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), { roots: null, piCommand: null })
  } finally {
    rmSync(observed, { force: true })
  }
})

test('ordinary smoke: disposable user state and scrubbed overrides reach the built adapter', () => {
  const state = sentinelUserState('pi-acp-isolated-probe-smoke-')
  const launchCwd = join(state.root, 'launch-cwd')
  const observed = join(state.root, 'observed.json')
  mkdirSync(join(launchCwd, 'dist'), { recursive: true })
  writeFileSync(
    join(launchCwd, 'dist', 'index.js'),
    `import { writeFileSync } from 'node:fs'
let buffer = ''
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'session/new') {
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: message.params.cwd, env: {
        HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        PI_ACP_DIR: process.env.PI_ACP_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
        PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND, PI_ACP_REEXEC: process.env.PI_ACP_REEXEC,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY
      }}))
      reply(message.id, { sessionId: 'smoke-fake-session' })
    } else if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] })
    else if (message.method === 'session/prompt') reply(message.id, { stopReason: 'end_turn' })
  }
})
process.stdin.on('end', () => process.exit(0))
`
  )
  try {
    const before = state.trees()
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/smoke-acp.mjs')], {
      cwd: launchCwd,
      env: state.env,
      encoding: 'utf8',
      timeout: 60_000
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, `ordinary smoke failed:\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /ACP smoke passed/)
    const seen = JSON.parse(readFileSync(observed, 'utf8')) as {
      cwd: string
      env: Record<string, string | undefined>
    }
    assert.notEqual(seen.cwd, launchCwd, 'the session workspace must be disposable, not the launch cwd')
    assert.ok(
      seen.cwd.startsWith(join(state.tmpRoot, 'pi-acp-smoke-')),
      'workspace must live under the smoke root in the private temp dir'
    )
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'PI_ACP_DIR', 'PI_CODING_AGENT_DIR']) {
      assert.ok(
        seen.env[key]?.startsWith(join(state.tmpRoot, 'pi-acp-smoke-')),
        `${key} must point into the disposable root`
      )
      assert.notEqual(seen.env[key], state.env[key], `${key} must not leak the inherited value`)
    }
    assert.equal(seen.env.PI_ACP_PI_COMMAND, undefined, 'the inherited pi command override must be scrubbed')
    assert.equal(seen.env.PI_ACP_REEXEC, undefined, 'a stale reexec marker must be scrubbed')
    assert.equal(
      seen.env.PI_CODING_AGENT_SESSION_DIR,
      undefined,
      'an inherited custom session directory must be scrubbed so sessions land under the disposable agent dir'
    )
    assert.equal(seen.env.ANTHROPIC_API_KEY, 'pi-acp-smoke-no-call')
    assert.equal(seen.env.OPENAI_API_KEY, 'pi-acp-smoke-no-call')
    assert.deepEqual(state.trees(), before, 'inherited user paths must stay untouched')
    assert.deepEqual(
      readdirSync(state.tmpRoot).filter(name => name.startsWith('pi-acp-smoke-')),
      [],
      'the smoke probe must clean up its disposable root under its private temp dir'
    )
  } finally {
    rmSync(state.root, { recursive: true, force: true })
  }
})
