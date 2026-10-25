import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runner = join(repoRoot, 'scripts', 'eval-acp-tck.mjs')
const fixture = join(repoRoot, 'scripts', 'fixtures', 'acp-tck-extension.ts')
const pinnedRevision = '3d46e2168aa3c23fe3853d539141a65a54d6a880'
const setupUvSha = '07a047e608db84b3d8c06cd9a7c7dcc9c355c18e'
const isWindows = process.platform === 'win32'

test('eval:tck builds the adapter, runs the tck runner, and pins the same revision everywhere', () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts as Record<string, string>
  assert.ok(scripts['eval:tck']?.includes('npm run build'), 'eval:tck must build the adapter first')
  assert.ok(scripts['eval:tck']?.includes('scripts/eval-acp-tck.mjs'), 'eval:tck must run the tck runner')
  const runnerSource = readFileSync(runner, 'utf8')
  assert.match(runnerSource, new RegExp(`TCK_REVISION = '${pinnedRevision}'`))
  const bootstrap = join(repoRoot, 'scripts', 'fixtures', 'acp-tck-agent-bootstrap.mjs')
  assert.ok(existsSync(bootstrap), 'the owned agent bootstrap must exist')
  assert.ok(
    runnerSource.includes('acp-tck-agent-bootstrap.mjs'),
    'the runner must launch TCK agents through the registration bootstrap'
  )
  const docs = readFileSync(join(repoRoot, 'docs', 'adapter-reference.md'), 'utf8')
  assert.ok(docs.includes(pinnedRevision), 'docs must pin the TCK revision')
  assert.ok(docs.includes('PI_ACP_TCK_DIR'), 'docs must name the checkout variable')
  assert.ok(docs.includes('PI_ACP_TCK_REPORT_DIR'), 'docs must document the report location')
  assert.ok(/do not commit it/.test(docs), 'docs must warn about report transcript sensitivity')
})

test('the runner cancel prompt carries the fixture marker and the fixture supports selection and images', () => {
  const runnerSource = readFileSync(runner, 'utf8')
  const fixtureSource = readFileSync(fixture, 'utf8')
  const marker = fixtureSource.match(/CANCEL_MARKER = '([^']+)'/)?.[1]
  assert.ok(marker, 'fixture must define CANCEL_MARKER')
  assert.ok(runnerSource.includes(marker!), 'runner --cancel-prompt must carry the fixture marker')
  assert.ok(fixtureSource.includes("'alternate'"), 'fixture must register a second model for model selection')
  assert.ok(fixtureSource.includes('reasoning: true'), 'fixture models must be reasoning-capable for thought levels')
  assert.ok(fixtureSource.includes("input: ['text', 'image']"), 'fixture models must accept image input')
})

test('CI runs the pinned TCK as a diagnostics job that tolerates verdict exits and re-raises harness failures', () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const start = ci.indexOf('  tck:')
  assert.ok(start >= 0, 'ci.yml must define the tck job')
  const job = ci.slice(start)
  assert.ok(job.includes('repository: agentclientprotocol/acp-tck'), 'the tck job must check out upstream acp-tck')
  assert.ok(job.includes(`ref: ${pinnedRevision}`), 'the tck job must pin the upstream revision')
  assert.ok(
    job.includes(`astral-sh/setup-uv@${setupUvSha}`),
    'the tck job must pin setup-uv to the verified v10.3.2 commit SHA'
  )
  assert.ok(
    job.includes('npm install --global @earendil-works/pi-coding-agent@1.4.0'),
    'the tck job must install the pinned pi'
  )
  assert.ok(job.includes('PI_ACP_TCK_DIR'), 'the tck job must point the runner at its checkout')
  assert.match(
    job,
    /- run: npm run build\n(.*\n)*?.*Run the pinned ACP v1 TCK/,
    'the tck job must build the adapter in a separate step before running the TCK, so build failures fail the job instead of reaching the verdict filter'
  )
  assert.match(
    job,
    /node scripts\/eval-acp-tck\.mjs \|\| status=\$\?/,
    'the TCK step must launch the runner directly, so only genuine runner exits reach the exit-code filter'
  )
  assert.match(
    job,
    /\[ "\$status" -ne 0 \] && \[ "\$status" -ne 1 \]/,
    'exit 0 and exit 1 conformance verdicts must both be tolerated as recorded findings'
  )
  assert.match(
    job,
    /exit "\$status"/,
    'every other exit code — notably 3, a harness/setup/timeout failure — must re-raise and fail the job'
  )
  assert.ok(!job.includes('continue-on-error'), 'the TCK step must not mask harness/setup/timeout failures as green')
  assert.ok(job.includes('if: always()'), 'diagnostics must upload even when the TCK step fails')
  assert.ok(job.includes('actions/upload-artifact@v7'), 'the tck job must upload the report')
  assert.ok(!ci.slice(0, start).includes('continue-on-error:'), 'the existing required jobs must stay blocking')
})

test('docs state the MCP conformance outcome truthfully and bound the passthrough', () => {
  const docs = readFileSync(join(repoRoot, 'docs', 'adapter-reference.md'), 'utf8')
  assert.match(docs, /ACP-SESSION-003[^]*?fail/, 'docs must say ACP-SESSION-003 fails')
  assert.match(docs, /ACP-SESSION-004[^]*?skipped/, 'docs must say ACP-SESSION-004 is skipped, not failed')
  assert.match(docs, /`-k`/, 'docs must document the accepted diagnostic selectors')
  assert.match(docs, /rejected as a setup\s+error/, 'docs must state that other extra arguments are rejected')
  assert.match(docs, /Bun re-exec is not\s+exercised/, 'docs must not claim Bun runtime proof for the TCK')
})

/**
 * A hermetic stand-in for the whole external TCK surface: fake `git`/`uv`/`pi`
 * executables on PATH (plus a `node` symlink — nothing else, no ambient
 * directories), a fake pinned checkout and a fake built adapter. The fake uv
 * records its argv, writes a report to the --report-json path it was given and
 * launches the recorded agent command with the environment the real TCK would
 * pass on, so the assertions observe the runner's real behavior.
 */
function fakeTckWorld({ launchDirName = 'launch' }: { launchDirName?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-tck-unit-'))
  const bin = join(root, 'bin')
  const tckDir = join(root, 'tck-checkout')
  const reportDir = join(root, 'persistent-reports')
  const launchCwd = join(root, launchDirName)
  const tmpRoot = join(root, 'tmp')
  const observed = join(root, 'observed-agent.json')
  const recordedArgs = join(root, 'recorded-uv-args.json')
  const descendantScript = join(root, 'fake-descendant.mjs')
  const descendantPid = join(root, 'descendant.pid')
  const lateLog = join(root, 'late-start.log')
  const latePid = join(root, 'late-start.pid')
  const tckRegistry = join(root, 'tck-registry.txt')
  // A valid-looking pinned repository the ambient git repo-selection overrides
  // point at: unlike the PI_ACP_TCK_DIR checkout it must never be judged.
  const ambientRepo = join(root, 'ambient-pinned-repo')
  for (const dir of [bin, tckDir, reportDir, join(launchCwd, 'dist'), tmpRoot, ambientRepo]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(tckDir, 'marker.txt'), 'pinned checkout')
  writeFileSync(join(ambientRepo, 'marker.txt'), 'ambient pinned repository')
  // The sentinel user state a developer shell may export.
  const sentinelHome = join(root, 'sentinel-home')
  mkdirSync(sentinelHome, { recursive: true })
  const shims: Array<[string, string]> = [
    [
      'git',
      `#!/bin/sh
if [ "\${FAKE_GIT_BROKEN:-0}" = "1" ]; then
  echo 'fatal: not a git repository (or any of the parent directories): .git' >&2
  exit 128
fi
if [ -n "\${GIT_DIR:-}" ]; then
  # git's ambient repo-selection override: GIT_DIR redirects rev-parse and
  # status to that repository instead of the -C checkout. The scrub must keep
  # this branch unreachable for the probes; it emulates the redirect pointing
  # at a valid pinned repository.
  case "$*" in
    *"rev-parse HEAD"*) echo "${pinnedRevision}"; exit 0 ;;
    *"status --porcelain"*) exit 0 ;;
    *) echo "unexpected git call: $*" >&2; exit 1 ;;
  esac
fi
case "$*" in
  *"rev-parse HEAD"*) echo "\${FAKE_GIT_REVISION:-${pinnedRevision}}" ;;
  *"status --porcelain"*) [ "\${FAKE_GIT_DIRTY:-0}" = "1" ] && echo ' M marker.txt'; exit 0 ;;
  *) echo "unexpected git call: $*" >&2; exit 1 ;;
esac
`
    ],
    [
      'pi',
      `#!/bin/sh
if [ "\${FAKE_PI_CRASH:-0}" = "1" ]; then echo 'pi: boom' >&2; exit 3; fi
if [ -n "\${FAKE_PI_DELAY:-}" ]; then /bin/sleep "$FAKE_PI_DELAY"; fi
if [ "\${FAKE_PI_IGNORE_TERM:-0}" = "1" ]; then trap '' TERM; /bin/sleep 5; echo "pi 1.2.0"; exit 0; fi
echo "\${FAKE_PI_VERSION:-pi 1.2.0}"
`
    ],
    [
      'uv',
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('uv 0.12.17 (fake)')
  process.exit(0)
}
writeFileSync(process.env.FAKE_TCK_ARGS, JSON.stringify(argv))
writeFileSync(process.env.FAKE_TCK_REGISTRY, process.env.PI_ACP_TCK_AGENT_REGISTRY)
const command = argv.slice(argv.indexOf('--') + 1)
let descendant
if (process.env.FAKE_TCK_DESCENDANT === '1') {
  // The real TCK starts each agent in its own session (start_new_session)
  // through the runner's registered bootstrap; this stand-in does the same.
  descendant = spawn(command[0], [command[1], process.env.FAKE_DESCENDANT_SCRIPT], { detached: true, stdio: 'ignore' })
  descendant.unref()
}
if (process.env.FAKE_TCK_LATE_START === '1') {
  // A deliberately late agent start: it sleeps past the runner's teardown
  // seal, then runs the real bootstrap+adapter exactly as a late TCK agent
  // would (own session, output captured to a log for the test).
  const delay = process.env.FAKE_TCK_LATE_DELAY ?? '5'
  const late = spawn('/bin/sh', [
    '-c',
    '/bin/sleep ' + delay + '; exec "$0" "$@" > "' + process.env.FAKE_TCK_LATE_LOG + '" 2>&1',
    command[0],
    command[1],
    command[2]
  ], { detached: true, stdio: 'ignore' })
  writeFileSync(process.env.FAKE_TCK_LATE_PID, String(late.pid))
  late.unref()
}
if (descendant?.pid) {
  // Wait boundedly for the descendant's readiness receipt instead of its
  // registry entry: the pid file is written after registration and handler
  // setup, so a fast uv exit observes a genuinely ready agent root.
  const receipt = process.env.FAKE_DESCENDANT_PID
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !existsSync(receipt)) await new Promise(resolve => setTimeout(resolve, 20))
}
if (process.env.FAKE_TCK_HANG === '1') {
  setInterval(() => {}, 1000)
  setTimeout(() => process.exit(0), 120000)
} else {
  if (process.env.FAKE_TCK_NO_REPORT !== '1') {
    const reportPath = argv[argv.indexOf('--report-json') + 1]
    const conformant = process.env.FAKE_TCK_CONFORMANT === 'true'
    const base = {
      protocol_version: 1,
      verdict: {
        conformant,
        blocked_by_auth: false,
        blocked_by_version_mismatch: false,
        tier_counts: {
          MANDATORY: { PASS: 1, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 },
          CAPABILITY: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 },
          ADVISORY: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 },
          INFORMATIONAL: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 }
        }
      },
      requirements: [{ id: 'ACP-FAKE-001', tier: 'MANDATORY', status: 'PASS', tests: [{ nodeid: 'fake::test', status: 'PASS' }] }]
    }
    const variant = process.env.FAKE_TCK_REPORT_VARIANT
    if (process.env.FAKE_TCK_MALFORMED === '1') writeFileSync(reportPath, '{ not json')
    else if (variant === 'no-protocol') writeFileSync(reportPath, JSON.stringify({ ...base, protocol_version: 2 }))
    else if (variant === 'no-requirements') writeFileSync(reportPath, JSON.stringify({ ...base, requirements: [] }))
    else if (variant === 'bad-requirement') writeFileSync(reportPath, JSON.stringify({ ...base, requirements: [{ id: 'X', tier: 'WEIRD', status: 'PASS' }] }))
    else if (variant === 'bad-verdict') writeFileSync(reportPath, JSON.stringify({ ...base, verdict: { conformant, tier_counts: { MANDATORY: { PASS: 'many' } } } }))
    else if (variant === 'empty-counts') writeFileSync(reportPath, JSON.stringify({ ...base, verdict: { ...base.verdict, tier_counts: {} } }))
    else if (variant?.startsWith('missing-tier:')) {
      const removed = variant.slice('missing-tier:'.length)
      const { [removed]: dropped, ...tierCounts } = base.verdict.tier_counts
      writeFileSync(reportPath, JSON.stringify({ ...base, verdict: { ...base.verdict, tier_counts: tierCounts } }))
    }
    else if (variant?.startsWith('negative-count:')) {
      const tier = variant.slice('negative-count:'.length)
      writeFileSync(reportPath, JSON.stringify({ ...base, verdict: { ...base.verdict, tier_counts: { ...base.verdict.tier_counts, [tier]: { ...base.verdict.tier_counts[tier], FAIL: -1 } } } }))
    }
    else if (process.env.FAKE_TCK_VARIANT === 'partial')
      writeFileSync(reportPath, JSON.stringify({
        protocol_version: 1,
        verdict: {
          conformant: false,
          blocked_by_auth: true,
          blocked_by_version_mismatch: true,
          tier_counts: {
            MANDATORY: { PASS: 5, FAIL: 0, SKIPPED: 0, NOT_TESTED: 26 },
            CAPABILITY: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 },
            ADVISORY: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 },
            INFORMATIONAL: { PASS: 0, FAIL: 0, SKIPPED: 0, NOT_TESTED: 0 }
          }
        },
        requirements: [
          { id: 'ACP-CANCEL-001', tier: 'MANDATORY', status: 'SKIPPED', tests: [] },
          { id: 'ACP-CANCEL-002', tier: 'MANDATORY', status: 'NOT_TESTED', tests: [] }
        ]
      }))
    else writeFileSync(reportPath, JSON.stringify(base))
  }
  const child = spawn(command[0], command.slice(1), { env: process.env, stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end()
  child.on('exit', () => process.exit(Number(process.env.FAKE_TCK_EXIT ?? 0)))
}
`
    ]
  ]
  for (const [name, source] of shims) {
    writeFileSync(join(bin, name), source, { mode: 0o755 })
    chmodSync(join(bin, name), 0o755)
  }
  // PATH contains only the fake bin: a node symlink replaces the ambient node
  // directory, so no installed uv/pi/git can leak into hermetic cases.
  symlinkSync(process.execPath, join(bin, 'node'))
  // A separately-sessioned, SIGTERM-ignoring owned descendant: only a hard
  // escalation after a graceful period can tear it down.
  writeFileSync(
    descendantScript,
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_DESCENDANT_PID, String(process.pid))
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1000)
setTimeout(() => process.exit(0), 60000)
`
  )
  writeFileSync(
    join(launchCwd, 'dist', 'index.js'),
    `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const agentDir = process.env.PI_CODING_AGENT_DIR
const record = {
  argv: process.argv.slice(1),
  env: {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PI_ACP_DIR: process.env.PI_ACP_DIR, PI_CODING_AGENT_DIR: agentDir,
    PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND, PI_ACP_REEXEC: process.env.PI_ACP_REEXEC,
    PI_ACP_WORKSPACE_ROOTS: process.env.PI_ACP_WORKSPACE_ROOTS,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
    AWS_PROFILE: process.env.AWS_PROFILE, AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    SENTINEL_PASSWORD: process.env.SENTINEL_PASSWORD, SENTINEL_TOKEN: process.env.SENTINEL_TOKEN,
    PYTEST_ADDOPTS: process.env.PYTEST_ADDOPTS, PYTEST_PLUGINS: process.env.PYTEST_PLUGINS,
    PYTHONPATH: process.env.PYTHONPATH, PYTHONSTARTUP: process.env.PYTHONSTARTUP,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PI_MODEL: process.env.PI_MODEL, PI_MANAGED_INSTALL_ROOT: process.env.PI_MANAGED_INSTALL_ROOT,
    PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR, PI_SESSION_FILE: process.env.PI_SESSION_FILE,
    GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    TMPDIR: process.env.TMPDIR, UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR, UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
    PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE,
    PI_ACP_TCK_AGENT_REGISTRY: process.env.PI_ACP_TCK_AGENT_REGISTRY
  },
  settings: JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')),
  extension: readFileSync(join(agentDir, 'extensions', 'acp-tck-extension.ts'), 'utf8')
}
if (process.env.FAKE_BOGUS_REGISTRY === '1') {
  // Negative controls for identity validation: a live decoy pid carrying a
  // wrong fingerprint (pid-reuse shape) and a pid that does not exist. The
  // runner must retire/skip both without ever signaling them.
  const registry = process.env.PI_ACP_TCK_AGENT_REGISTRY
  const decoyPid = Number(readFileSync(process.env.FAKE_DECOY_PID, 'utf8'))
  writeFileSync(join(registry, decoyPid + '.json'), JSON.stringify({ pid: decoyPid, fingerprint: 'lstart:not-the-real-one' }))
  writeFileSync(join(registry, '2000000000.json'), JSON.stringify({ pid: 2000000000, fingerprint: 'lstart:bogus' }))
}
writeFileSync(process.env.FAKE_AGENT_OBSERVED, JSON.stringify(record))
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
`
  )
  const decoyScript = join(root, 'fake-decoy.mjs')
  const decoyPidFile = join(root, 'decoy.pid')
  writeFileSync(
    decoyScript,
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_DECOY_PID, String(process.pid))
setInterval(() => {}, 1000)
setTimeout(() => process.exit(0), 120000)
`
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    HOME: sentinelHome,
    USERPROFILE: sentinelHome,
    XDG_CONFIG_HOME: join(sentinelHome, '.config'),
    PI_ACP_DIR: join(root, 'sentinel-pi-acp'),
    PI_CODING_AGENT_DIR: join(root, 'sentinel-agent'),
    PI_CODING_AGENT_SESSION_DIR: join(root, 'sentinel-sessions'),
    PI_ACP_PI_COMMAND: join(root, 'sentinel-pi-command'),
    PI_ACP_REEXEC: '1',
    PI_ACP_WORKSPACE_ROOTS: '["/sentinel-root"]',
    ANTHROPIC_API_KEY: 'sentinel-anthropic',
    OPENAI_API_KEY: 'sentinel-openai',
    GEMINI_API_KEY: 'sentinel-gemini',
    AWS_ACCESS_KEY_ID: 'sentinel-aws-id',
    AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret',
    AWS_BEARER_TOKEN_BEDROCK: 'sentinel-aws-bearer',
    AWS_PROFILE: 'sentinel-profile',
    AWS_CONFIG_FILE: '/sentinel/aws-config',
    GOOGLE_APPLICATION_CREDENTIALS: '/sentinel/google-credentials.json',
    SENTINEL_PASSWORD: 'sentinel-password',
    SENTINEL_TOKEN: 'sentinel-token',
    PYTEST_ADDOPTS: '--collect-only',
    PYTEST_PLUGINS: 'sentinel_plugin',
    PYTHONPATH: '/poison',
    PYTHONSTARTUP: '/poison.py',
    NODE_OPTIONS: '--max-old-space-size=4096',
    PI_MODEL: 'ambient-model',
    PI_MANAGED_INSTALL_ROOT: '/sentinel-managed-root',
    PI_PACKAGE_DIR: '/sentinel-package-dir',
    PI_SESSION_FILE: '/sentinel-session-file',
    GIT_DIR: join(ambientRepo, '.git'),
    GIT_WORK_TREE: ambientRepo,
    GIT_INDEX_FILE: join(ambientRepo, '.git', 'index'),
    TMPDIR: tmpRoot,
    TEMP: tmpRoot,
    TMP: tmpRoot,
    PI_ACP_TCK_DIR: tckDir,
    PI_ACP_TCK_REPORT_DIR: reportDir,
    FAKE_AGENT_OBSERVED: observed,
    FAKE_TCK_ARGS: recordedArgs,
    FAKE_TCK_REGISTRY: tckRegistry,
    FAKE_DESCENDANT_SCRIPT: descendantScript,
    FAKE_DESCENDANT_PID: descendantPid,
    FAKE_DECOY_PID: decoyPidFile,
    FAKE_TCK_CONFORMANT: 'true',
    FAKE_TCK_EXIT: '0'
  }
  return {
    root,
    bin,
    tckDir,
    reportDir,
    launchCwd,
    tmpRoot,
    observed,
    recordedArgs,
    descendantPid,
    lateLog,
    latePid,
    tckRegistry,
    decoyScript,
    decoyPidFile,
    sentinelHome,
    env
  }
}

type World = ReturnType<typeof fakeTckWorld>

const runRunner = (
  world: World,
  { env, args = [], timeout = 60_000 }: { env?: NodeJS.ProcessEnv; args?: string[]; timeout?: number } = {}
) =>
  spawnSync(process.execPath, [runner, ...args], {
    cwd: world.launchCwd,
    env: env ?? world.env,
    encoding: 'utf8',
    timeout
  })

const runnerErrors = (world: { reportDir: string }) =>
  readdirSync(world.reportDir).filter(name => name.includes('runner-error'))

const runnerErrorKinds = (world: World) =>
  runnerErrors(world).map(name => JSON.parse(readFileSync(join(world.reportDir, name), 'utf8')).kind)

const isPidAlive = (pid: number) => {
  // Pid 0/1 are never valid targets: kill(0) would hit the caller's own
  // process group and kill(-1) everything it may signal.
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const awaitPidDeath = async (pid: number, budgetMs = 15_000) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && isPidAlive(pid)) await new Promise(resolve => setTimeout(resolve, 50))
  return !isPidAlive(pid)
}

/**
 * Force-kills and awaits a fixture-owned pid recorded in a file; a missing or
 * unreadable file means the process never started, and an already-dead pid is
 * a no-op. Test `finally` blocks use this so a red assertion cannot leak the
 * processes the test owns.
 */
const killPidFileIfAlive = async (file: string) => {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      await awaitPidDeath(pid, 5_000)
    }
  } catch {
    /* the process never recorded its pid */
  }
}

/**
 * Bounded wait for a runner exit: a hanging (red) runner resolves to null
 * instead of stalling the test forever, and the timer is cleared on settle.
 */
const exitedWithin = async (observed: { exited: Promise<number | null> }, budgetMs: number) =>
  new Promise<number | null>(resolve => {
    const timer = setTimeout(() => resolve(null), budgetMs)
    observed.exited.then(
      status => {
        clearTimeout(timer)
        resolve(status)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })

/**
 * Spawns the runner for mid-run observation. Completion is observed via the
 * 'exit' event and the stdio streams are destroyed afterwards: a buggy runner
 * that leaks an owned descendant (the red state) leaves the inherited pipe
 * write ends open, and awaiting 'close'/EOF would hang exactly like the
 * production bug being tested.
 */
const spawnObservedRunner = (world: World, env: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, [runner], {
    cwd: world.launchCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', chunk => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', chunk => {
    stderr += chunk
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', status => resolve(status)))
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    exited,
    signal: (signal: NodeJS.Signals) => child.kill(signal),
    async finish() {
      const status = await exited
      child.stdout?.destroy()
      child.stderr?.destroy()
      return status
    },
    /** Force-kills this run's owned processes; a red runner must not leak them past the test. */
    async killOwned() {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      await killPidFileIfAlive(world.descendantPid)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  }
}

const assertScratchCleaned = (world: World) => {
  assert.deepEqual(
    readdirSync(world.tmpRoot).filter(name => name.startsWith('pi-acp-tck-')),
    [],
    'the runner must clean up its disposable root'
  )
}

test(
  'runner drives the pinned TCK with isolated credentials and a persistent report',
  { skip: isWindows ? 'fake shims and POSIX process groups are POSIX-only' : false },
  () => {
    const world = fakeTckWorld()
    try {
      const result = runRunner(world, { args: ['-k', 'diagnostics', '--timeout', '90'] })
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /ACP TCK v1 verdict: CONFORMANT/)
      assert.ok(result.stdout.includes(world.reportDir), 'the report path must be surfaced')
      assert.match(result.stdout, /do not commit it/, 'the transcript sensitivity warning must be printed')
      assert.deepEqual(runnerErrors(world), [], 'a conformant run writes no runner-error diagnostic')

      const args = JSON.parse(readFileSync(world.recordedArgs, 'utf8')) as string[]
      const value = (flag: string) => args[args.indexOf(flag) + 1]
      assert.equal(value('--project'), world.tckDir, 'uv must run the explicit checkout via --project')
      assert.ok(args.includes('run') && args.includes('--frozen') && args.includes('acp-tck'))
      assert.equal(value('--protocol-version'), '1')
      assert.ok(value('--cancel-prompt').includes('TCK_CANCEL_TURN'), 'the cancel prompt must be exercisable')
      assert.ok(
        value('--report-json').startsWith(join(world.reportDir, '')),
        'the report must be written to the persistent report dir, outside the disposable root'
      )
      assert.ok(
        value('--timeout') && value('--startup-timeout') && value('--test-timeout'),
        'time budgets must be bounded'
      )
      assert.ok(
        args.lastIndexOf('--timeout') > args.indexOf('--timeout') && args[args.lastIndexOf('--timeout') + 1] === '90',
        'an allowed passthrough timeout must override the runner default by coming later in argv'
      )
      assert.equal(value('-k'), 'diagnostics', 'allowed extra args must pass through to the TCK')
      assert.ok(!args.includes('--agent-env'), 'agent environment overlays stay runner-owned')
      assert.equal(
        args.filter(arg => arg === '--agent-cwd').length,
        1,
        'the single agent cwd comes from the runner, never from extra arguments'
      )
      const agentCommand = args.slice(args.indexOf('--') + 1)
      assert.equal(agentCommand[0], process.execPath, 'the agent must launch as node <bootstrap> <adapter>')
      assert.equal(
        realpathSync.native(agentCommand[1]),
        realpathSync.native(join(repoRoot, 'scripts', 'fixtures', 'acp-tck-agent-bootstrap.mjs')),
        'the agent root must launch through the owned registration bootstrap'
      )
      assert.equal(
        realpathSync.native(agentCommand[2]),
        realpathSync.native(join(world.launchCwd, 'dist', 'index.js')),
        'the bootstrap must run the absolute built adapter path'
      )

      const reports = readdirSync(world.reportDir).filter(name => name.endsWith('.json'))
      assert.equal(reports.length, 1, 'exactly the TCK report persists')
      const report = JSON.parse(readFileSync(join(world.reportDir, reports[0]), 'utf8'))
      assert.equal(report.verdict.conformant, true)

      const observed = JSON.parse(readFileSync(world.observed, 'utf8'))
      const disposable = join(world.tmpRoot, 'pi-acp-tck-')
      for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'PI_ACP_DIR', 'PI_CODING_AGENT_DIR', 'TMPDIR']) {
        assert.ok(
          (observed.env[key] ?? '').startsWith(disposable),
          `${key} must point into the disposable root, got ${observed.env[key]}`
        )
      }
      assert.ok(
        (observed.env.UV_PROJECT_ENVIRONMENT ?? '').startsWith(disposable),
        'the TCK venv must live in the disposable root so the checkout is never written to'
      )
      assert.ok(
        (observed.env.UV_CACHE_DIR ?? '').startsWith(disposable),
        'uv cache/interpreter state must be private to the run root, not a shared predictable path'
      )
      assert.ok(
        (observed.env.UV_PYTHON_INSTALL_DIR ?? '').startsWith(disposable),
        'the uv-managed interpreter must be private to the run root too'
      )
      assert.ok(
        (observed.env.PI_ACP_TCK_AGENT_REGISTRY ?? '').startsWith(disposable),
        'the agent registry must live in the disposable run root'
      )
      assert.equal(
        observed.env.PYTHONDONTWRITEBYTECODE,
        '1',
        'bytecode writes must be disabled to protect the checkout'
      )
      for (const key of [
        'PI_ACP_PI_COMMAND',
        'PI_ACP_REEXEC',
        'PI_ACP_WORKSPACE_ROOTS',
        'PI_CODING_AGENT_SESSION_DIR',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_BEARER_TOKEN_BEDROCK',
        'AWS_PROFILE',
        'AWS_CONFIG_FILE',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'SENTINEL_PASSWORD',
        'SENTINEL_TOKEN',
        'PYTEST_ADDOPTS',
        'PYTEST_PLUGINS',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'NODE_OPTIONS',
        'PI_MODEL',
        'PI_MANAGED_INSTALL_ROOT',
        'PI_PACKAGE_DIR',
        'PI_SESSION_FILE',
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE'
      ]) {
        assert.equal(observed.env[key], undefined, `${key} must be scrubbed from the agent environment`)
      }

      assert.equal(observed.settings.defaultProvider, 'acp-tck')
      assert.ok(
        observed.extension.includes("pi.registerProvider('acp-tck'"),
        'the deterministic provider must be installed in the disposable agent dir'
      )

      assert.equal(existsSync(observed.env.PI_CODING_AGENT_DIR), false, 'the disposable agent dir must be removed')
      assertScratchCleaned(world)
      assert.deepEqual(readdirSync(world.tckDir), ['marker.txt'], 'the pinned checkout must stay untouched')
      assert.deepEqual(readdirSync(world.sentinelHome), [], 'inherited user state must stay untouched')
    } finally {
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'a nonconformant TCK verdict propagates its exit code and persists the report',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const world = fakeTckWorld()
    try {
      const result = runRunner(world, {
        env: { ...world.env, FAKE_TCK_EXIT: '1', FAKE_TCK_CONFORMANT: 'false' }
      })
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /ACP TCK v1 verdict: NOT CONFORMANT/)
      const reports = readdirSync(world.reportDir).filter(name => name.endsWith('.json'))
      assert.equal(reports.length, 1, 'the nonconformant report must persist')
      const report = JSON.parse(readFileSync(join(world.reportDir, reports[0]), 'utf8'))
      assert.equal(report.verdict.conformant, false)
      assert.deepEqual(runnerErrors(world), [], 'a judged run is not a runner error')
      assertScratchCleaned(world)
    } finally {
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'only exit 0 with a conformant report or exit 1 with a nonconformant report is a verdict',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    for (const [name, exit, conformant] of [
      // The ambient-PYTEST_ADDOPTS=--collect-only shape: exit 0 with a report
      // that says NOT conformant, and every other exit/verdict combination.
      ['exit 0 with nonconformant report', '0', 'false'],
      ['exit 1 with conformant report', '1', 'true'],
      ['exit 4 with report', '4', 'false'],
      ['exit 5 with report', '5', 'true']
    ] as const) {
      const world = fakeTckWorld()
      try {
        const result = runRunner(world, {
          env: { ...world.env, FAKE_TCK_EXIT: exit, FAKE_TCK_CONFORMANT: conformant }
        })
        assert.equal(result.status, 3, `${name}: ${result.stdout}\n${result.stderr}`)
        assert.notEqual(result.status, 0, `${name}: exit 0 must be impossible without a conformant verdict`)
        assert.deepEqual(runnerErrorKinds(world), ['tck-inconsistent-verdict'], name)
        assertScratchCleaned(world)
      } finally {
        rmSync(world.root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'a missing or malformed TCK report is a runner error with a persistent diagnostic',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const reportVariants: Array<[string, Record<string, string>, string]> = [
      ['no report written', { FAKE_TCK_NO_REPORT: '1', FAKE_TCK_EXIT: '5' }, 'tck-no-report'],
      ['malformed report', { FAKE_TCK_MALFORMED: '1', FAKE_TCK_EXIT: '1' }, 'tck-report-invalid'],
      ['wrong protocol version', { FAKE_TCK_REPORT_VARIANT: 'no-protocol', FAKE_TCK_EXIT: '1' }, 'tck-report-invalid'],
      [
        'empty requirements evidence',
        { FAKE_TCK_REPORT_VARIANT: 'no-requirements', FAKE_TCK_EXIT: '1' },
        'tck-report-invalid'
      ],
      [
        'unrecognized requirement shape',
        { FAKE_TCK_REPORT_VARIANT: 'bad-requirement', FAKE_TCK_EXIT: '1' },
        'tck-report-invalid'
      ],
      ['non-numeric tier counts', { FAKE_TCK_REPORT_VARIANT: 'bad-verdict', FAKE_TCK_EXIT: '0' }, 'tck-report-invalid'],
      ['empty tier counts', { FAKE_TCK_REPORT_VARIANT: 'empty-counts', FAKE_TCK_EXIT: '1' }, 'tck-report-invalid']
    ]
    // Each tier is validated on its own: removing or corrupting exactly one
    // tier's counts at a time must fail validation for that tier.
    for (const tier of ['MANDATORY', 'CAPABILITY', 'ADVISORY', 'INFORMATIONAL']) {
      reportVariants.push(
        [
          `missing ${tier} tier counts`,
          { FAKE_TCK_REPORT_VARIANT: `missing-tier:${tier}`, FAKE_TCK_EXIT: '1' },
          'tck-report-invalid'
        ],
        [
          `negative ${tier} tier count`,
          { FAKE_TCK_REPORT_VARIANT: `negative-count:${tier}`, FAKE_TCK_EXIT: '1' },
          'tck-report-invalid'
        ]
      )
    }
    for (const [name, envAddition, kind] of reportVariants) {
      const world = fakeTckWorld()
      try {
        const result = runRunner(world, { env: { ...world.env, ...envAddition } })
        assert.equal(result.status, 3, `${name}: ${result.stdout}\n${result.stderr}`)
        assert.deepEqual(runnerErrorKinds(world), [kind], name)
        assertScratchCleaned(world)
      } finally {
        rmSync(world.root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'the summary surfaces unexercised cancellation, untested mandatory requirements and blockers',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const world = fakeTckWorld()
    try {
      const result = runRunner(world, {
        env: { ...world.env, FAKE_TCK_VARIANT: 'partial', FAKE_TCK_EXIT: '1' }
      })
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /26 MANDATORY requirements NOT_TESTED/, 'untested mandatory count must be surfaced')
      assert.match(result.stdout, /cancellation not exercised/, 'unexercised cancellation must be surfaced')
      assert.match(result.stdout, /blocked by auth/, 'auth blocking must be surfaced')
      assert.match(result.stdout, /blocked by version mismatch/, 'version blocking must be surfaced')
    } finally {
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'extra runner arguments are bounded to diagnostic selectors and timeouts',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const rejected: Array<[string[], RegExp]> = [
      [['--protocol-version', '2'], /protocol/i],
      [['--report-json', '/tmp/evil.json'], /report/i],
      [['--agent-env', 'HOME=/'], /agent-env/i],
      [['--agent-cwd', '/'], /agent-cwd/i],
      [['--allow-logout'], /allow-logout/],
      [['--cancel-prompt', 'x'], /cancel-prompt/],
      [['--'], /separator/],
      [['--', 'node', '/tmp/evil.js'], /separator/],
      [['--bogus'], /bogus/],
      [['-k'], /-k/],
      [['-k', '--evil'], /-k/],
      [['--timeout', '0'], /timeout/],
      [['--timeout', 'abc'], /timeout/],
      [['--timeout', '99999'], /timeout/]
    ]
    for (const [args, pattern] of rejected) {
      const world = fakeTckWorld()
      try {
        const result = runRunner(world, { args, timeout: 30_000 })
        assert.equal(result.status, 3, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, pattern, `${args.join(' ')} must be rejected with a clear reason`)
        assert.deepEqual(runnerErrorKinds(world), ['setup-error'], `${args.join(' ')} rejection is a setup error`)
        assertScratchCleaned(world)
      } finally {
        rmSync(world.root, { recursive: true, force: true })
      }
    }
    const allowed: Array<string[]> = [
      ['-v'],
      ['--verbose'],
      ['--timeout', '90'],
      ['--startup-timeout', '75'],
      ['--test-timeout', '240']
    ]
    for (const args of allowed) {
      const world = fakeTckWorld()
      try {
        const result = runRunner(world, { args, timeout: 30_000 })
        assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`)
        const recorded = JSON.parse(readFileSync(world.recordedArgs, 'utf8')) as string[]
        for (const arg of args) assert.ok(recorded.includes(arg), `${arg} must reach the TCK`)
        assertScratchCleaned(world)
      } finally {
        rmSync(world.root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'setup failures exit distinctly with a persistent runner-error diagnostic',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const cases: Array<{
      name: string
      env?: Record<string, string | undefined>
      prepare?: (world: World) => void
      cleanup?: (world: World) => void
      skip?: boolean
      kind?: string
      elapsedMs?: number
      match: RegExp
    }> = [
      {
        name: 'missing PI_ACP_TCK_DIR',
        env: { PI_ACP_TCK_DIR: '' },
        match: /PI_ACP_TCK_DIR/
      },
      {
        name: 'non-repository checkout',
        env: { FAKE_GIT_BROKEN: '1' },
        match: /checkout|git/
      },
      {
        name: 'wrong revision',
        env: { FAKE_GIT_REVISION: '0000000000000000000000000000000000000000' },
        match: new RegExp(pinnedRevision)
      },
      {
        name: 'dirty checkout',
        env: { FAKE_GIT_DIRTY: '1' },
        match: /clean/
      },
      {
        name: 'missing built adapter',
        prepare: world => rmSync(join(world.launchCwd, 'dist'), { recursive: true, force: true }),
        match: /npm run build/
      },
      {
        // PATH holds only the fake bin (with its node symlink), so a removed
        // uv genuinely cannot be found via an ambient installation.
        name: 'missing uv',
        prepare: world => rmSync(join(world.bin, 'uv')),
        match: /uv/
      },
      {
        name: 'missing pi',
        prepare: world => rmSync(join(world.bin, 'pi')),
        match: /pi/
      },
      {
        name: 'crashing pi probe',
        env: { FAKE_PI_CRASH: '1' },
        match: /pi/
      },
      {
        // A probe that would succeed, but only after the remaining budget:
        // the bounded probe must hard-kill it instead of waiting for its answer.
        name: 'delayed-success pi probe outside the budget',
        env: { FAKE_PI_DELAY: '2', PI_ACP_TCK_TIMEOUT_MS: '1500' },
        match: /did not answer within/,
        elapsedMs: 4500
      },
      {
        // A probe that ignores SIGTERM: only the hard killSignal bounds it, so
        // the kill must fire at the budget — not at the probe's own 5s expiry
        // — and the timeout message must stay the discriminating signal.
        name: 'SIGTERM-ignoring pi probe',
        env: { FAKE_PI_IGNORE_TERM: '1', PI_ACP_TCK_TIMEOUT_MS: '1500' },
        match: /did not answer within/,
        elapsedMs: 4500
      },
      {
        name: 'unsupported pi version',
        env: { FAKE_PI_VERSION: 'pi 1.0.0' },
        match: /1\.2\.0/
      },
      {
        name: 'invalid budget: not a number',
        env: { PI_ACP_TCK_TIMEOUT_MS: 'abc' },
        match: /PI_ACP_TCK_TIMEOUT_MS/
      },
      {
        name: 'invalid budget: negative',
        env: { PI_ACP_TCK_TIMEOUT_MS: '-5' },
        match: /PI_ACP_TCK_TIMEOUT_MS/
      },
      {
        name: 'invalid budget: overflowing the timer range',
        env: { PI_ACP_TCK_TIMEOUT_MS: '99999999999999' },
        match: /PI_ACP_TCK_TIMEOUT_MS/
      },
      {
        // chmod-based write protection is not meaningful for root.
        name: 'unwritable report directory',
        skip: isRoot,
        prepare: world => chmodSync(world.reportDir, 0o555),
        cleanup: world => chmodSync(world.reportDir, 0o755),
        match: /report/
      },
      {
        name: 'report directory path is an existing regular file',
        prepare: world => {
          rmSync(world.reportDir, { recursive: true, force: true })
          writeFileSync(world.reportDir, 'not a directory')
        },
        match: /report/
      },
      {
        name: 'unusable TMPDIR',
        env: { TMPDIR: '/nonexistent-tck-tmp/nested' },
        kind: 'runner-error',
        match: /TMPDIR|mkdtemp|temporary|runner error/
      }
    ]
    for (const testCase of cases) {
      if (testCase.skip) continue
      const world = fakeTckWorld()
      try {
        testCase.prepare?.(world)
        const started = Date.now()
        const result = runRunner(world, {
          env: { ...world.env, ...(testCase.env ?? {}) },
          timeout: 30_000
        })
        assert.equal(result.error, undefined, String(result.error))
        assert.equal(result.status, 3, `${testCase.name}: expected setup exit 3\n${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, testCase.match, testCase.name)
        if (testCase.elapsedMs !== undefined)
          assert.ok(
            Date.now() - started < testCase.elapsedMs,
            `${testCase.name}: expected the hard-killed probe run to settle in under ${testCase.elapsedMs}ms, took ${
              Date.now() - started
            }ms`
          )
        if (
          !['unwritable report directory', 'report directory path is an existing regular file'].includes(testCase.name)
        ) {
          const errors = runnerErrors(world)
          assert.equal(errors.length, 1, `${testCase.name}: a persistent runner-error diagnostic must be written`)
          const error = JSON.parse(readFileSync(join(world.reportDir, errors[0]), 'utf8'))
          assert.equal(error.kind, testCase.kind ?? 'setup-error')
          assert.match(error.message, testCase.match)
          assert.equal(error.tckRevision, pinnedRevision)
        } else {
          assert.match(result.stderr, /could not write the runner diagnostic/, testCase.name)
        }
      } finally {
        testCase.cleanup?.(world)
        rmSync(world.root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE overrides cannot redirect the pin and clean probes',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const world = fakeTckWorld()
    try {
      // world.env carries the ambient trio pointing at a valid-looking pinned
      // repository while the actual PI_ACP_TCK_DIR checkout is unpinned: a
      // retained override would make the git probes answer for the redirect
      // and run the unchecked directory green instead of exiting 3.
      const result = runRunner(world, {
        env: { ...world.env, FAKE_GIT_REVISION: '0000000000000000000000000000000000000000' },
        timeout: 30_000
      })
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(
        result.status,
        3,
        `the pin probes must judge PI_ACP_TCK_DIR itself, not the ambient redirect: ${result.stdout}\n${result.stderr}`
      )
      assert.match(result.stderr, new RegExp(pinnedRevision), 'the unpinned checkout must be rejected by revision')
      assert.deepEqual(runnerErrorKinds(world), ['setup-error'])
      assertScratchCleaned(world)
    } finally {
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

/** An unrelated live process the runner must never signal: it registers its pid for the test to observe. */
const spawnDecoy = (world: World) => {
  const decoy = spawn(process.execPath, [world.decoyScript], {
    env: { ...world.env, FAKE_DECOY_PID: world.decoyPidFile },
    stdio: 'ignore'
  })
  return {
    pid: () => {
      if (decoy.pid === undefined) throw new Error('decoy failed to start')
      return decoy.pid
    },
    async started() {
      const deadline = Date.now() + 15_000
      while (!existsSync(world.decoyPidFile) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(existsSync(world.decoyPidFile), 'the decoy must be running before the regression starts')
    },
    async alive() {
      const pid = Number(readFileSync(world.decoyPidFile, 'utf8'))
      return isPidAlive(pid)
    },
    kill() {
      decoy.kill('SIGKILL')
    }
  }
}

test(
  'a watchdog timeout tears down a separately-sessioned SIGTERM-ignoring owned descendant',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    const world = fakeTckWorld()
    const observed = spawnObservedRunner(world, {
      ...world.env,
      FAKE_TCK_HANG: '1',
      FAKE_TCK_DESCENDANT: '1',
      PI_ACP_TCK_TIMEOUT_MS: '3000'
    })
    try {
      const deadline = Date.now() + 20_000
      while (!existsSync(world.descendantPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(existsSync(world.descendantPid), 'the owned descendant must start before the watchdog fires')
      const status = await observed.finish()
      assert.equal(status, 3, `runner must exit 3 on the global budget: ${observed.stderr()}`)
      assert.match(observed.stderr(), /global time budget/)
      assert.deepEqual(runnerErrorKinds(world), ['runner-timeout'])
      const descendantPid = Number(readFileSync(world.descendantPid, 'utf8'))
      assert.ok(Number.isInteger(descendantPid), 'the descendant must have started')
      assert.ok(await awaitPidDeath(descendantPid), 'the separately-sessioned descendant must be torn down')
      assertScratchCleaned(world)
    } finally {
      await observed.killOwned()
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'an external SIGTERM is forwarded through the same owned teardown and cleanup',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    const world = fakeTckWorld()
    const observed = spawnObservedRunner(world, {
      ...world.env,
      FAKE_TCK_HANG: '1',
      FAKE_TCK_DESCENDANT: '1',
      PI_ACP_TCK_TIMEOUT_MS: '300000'
    })
    try {
      const deadline = Date.now() + 20_000
      while (!existsSync(world.descendantPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(existsSync(world.descendantPid), 'the owned descendant must have started before signaling')
      observed.signal('SIGTERM')
      const status = await observed.finish()
      assert.equal(status, 3, `runner must exit through cleanup: ${observed.stderr()}`)
      assert.match(observed.stderr(), /SIGTERM/)
      assert.deepEqual(runnerErrorKinds(world), ['runner-terminated'])
      const descendantPid = Number(readFileSync(world.descendantPid, 'utf8'))
      assert.ok(await awaitPidDeath(descendantPid), 'the descendant must be torn down by the forwarded signal')
      assertScratchCleaned(world)
    } finally {
      await observed.killOwned()
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'pid-file cleanup guards never act on empty, invalid or unsafe pids',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    if (process.env.FAKE_PID_GUARD_INNER === '1') {
      // The real negative control, running inside a disposable detached process
      // group: with the pid>1 guard every input below is a pure no-op. A
      // regressed guard would kill(0) only this inner group (never the outer
      // suite or anything else).
      const root = process.env.FAKE_PID_GUARD_ROOT!
      const files = [join(root, 'empty.pid'), join(root, 'zero.pid'), join(root, 'one.pid'), join(root, 'garbage.pid')]
      writeFileSync(files[0], '')
      writeFileSync(files[1], '0')
      writeFileSync(files[2], '1')
      writeFileSync(files[3], 'not-a-pid')
      for (const file of files) await killPidFileIfAlive(file)
      assert.ok(isPidAlive(process.pid), 'no pid-file input may ever signal the caller')
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-tck-pidguard-'))
    const innerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_PID_GUARD_INNER: '1',
      FAKE_PID_GUARD_ROOT: root
    }
    // The test runner marks its file children (NODE_TEST_CONTEXT); the inner
    // must be a fresh supervisor run — inheriting the marker makes node:test
    // detect recursion and silently skip running the file.
    delete innerEnv.NODE_TEST_CONTEXT
    delete innerEnv.NODE_TEST_WORKER_ID
    const inner = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-name-pattern',
        'pid-file cleanup guards never act',
        join(repoRoot, 'test', 'unit', 'acp-tck.test.ts')
      ],
      {
        cwd: repoRoot,
        env: innerEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    inner.stdout?.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
    })
    inner.stderr?.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    const exited = new Promise<number | null>(resolve =>
      inner.on('exit', (code, signal) => resolve(signal ? null : code))
    )
    try {
      const status = await exitedWithin({ exited }, 30_000)
      assert.equal(
        status,
        0,
        'the inner negative control must pass without any kill action ' +
          `(empty/zero/one/garbage pid files are no-ops): ${stderr.slice(-2000)}`
      )
      assert.match(stdout, /pass 1/, 'the inner must actually run the negative control, not exit with zero tests')
    } finally {
      if (inner.exitCode === null && inner.pid) {
        try {
          process.kill(-inner.pid, 'SIGKILL')
        } catch {
          try {
            inner.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'the bootstrap imports the adapter from a path with URL-significant characters',
  { skip: isWindows ? 'POSIX-only fake shims' : false },
  () => {
    const world = fakeTckWorld({ launchDirName: 'launch#dir?with%20chars' })
    try {
      const result = runRunner(world, {})
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(result.status, 0, `the run must stay a verdict: ${result.stdout}\n${result.stderr}`)
      assert.ok(existsSync(world.observed), 'the adapter sentinel must prove the special-character import ran')
      const observed = JSON.parse(readFileSync(world.observed, 'utf8'))
      assert.equal(
        realpathSync.native(observed.argv[1]),
        realpathSync.native(join(world.launchCwd, 'dist', 'index.js')),
        'the imported adapter must be the exact special-character path'
      )
      assertScratchCleaned(world)
    } finally {
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'a registration whose entry is removed before the post-check fails closed',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    const world = fakeTckWorld()
    const registryDir = join(world.root, 'registry')
    const barrier = join(world.root, 'post-write.barrier')
    mkdirSync(registryDir)
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'scripts', 'fixtures', 'acp-tck-agent-bootstrap.mjs'), join(world.launchCwd, 'dist', 'index.js')],
      {
        env: {
          ...world.env,
          PI_ACP_TCK_AGENT_REGISTRY: registryDir,
          PI_ACP_TCK_TEST_POST_WRITE_BARRIER: barrier
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    const exited = new Promise<number | null>(resolve => child.on('exit', status => resolve(status)))
    try {
      const entry = join(registryDir, `${child.pid}.json`)
      const deadline = Date.now() + 15_000
      while (!existsSync(entry) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(existsSync(entry), 'the bootstrap must register before the removal')
      // Simulated teardown crossing the registration: the entry is removed
      // between the registration write and the post-registration check.
      rmSync(entry)
      writeFileSync(barrier, 'released')
      assert.equal(await exited, 3, `a removed registration must fail closed: ${stderr}`)
      assert.match(stderr, /shutdown began during registration/, 'the refusal must name the crossed registration')
      assert.ok(!existsSync(world.observed), 'the adapter sentinel must not run after a crossed registration')
    } finally {
      writeFileSync(barrier, 'released')
      if (child.exitCode === null) child.kill('SIGKILL')
      await exited
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'a late agent start after the shutdown seal never runs the adapter or recreates the run state',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    const world = fakeTckWorld()
    const observed = spawnObservedRunner(world, {
      ...world.env,
      FAKE_TCK_HANG: '1',
      FAKE_TCK_DESCENDANT: '1',
      FAKE_TCK_LATE_START: '1',
      FAKE_TCK_LATE_LOG: world.lateLog,
      FAKE_TCK_LATE_PID: world.latePid,
      PI_ACP_TCK_TIMEOUT_MS: '3000'
    })
    try {
      const status = await observed.finish()
      assert.equal(status, 3, `the watchdog must bound the hanging run: ${observed.stderr()}`)
      assert.match(observed.stderr(), /global time budget/)
      assert.deepEqual(runnerErrorKinds(world), ['runner-timeout'])
      const lateLog = readFileSync(world.lateLog, 'utf8')
      assert.match(lateLog, /begun shutdown/, 'the late bootstrap must refuse through the teardown seal, not race it')
      assert.ok(!existsSync(world.observed), 'the adapter sentinel must not run for a late-started agent')
      const registryDir = readFileSync(world.tckRegistry, 'utf8')
      assert.equal(existsSync(registryDir), false, 'the run registry must be gone with the disposable root')
      const direct = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts', 'fixtures', 'acp-tck-agent-bootstrap.mjs'),
          join(world.launchCwd, 'dist', 'index.js')
        ],
        { env: { ...world.env, PI_ACP_TCK_AGENT_REGISTRY: registryDir }, encoding: 'utf8', timeout: 15_000 }
      )
      assert.equal(direct.status, 3, `a post-cleanup bootstrap must fail closed: ${direct.stderr}`)
      assert.match(direct.stderr, /registry/, 'the refusal must name the missing registry')
      assert.equal(existsSync(registryDir), false, 'the bootstrap must not recreate the removed run registry')
      assert.ok(!existsSync(world.observed), 'the adapter sentinel must still not have run')
      assertScratchCleaned(world)
    } finally {
      await observed.killOwned()
      await killPidFileIfAlive(world.latePid)
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)

test(
  'a fast uv exit still tears down the registered agent root and never signals a decoy',
  { skip: isWindows ? 'POSIX-only process groups' : false },
  async () => {
    const world = fakeTckWorld()
    const decoy = spawnDecoy(world)
    try {
      await decoy.started()
      // The parent's reproduced orphan shape: the fake uv spawns a separately
      // sessioned agent root, finishes normally and exits 0 without waiting
      // for it; the bogus registry entries carry a reused/dead pid shape.
      const result = runRunner(world, {
        env: {
          ...world.env,
          FAKE_TCK_DESCENDANT: '1',
          FAKE_BOGUS_REGISTRY: '1',
          PI_ACP_TCK_TIMEOUT_MS: '120000'
        },
        timeout: 60_000
      })
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(result.status, 0, `the conformant verdict must be preserved: ${result.stdout}\n${result.stderr}`)
      const descendantPid = Number(readFileSync(world.descendantPid, 'utf8'))
      assert.ok(Number.isInteger(descendantPid), 'the separately-sessioned agent root must have started')
      assert.ok(
        await awaitPidDeath(descendantPid),
        'the registered agent root must be torn down despite the fast uv exit'
      )
      assert.ok(await decoy.alive(), 'the unrelated decoy with a mismatched identity must never be signaled')
      assert.match(result.stderr, /identity|reuse|not signaled/, 'unverifiable identities must be surfaced, not silent')
      assertScratchCleaned(world)
    } finally {
      await killPidFileIfAlive(world.descendantPid)
      decoy.kill()
      rmSync(world.root, { recursive: true, force: true })
    }
  }
)
