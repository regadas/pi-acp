import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withSmokeAgent } from './smoke-client.mjs'

// Genuine installed Pi + the user's clean read-only git-main pi-subagents checkout.
// The package version label is not runtime identity: the exact git revision is verified.
const stock = process.env.PI_ACP_EVAL_SUBAGENTS
if (!stock) throw new Error('Set PI_ACP_EVAL_SUBAGENTS to the clean pi-subagents git checkout root')
const STOCK_REVISION = '29284cd943c0c7ee852593c6e02d2a60febf6ba4'
const stockGit = (...args) => execFileSync('git', ['-C', stock, ...args], { encoding: 'utf8' }).trim()
const verifyStock = when => {
  const head = stockGit('rev-parse', 'HEAD')
  const status = stockGit('status', '--porcelain')
  assert.equal(head, STOCK_REVISION, `${when}: pi-subagents must be at the approved git revision`)
  assert.equal(status, '', `${when}: pi-subagents checkout must be clean`)
  return { when, head, status }
}
const identity = { before: verifyStock('before tests') }
const stockPackage = JSON.parse(await readFile(join(stock, 'package.json'), 'utf8'))
const declaredEntry = stockPackage.exports?.['.'] ?? stockPackage.main
assert.equal(declaredEntry, './index.ts', 'the approved checkout must declare its index.ts entry')
const stockEntry = join(stock, 'index.ts')
assert.ok(existsSync(stockEntry), 'declared stock entry is missing')
identity.declaredEntry = declaredEntry
assert.ok(existsSync('dist/index.js'), 'Run npm run build first: this eval drives the built adapter')
const pi = process.env.PI_ACP_EVAL_PI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
identity.piVersion = execFileSync(pi, ['--version'], { encoding: 'utf8' }).trim()
const [piMajor, piMinor] = identity.piVersion.split(/[.\s]/).map(Number)
assert.ok(piMajor > 1 || (piMajor === 1 && piMinor >= 1), `pi >= 1.1.0 is required, found ${identity.piVersion}`)
const root = await mkdtemp(join(tmpdir(), 'pi-acp-stock-cancel-'))
const fixture = resolve('scripts/fixtures/subagents-cancel-provider.ts')
const wrapper = join(root, 'pi-wrapper.mjs')
const checks = []
const acpMessages = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const records = async () =>
  (await readFile(join(root, 'stock.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse)
const wait = async predicate => {
  const deadline = Date.now() + 15000
  for (;;) {
    const found = await predicate(await records())
    if (found) return found
    assert.ok(Date.now() < deadline, 'Expected stock host evidence before test deadline')
    await sleep(5)
  }
}
try {
  await mkdir(join(root, 'agent', 'agents'), { recursive: true })
  await mkdir(join(root, 'agent', 'extensions', 'subagent'), { recursive: true })
  await mkdir(join(root, 'tmp'))
  await writeFile(
    join(root, 'agent', 'settings.json'),
    JSON.stringify({ defaultProvider: 'stock-eval', defaultModel: 'local' })
  )
  // git-main pi-subagents reads its own config from <agentDir>/extensions/subagent/config.json.
  await writeFile(
    join(root, 'agent', 'extensions', 'subagent', 'config.json'),
    JSON.stringify({
      intercomBridge: { mode: 'off' },
      completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000 }
    })
  )
  for (const name of ['eval-root', 'eval-leaf'])
    await writeFile(
      join(root, 'agent', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Isolated deterministic product test\nmodel: stock-eval/local\ntools: ${name === 'eval-root' ? 'subagent' : 'read'}\nextensions: ${fixture}\n---\nOnly the deterministic provider executes this test.\n`
    )
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.includes('--version')) args.push('--extension', ${JSON.stringify(fixture)}, '--extension', ${JSON.stringify(join(stock, 'index.ts'))});
const child = spawn(${JSON.stringify(pi)}, args, {stdio: 'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o755 }
  )
  const scenarios = ['delivery', 'nested']
  if (process.env.PI_ACP_EVAL_SCENARIO) assert.ok(scenarios.includes(process.env.PI_ACP_EVAL_SCENARIO))
  for (const scenario of scenarios.filter(
    value => !process.env.PI_ACP_EVAL_SCENARIO || value === process.env.PI_ACP_EVAL_SCENARIO
  )) {
    await rm(join(root, 'release-leaf'), { force: true })
    const before = (await records()).length
    await withSmokeAgent(
      async client => {
        acpMessages.push(client.messages)
        await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
        const parent = await wait(rows => rows.slice(before).find(row => row.event === 'session'))
        let settled = false
        let settledAt = 0
        const prompt = client
          .request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: scenario === 'delivery' ? 'STOCK_LAUNCH' : 'STOCK_LAUNCH_NESTED' }]
          })
          .then(result => {
            settled = true
            settledAt = Date.now()
            return result
          })
        const launched = await wait(rows =>
          rows
            .slice(before)
            .find(row => row.event === 'tool_result' && row.sessionId === parent.sessionId && row.details?.asyncId)
        )
        const id = launched.details.asyncId
        if (scenario === 'delivery') {
          assert.ok(launched.details.asyncDir.startsWith(join(root, 'tmp')), 'stock job directory must be isolated')
          const terminal = await wait(async rows => {
            const status = JSON.parse(
              await readFile(join(launched.details.asyncDir, 'status.json'), 'utf8').catch(() => '{}')
            )
            const host = rows
              .slice(before)
              .findLast(row => row.event === 'snapshot' && row.sessionId === parent.sessionId)
            return status.state === 'complete' && host?.live ? { status, host } : undefined
          })
          assert.equal(settled, false, 'real stock terminal root remains held through pending delivery')
          checks.push({
            scenario,
            assertion: 'terminal root with host liveness held ACP open',
            evidence: terminal,
            passed: true
          })
        } else {
          const leaf = await wait(rows => rows.slice(before).find(row => row.event === 'leaf-live'))
          assert.equal(settled, false)
          checks.push({ scenario, assertion: 'actual stock nested child is live', evidence: leaf, passed: true })
          // git-main keeps the root job running until its whole nested subtree drains;
          // the 0.67-era terminal-root/live-child shape never occurs there.
          await wait(rows =>
            rows
              .slice(before)
              .find(
                row =>
                  row.event === 'snapshot' &&
                  row.sessionId === parent.sessionId &&
                  row.live &&
                  row.reply?.data?.asyncSnapshot?.runs?.some(
                    run => run.id === id && run.state === 'running' && (run.children ?? []).length > 0
                  )
              )
          )
          assert.equal(settled, false, 'a running root with a live nested subtree must retain the ACP turn')
        }
        const cancelAt = Date.now()
        client.notify('session/cancel', { sessionId })
        assert.equal((await prompt).stopReason, 'cancelled')
        assert.ok(settledAt - cancelAt < 11000, 'the ten-second cancellation budget must not restart')
        const warning = client.updates.some(
          update =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content?.text?.includes('detached work may still be running')
        )
        const after = (await records()).slice(before)
        assert.equal(
          warning,
          false,
          'verified nested work and finite delivery must drain within the unchanged deadline'
        )
        checks.push({
          scenario,
          assertion: 'quiescence confirmed within the existing cancellation budget',
          elapsedMs: settledAt - cancelAt,
          warning,
          passed: true
        })
        if (scenario === 'nested') {
          const leafEnd = after.find(row => row.event === 'leaf-settled')
          // A leaf ending at its own 15s gate timeout is not cancellation proof.
          assert.ok(leafEnd, 'nested execution must settle before ACP cancellation, not only acknowledge a stop')
          assert.equal(leafEnd.aborted, true)
          assert.equal(leafEnd.gateReleased, false)
          assert.ok(leafEnd.at <= settledAt, 'leaf execution must settle before the ACP cancellation response')
          const controls = after.filter(row => row.event === 'stop-reply' || row.event === 'interrupt-reply')
          assert.ok(controls.length > 0, 'cancellation must exercise the public stop control')
          assert.ok(
            controls.every(row => (row.request.params ?? {}).id === id),
            'every public stop/interrupt targets exactly the required root; nested and foreign runs are never stopped'
          )
          checks.push({
            scenario,
            assertion: 'nested cancellation stops exactly the required root and bounds its subtree',
            evidence: {
              leafSettledAt: leafEnd.at,
              leafAborted: leafEnd.aborted,
              gateReleased: leafEnd.gateReleased,
              stopCount: controls.length,
              firstStopAt: controls[0].at
            },
            passed: true
          })
          // git-main keeps the root running until its subtree drains and exposes nested steps
          // as kind 'step' children, so the 0.67-era public interrupt of nested runs never fires.
          checks.push({
            scenario,
            observation:
              'git-main stop of the required root aborts its nested leaf; no public interrupt of step-kind children occurs',
            reproduced: true,
            evidence: {
              firstStopAt: controls.find(row => row.event === 'stop-reply')?.at,
              leafSettledAt: leafEnd.at,
              interruptCount: after.filter(row => row.event === 'interrupt-reply').length
            }
          })
        }
        await client.request('session/close', { sessionId })
      },
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          PI_ACP_PI_COMMAND: wrapper,
          PI_ACP_STOCK_ROOT: root,
          TMPDIR: join(root, 'tmp'),
          TMP: join(root, 'tmp'),
          TEMP: join(root, 'tmp')
        }
      }
    )
  }
  console.log(JSON.stringify(checks, null, 2))
} finally {
  await writeFile(join(root, 'release-leaf'), 'release')
  const rows = await records()
  const runnerPidSources = []
  for (const dir of new Set(
    rows
      .filter(row => row.event === 'tool_result')
      .map(row => row.details?.asyncDir)
      .filter(Boolean)
  )) {
    assert.ok(dir.startsWith(join(root, 'tmp') + '/'), 'only this isolated test owns these runner artifacts')
    const statusPath = join(dir, 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    if (Number.isInteger(status.pid) && status.pid > 0) runnerPidSources.push({ statusPath, pid: status.pid })
  }
  const pids = [...new Set([...rows.map(row => row.pid), ...runnerPidSources.map(source => source.pid)])]
  const deadline = Date.now() + 15000
  const isLive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  while (pids.some(isLive) && Date.now() < deadline) await sleep(25)
  const livePids = pids.filter(isLive)
  checks.push({
    assertion: 'all recorded isolated Pi/runner processes exited',
    pids,
    runnerPidSources,
    livePids,
    passed: livePids.length === 0
  })
  const destination = process.env.PI_ACP_EVAL_LOG_DIR
  identity.after = verifyStock('after tests')
  if (destination) {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'stock-trace.jsonl'), await readFile(join(root, 'stock.jsonl')).catch(() => ''))
    await writeFile(join(destination, 'stock-checks.json'), JSON.stringify({ identity, checks }, null, 2) + '\n')
    await writeFile(
      join(destination, 'stock-acp-trace.jsonl'),
      acpMessages
        .flat()
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    )
  }
  // Keep local upstream evidence; do not delete artifacts under a finishing runner.
  console.error(`Stock evaluation artifacts retained: ${root}`)
  assert.deepEqual(livePids, [], 'no isolated runtime may be left alive')
}
