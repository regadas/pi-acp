// Reproducible ACP v1 compatibility check: runs the pinned upstream acp-tck
// (https://github.com/agentclientprotocol/acp-tck) against the built adapter
// and the installed pi, with a disposable user/workspace state and a
// deterministic local provider extension (no provider network, no child
// agents). TCK conformance findings stay visible in the exit code and the
// persistent JSON report. In CI the diagnostics step is verdict-tolerant —
// exits 0 (conformant) and 1 (non-conformant) are recorded findings — while
// every other exit re-raises and fails the job; the step runs this runner
// directly after a separate build step, so build/launcher failures never
// pass through the verdict filter. Exit codes: 0/1 are verdicts, accepted
// only for the exact pairs exit 0 + conformant report or exit 1 +
// non-conformant report; 3 distinguishes every runner/setup error (bad
// checkout, missing prerequisites, watchdog timeout, missing/invalid/
// inconsistent report, or any unexpected failure), each with a best-effort
// persistent diagnostic.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { withIsolation, isolatedEnv } from './isolated-env.mjs'
import { processIdentity, SHUTDOWN_SEAL } from './fixtures/acp-tck-agent-bootstrap.mjs'

const TCK_REVISION = '3d46e2168aa3c23fe3853d539141a65a54d6a880'
const TCK_REPOSITORY = 'https://github.com/agentclientprotocol/acp-tck'
const CANCEL_PROMPT =
  'TCK_CANCEL_TURN: Write a very long, multi-chapter essay about the history of protocol design. The client will cancel this turn before you finish.'
const SETUP_EXIT = 3
const DEFAULT_RUN_BUDGET_MS = 20 * 60_000
const MAX_TIMER_MS = 2_147_483_000
const PROBE_TIMEOUT_MS = 10_000
const RESPONSE_TIMEOUT_S = 45
const STARTUP_TIMEOUT_S = 60
const TEST_TIMEOUT_S = 180
const KILL_GRACE_MS = 5_000
const HARD_KILL_WAIT_MS = 5_000

class SetupError extends Error {}

const reportDir = resolve(process.env.PI_ACP_TCK_REPORT_DIR ?? join(tmpdir(), 'pi-acp-tck-reports'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const reportPath = join(reportDir, `acp-tck-${stamp}.json`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Best-effort persistent diagnostics; a failure to write is surfaced on stderr, never thrown. */
const writeRunnerError = async (kind, message) => {
  const path = join(reportDir, `acp-tck-${stamp}-runner-error.json`)
  try {
    await mkdir(reportDir, { recursive: true })
    await writeFile(path, JSON.stringify({ kind, message, tckRevision: TCK_REVISION }, null, 2) + '\n')
    console.error(`[pi-acp-tck] runner diagnostic written to ${path}`)
  } catch (error) {
    console.error(`[pi-acp-tck] could not write the runner diagnostic to ${path}: ${error.message}`)
  }
}

/**
 * Extra argv may only carry small diagnostic selectors and bounded timeout
 * overrides; everything else (protocol/report/agent/checkout options, logout,
 * and the command separator) stays runner-owned so the pinned v1/report
 * identity and the isolation contract cannot be rewritten from the outside.
 */
const PASSTHROUGH_FLAGS = new Set(['-v', '--verbose'])
const PASSTHROUGH_VALUED = new Set(['-k', '--timeout', '--startup-timeout', '--test-timeout'])
const PASSTHROUGH_TIMEOUT_MAX_S = 3600

const parsePassthrough = argv => {
  const out = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (PASSTHROUGH_FLAGS.has(arg)) {
      out.push(arg)
      continue
    }
    if (!PASSTHROUGH_VALUED.has(arg))
      throw new SetupError(
        arg === '--'
          ? 'the TCK command separator -- is not accepted in extra arguments; the agent command stays runner-owned'
          : `Unsupported TCK argument ${arg}: only ${[...PASSTHROUGH_VALUED].join(', ')} and -v are accepted; ` +
              'protocol, report, agent, checkout and logout options stay runner-owned'
      )
    const value = argv[++index]
    if (value === undefined || value.startsWith('-'))
      throw new SetupError(`${arg} requires a value that does not start with '-'`)
    if (arg !== '-k') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > PASSTHROUGH_TIMEOUT_MAX_S)
        throw new SetupError(`${arg} requires a positive number of seconds (at most ${PASSTHROUGH_TIMEOUT_MAX_S})`)
    }
    out.push(arg, value)
  }
  return out
}

const validateBudget = raw => {
  const budget = Number(raw ?? DEFAULT_RUN_BUDGET_MS)
  if (!Number.isFinite(budget) || budget <= 0 || budget > MAX_TIMER_MS)
    throw new SetupError(
      `Invalid PI_ACP_TCK_TIMEOUT_MS: ${raw} (must be a positive number of milliseconds not exceeding ${MAX_TIMER_MS})`
    )
  return budget
}

/** Ambient provider credentials, pytest/Python/node runtime injection, and every ambient PI_* override are dropped. */
const PROVIDER_NAMESPACES = [
  'AWS_',
  'GOOGLE_',
  'GCP_',
  'AZURE_',
  'ANTHROPIC_',
  'OPENAI_',
  'GEMINI_',
  'MISTRAL_',
  'GROQ_',
  'XAI_',
  'DEEPSEEK_',
  'COHERE_',
  'TOGETHER_',
  'FIREWORKS_',
  'HF_',
  'HUGGINGFACE_',
  'VERTEX_',
  'BEDROCK_'
]
const CREDENTIAL_SUFFIX = /(^|_)(API_?KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSCODES?|CREDENTIALS?|KEY_?FILES?|AUTH)$/i
const RUNTIME_INJECTION_KEYS = [
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONEXECUTABLE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_COMPILE_CACHE'
]
// Ambient repo-selection overrides would redirect the pin/clean git probes
// away from PI_ACP_TCK_DIR while uv still runs that unchecked directory.
const GIT_REPO_SELECTION_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']

const withoutUntrustedOverrides = env => {
  const scrubbed = {}
  for (const [key, value] of Object.entries(env)) {
    // Ambient PI_* keys (PI_MODEL, PI_MANAGED_INSTALL_ROOT, PI_PACKAGE_DIR, ...)
    // redirect pi itself; the run only gets the dirs isolatedEnv sets plus the
    // runner's own registry variable.
    if (key.startsWith('PI_')) continue
    // Ambient pytest customization (e.g. PYTEST_ADDOPTS=--collect-only) can
    // silently empty the suite while still exiting 0.
    if (key.startsWith('PYTEST_')) continue
    if (GIT_REPO_SELECTION_KEYS.includes(key)) continue
    if (PROVIDER_NAMESPACES.some(namespace => key.startsWith(namespace))) continue
    if (CREDENTIAL_SUFFIX.test(key)) continue
    if (RUNTIME_INJECTION_KEYS.includes(key)) continue
    scrubbed[key] = value
  }
  return scrubbed
}

const probeEnv = withoutUntrustedOverrides(process.env)

/**
 * Bounded prerequisite probe. Every probe runs as a plain synchronous child
 * capped by the remaining global budget, so a hung or signal-trapping probe
 * cannot stall the runner: its own timeout hard-kills it at the shorter of
 * the per-probe limit or that budget. Probes are not detached — external
 * signals reach them and their children naturally — and a probe that leaks
 * children is no longer force-killed by the runner.
 */
const runProbe = (command, args, { remaining, describe }) => {
  if (remaining() <= 0)
    throw new SetupError(
      'the global time budget was exhausted during setup; raise PI_ACP_TCK_TIMEOUT_MS or fix the slow environment'
    )
  const bound = Math.max(1, Math.min(PROBE_TIMEOUT_MS, remaining()))
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: bound, killSignal: 'SIGKILL', env: probeEnv })
  if (result.error?.code === 'ENOENT')
    throw new SetupError(`${command} not found on PATH${command === 'pi' ? '; pi >= 1.2.0 is required' : ''}`)
  if (result.error || result.signal || result.status !== 0)
    throw new SetupError(
      `${describe} did not answer within ${bound}ms of the remaining budget: ${
        (result.stderr || result.stdout || result.error?.message || 'no output').trim() || 'no output'
      }`
    )
  return result.stdout.trim()
}

const checkSetup = remaining => {
  const tckDir = process.env.PI_ACP_TCK_DIR
  if (!tckDir)
    throw new SetupError(`Set PI_ACP_TCK_DIR to a clean checkout of ${TCK_REPOSITORY} at revision ${TCK_REVISION}`)
  if (!existsSync(tckDir)) throw new SetupError(`PI_ACP_TCK_DIR does not exist: ${tckDir}`)
  const gitArgs = ['-C', tckDir]
  const head = runProbe('git', [...gitArgs, 'rev-parse', 'HEAD'], { remaining, describe: 'git rev-parse' })
  if (head !== TCK_REVISION) throw new SetupError(`acp-tck checkout must be at revision ${TCK_REVISION}, found ${head}`)
  const status = runProbe('git', [...gitArgs, 'status', '--porcelain'], { remaining, describe: 'git status' })
  if (status !== '') throw new SetupError(`acp-tck checkout must be clean, found:\n${status}`)
  const adapter = resolve('dist/index.js')
  if (!existsSync(adapter)) throw new SetupError(`Built adapter not found at ${adapter}; run npm run build first`)
  runProbe('uv', ['--version'], { remaining, describe: 'uv --version' })
  const versionOutput = runProbe('pi', ['--version'], { remaining, describe: 'pi --version' })
  const version = String(versionOutput).match(/(\d+)\.(\d+)/)
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0]
  if (major < 1 || (major === 1 && minor < 2))
    throw new SetupError(`pi >= 1.2.0 is required, found ${String(versionOutput).trim()}`)
  return { tckDir, adapter, passthrough: parsePassthrough(process.argv.slice(2)) }
}

const summarizeReport = async () => {
  try {
    return JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Minimal pinned report validation: no schema framework, just the shapes the
 * runner's verdict, summary and exit consistency actually rely on.
 */
const REPORT_TIERS = new Set(['MANDATORY', 'CAPABILITY', 'ADVISORY', 'INFORMATIONAL'])
const REPORT_STATUSES = new Set(['PASS', 'FAIL', 'SKIPPED', 'NOT_TESTED'])

const validateTckReport = report => {
  if (!report || typeof report !== 'object') return 'the report is not a JSON object'
  if (report.protocol_version !== 1) return `protocol_version ${report.protocol_version} is not 1`
  if (!Array.isArray(report.requirements) || report.requirements.length === 0)
    return 'requirements must be a nonempty array with per-requirement evidence'
  for (const requirement of report.requirements) {
    if (!requirement || typeof requirement !== 'object' || typeof requirement.id !== 'string')
      return 'a requirement entry has no string id'
    if (!REPORT_TIERS.has(requirement.tier) || !REPORT_STATUSES.has(requirement.status))
      return `requirement ${requirement.id} carries an unrecognized tier/status`
    if (!Array.isArray(requirement.tests)) return `requirement ${requirement.id} has no tests array`
  }
  const verdict = report.verdict
  if (!verdict || typeof verdict !== 'object' || typeof verdict.conformant !== 'boolean')
    return 'verdict.conformant must be a boolean'
  if (!verdict.tier_counts || typeof verdict.tier_counts !== 'object' || Array.isArray(verdict.tier_counts))
    return 'verdict.tier_counts must be an object'
  for (const tier of Object.keys(verdict.tier_counts)) {
    if (!REPORT_TIERS.has(tier)) return `verdict.tier_counts.${tier} is not a recognized tier`
  }
  // All four pinned tiers are required: an empty or short-handed table would
  // otherwise validate and imply coverage the report never states.
  for (const tier of REPORT_TIERS) {
    const counts = verdict.tier_counts[tier]
    if (!counts || typeof counts !== 'object' || Array.isArray(counts))
      return `verdict.tier_counts.${tier} is missing or invalid`
    for (const key of ['PASS', 'FAIL', 'SKIPPED', 'NOT_TESTED']) {
      const value = counts[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        return `verdict.tier_counts.${tier}.${key} must be a nonnegative integer`
    }
  }
  return null
}

const readTckReport = async () => {
  if (!existsSync(reportPath)) return { error: 'tck-no-report', reason: null, report: null }
  const report = await summarizeReport()
  const reason = validateTckReport(report)
  if (reason) return { error: 'tck-report-invalid', reason, report: null }
  return { error: null, reason: null, report }
}

const printSummary = report => {
  const verdict = report.verdict
  console.log(`ACP TCK v1 verdict: ${verdict.conformant ? 'CONFORMANT' : 'NOT CONFORMANT'}`)
  for (const [tier, counts] of Object.entries(verdict.tier_counts))
    console.log(
      `  ${tier}  PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED} NOT_TESTED=${counts.NOT_TESTED}`
    )
  const failing = report.requirements.filter(requirement => requirement.status === 'FAIL')
  const verdictFailing = failing.filter(
    requirement => requirement.tier !== 'ADVISORY' && requirement.tier !== 'INFORMATIONAL'
  )
  if (verdictFailing.length)
    console.log(`  verdict-affecting failures: ${verdictFailing.map(requirement => requirement.id).join(', ')}`)
  const notTested = verdict.tier_counts.MANDATORY?.NOT_TESTED ?? 0
  if (notTested) console.log(`  coverage: ${notTested} MANDATORY requirements NOT_TESTED — the run is incomplete`)
  const cancellation = report.requirements.filter(
    requirement => requirement.id === 'ACP-CANCEL-001' || requirement.id === 'ACP-CANCEL-002'
  )
  const notExercised = cancellation.filter(requirement => requirement.status !== 'PASS')
  if (notExercised.length)
    console.log(`  coverage: cancellation not exercised (${notExercised.map(r => `${r.id}=${r.status}`).join(', ')})`)
  if (verdict.blocked_by_auth)
    console.log('  blocked by auth: session-dependent requirements were skipped (no --auth-method)')
  if (verdict.blocked_by_version_mismatch)
    console.log('  blocked by version mismatch: the agent never negotiated protocol version 1')
}

/**
 * Bounded graceful-then-hard teardown of everything this run owns. uv is
 * group-signaled only while its live handle (exitCode and signalCode both
 * null) proves the pid is still ours. TCK agents are launched through the
 * registration bootstrap, so their separately-sessioned roots are read from
 * the run-private registry; each entry's identity (pid + OS start
 * fingerprint) is revalidated before any signal, so an exited, reused or
 * unverifiable identity is never signaled. POSIX is exercised by the unit
 * tests; the Windows taskkill path is a best-effort equivalent that is not
 * tested here (the CI TCK job runs on Linux).
 */
const teardownOwnedProcesses = async ({ child, registryDir }) => {
  // The shutdown seal, written before the final teardown scan: any bootstrap
  // that starts — or has just registered — refuses to import the adapter, so
  // a late agent cannot race cleanup. A registry that cannot be sealed (it
  // should exist: the runner created it) is surfaced instead of silently
  // claiming full ownership of cleanup.
  try {
    await writeFile(join(registryDir, SHUTDOWN_SEAL), `${process.pid} ${new Date().toISOString()}\n`)
  } catch (error) {
    console.error(`[pi-acp-tck] warning: cannot seal the run registry at ${registryDir}: ${error.message}`)
  }
  if (process.platform === 'win32') {
    if (child && child.pid && child.exitCode === null && child.signalCode === null)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: PROBE_TIMEOUT_MS })
    return
  }
  const uvLive = () => Boolean(child && child.pid && child.exitCode === null && child.signalCode === null)
  const registeredAgents = async () => {
    const actions = []
    let names
    try {
      names = await readdir(registryDir)
    } catch {
      return actions // no registry or unreadable: nothing is provably owned
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let entry
      try {
        entry = JSON.parse(await readFile(join(registryDir, name), 'utf8'))
      } catch {
        continue
      }
      // Pid 0/1 are never safe signal targets: kill(0) is the caller's own
      // process group and kill(-1) everything the caller may signal.
      if (!Number.isInteger(entry?.pid) || entry?.pid <= 1 || typeof entry?.fingerprint !== 'string') continue
      const identity = processIdentity(entry.pid)
      if (identity.state === 'gone') continue // the agent exited: retire the entry
      if (identity.state === 'unknown' || identity.fingerprint !== entry.fingerprint) {
        actions.push({ pid: entry.pid, action: 'skip' })
        continue
      }
      actions.push({ pid: entry.pid, action: 'kill' })
    }
    return actions
  }
  const stopAgents = async signal => {
    for (const action of await registeredAgents()) {
      if (action.action !== 'kill') continue
      try {
        // The session the TCK gave the agent: its root plus the pi children.
        process.kill(-action.pid, signal)
      } catch {
        try {
          process.kill(action.pid, signal)
        } catch {
          /* raced with its own exit */
        }
      }
    }
  }
  const stopUv = signal => {
    if (uvLive()) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* uv's group is already gone */
      }
    }
  }
  const anyAlive = async () => uvLive() || (await registeredAgents()).some(action => action.action === 'kill')
  stopUv('SIGTERM')
  await stopAgents('SIGTERM')
  let deadline = Date.now() + KILL_GRACE_MS
  while (Date.now() < deadline && (await anyAlive())) await sleep(50)
  if (await anyAlive()) {
    stopUv('SIGKILL')
    await stopAgents('SIGKILL')
    deadline = Date.now() + HARD_KILL_WAIT_MS
    while (Date.now() < deadline && (await anyAlive())) await sleep(50)
  }
  const finalActions = await registeredAgents()
  const unverifiable = finalActions.filter(action => action.action === 'skip')
  if (unverifiable.length)
    console.error(
      `[pi-acp-tck] warning: owned agent identities could not be verified (pid reuse or unavailable ps); not signaled: ${unverifiable.map(action => action.pid).join(', ')}`
    )
  const survivors = [
    ...(uvLive() ? [child.pid] : []),
    ...finalActions.filter(action => action.action === 'kill').map(action => action.pid)
  ]
  if (survivors.length)
    console.error(`[pi-acp-tck] warning: owned processes survived teardown: ${survivors.join(', ')}`)
}

const runTck = async ({ tckDir, adapter, passthrough, deadline }) =>
  withIsolation('pi-acp-tck-', async dirs => {
    const registryDir = join(dirs.root, 'agent-registry')
    try {
      await mkdir(join(dirs.agentDir, 'extensions'), { recursive: true })
      await mkdir(join(dirs.root, 'tmp'))
      await mkdir(registryDir, { recursive: true })
      await writeFile(
        join(dirs.agentDir, 'settings.json'),
        JSON.stringify({ defaultProvider: 'acp-tck', defaultModel: 'local' })
      )
      await writeFile(
        join(dirs.agentDir, 'extensions', 'acp-tck-extension.ts'),
        await readFile(new URL('./fixtures/acp-tck-extension.ts', import.meta.url))
      )
    } catch (error) {
      throw new SetupError(`failed to prepare the disposable TCK state: ${error.message}`)
    }
    // All uv state is private to this run root: a shared predictable cache
    // path would be unsafe on multi-user machines, and UV_PROJECT_ENVIRONMENT
    // keeps the pinned checkout itself unwritten.
    const env = {
      ...isolatedEnv(withoutUntrustedOverrides(process.env), dirs),
      TMPDIR: join(dirs.root, 'tmp'),
      TMP: join(dirs.root, 'tmp'),
      TEMP: join(dirs.root, 'tmp'),
      UV_CACHE_DIR: join(dirs.root, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(dirs.root, 'uv-python'),
      UV_PROJECT_ENVIRONMENT: join(dirs.root, 'tck-venv'),
      // The TCK imports its package straight from the checkout; without this
      // Python leaves __pycache__ directories there.
      PYTHONDONTWRITEBYTECODE: '1',
      // Read by the agent bootstrap so each TCK agent registers before it runs.
      PI_ACP_TCK_AGENT_REGISTRY: registryDir
    }
    const bootstrap = fileURLToPath(new URL('./fixtures/acp-tck-agent-bootstrap.mjs', import.meta.url))
    const args = [
      '--project',
      tckDir,
      'run',
      '--frozen',
      'acp-tck',
      '--protocol-version',
      '1',
      '--timeout',
      String(RESPONSE_TIMEOUT_S),
      '--startup-timeout',
      String(STARTUP_TIMEOUT_S),
      '--test-timeout',
      String(TEST_TIMEOUT_S),
      '--cancel-prompt',
      CANCEL_PROMPT,
      '--agent-cwd',
      dirs.workspace,
      '--report-json',
      reportPath,
      ...passthrough,
      '--',
      process.execPath,
      bootstrap,
      adapter
    ]
    console.log(`[pi-acp-tck] running ${TCK_REPOSITORY} @ ${TCK_REVISION} (ACP v1) against ${adapter}`)
    let child
    let teardownPromise
    let timedOut = false
    let externalSignal = null
    const ensureTeardown = () => {
      teardownPromise ??= teardownOwnedProcesses({ child, registryDir })
      return teardownPromise
    }
    // The whole run — bounded setup probes, state preparation, provisioning
    // and the suite — shares one wall-clock deadline; teardown may extend past
    // it by at most KILL_GRACE_MS + HARD_KILL_WAIT_MS of bounded cleanup.
    const watchdog = setTimeout(
      () => {
        timedOut = true
        console.error(`[pi-acp-tck] global time budget exceeded; terminating owned TCK processes`)
        if (child) void ensureTeardown()
      },
      Math.max(1, deadline - Date.now())
    )
    try {
      child = spawn('uv', args, { env, stdio: 'inherit', detached: process.platform !== 'win32' })
      if (timedOut) {
        await ensureTeardown()
        return SETUP_EXIT
      }
      const forwardSignal = signal => {
        if (externalSignal || teardownPromise) return
        externalSignal = signal
        console.error(`[pi-acp-tck] received ${signal}; terminating owned TCK processes`)
        void ensureTeardown()
      }
      process.on('SIGINT', () => forwardSignal('SIGINT'))
      process.on('SIGTERM', () => forwardSignal('SIGTERM'))
      const status = await new Promise((resolveExit, rejectExit) => {
        child.on('error', error => rejectExit(new SetupError(`failed to launch uv: ${error.message}`)))
        child.on('close', (code, signal) => resolveExit({ code, signal }))
      }).catch(async error => {
        // Even a failed launch funnels through the awaited owned teardown.
        await ensureTeardown()
        throw error
      })
      // Owned teardown is awaited before the disposable state is removed, on
      // every termination path — normal and early uv exits included.
      await ensureTeardown()
      if (timedOut) {
        await writeRunnerError('runner-timeout', 'TCK exceeded the global time budget')
        return SETUP_EXIT
      }
      if (externalSignal) {
        await writeRunnerError('runner-terminated', `runner received ${externalSignal} during the run`)
        return SETUP_EXIT
      }
      if (status.signal) {
        await writeRunnerError('runner-terminated', `TCK process terminated by signal ${status.signal}`)
        return SETUP_EXIT
      }
      const { error: reportError, reason, report } = await readTckReport()
      if (reportError) {
        await writeRunnerError(
          reportError,
          reportError === 'tck-no-report'
            ? `TCK exited with ${status.code} without writing ${reportPath}`
            : `TCK report at ${reportPath} is invalid: ${reason}`
        )
        return SETUP_EXIT
      }
      printSummary(report)
      const conformant = report.verdict.conformant
      if (!((status.code === 0 && conformant) || (status.code === 1 && !conformant))) {
        await writeRunnerError(
          'tck-inconsistent-verdict',
          `TCK exited ${status.code} with conformant=${conformant}; only exit 0 with a conformant report or exit 1 with a non-conformant report is a verdict`
        )
        return SETUP_EXIT
      }
      return status.code
    } finally {
      clearTimeout(watchdog)
    }
  })

let exitStatus
try {
  // The budget is validated and the deadline set before any probe runs, so
  // setup time is paid out of the same wall-clock budget as the suite.
  const budget = validateBudget(process.env.PI_ACP_TCK_TIMEOUT_MS)
  const deadline = Date.now() + budget
  const remaining = () => deadline - Date.now()
  const setup = checkSetup(remaining)
  try {
    await mkdir(reportDir, { recursive: true })
  } catch (error) {
    throw new SetupError(`cannot create the report directory ${reportDir}: ${error.message}`)
  }
  console.log(`[pi-acp-tck] report will be written to ${reportPath}`)
  console.log(
    '[pi-acp-tck] the report contains full wire transcripts, including prompt/session content; do not commit it'
  )
  exitStatus = await runTck({ ...setup, deadline })
} catch (error) {
  if (error instanceof SetupError) {
    await writeRunnerError('setup-error', error.message)
    console.error(`[pi-acp-tck] setup error: ${error.message}`)
    exitStatus = SETUP_EXIT
  } else {
    // Any residual failure (isolation mkdtemp/mkdir/rm, unexpected runtime
    // errors) is still a runner error with a best-effort persistent diagnostic.
    await writeRunnerError('runner-error', `${error?.message ?? error}`)
    console.error(`[pi-acp-tck] runner error: ${error?.stack ?? error}`)
    exitStatus = SETUP_EXIT
  }
}
process.exit(exitStatus)
