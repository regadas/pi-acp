import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withSmokeAgent } from './smoke-client.mjs'

// Genuine installed Pi + the operator's clean read-only git-main pi-subagents checkout.
// The exact git revision is verified; the package version label is not runtime identity.
// Pinned newer than the completion/cancel probes (29284cd): the subagent-async
// widget snapshot surface this probe exercises is only present from this revision on.
const stock = process.env.PI_ACP_EVAL_SUBAGENTS
if (!stock) throw new Error('Set PI_ACP_EVAL_SUBAGENTS to the clean pi-subagents git checkout root')
const STOCK_REVISION = 'de6957becc859561f74195c8c0a0a717831e6b95'
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
assert.ok(existsSync('dist/index.js'), 'Run npm run build first: this eval drives the built adapter')
const pi = process.env.PI_ACP_EVAL_PI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
identity.piVersion = execFileSync(pi, ['--version'], { encoding: 'utf8' }).trim()
const [piMajor, piMinor] = identity.piVersion.split(/[.\s]/).map(Number)
assert.ok(piMajor > 1 || (piMajor === 1 && piMinor >= 2), `pi >= 1.2.0 is required, found ${identity.piVersion}`)
const fixture = resolve('scripts/fixtures/subagents-completion-provider.ts')
const checks = []
const check = (scenario, assertion, passed, evidence) => {
  checks.push({ scenario, assertion, passed, ...(evidence === undefined ? {} : { evidence }) })
  console.log(`${passed ? 'PASS' : 'FAIL'} [${scenario}] ${assertion}`)
  if (!passed) assert.fail(`[${scenario}] ${assertion}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isLive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// One isolated HOME/agent/tmp tree shared by all three phases: the second
// (plain-capability) prompt reuses the released gate so it settles quickly;
// the third (v2) removes it first to hold its child for the running
// announcement, then rewrites it (see the phase comment).
const root = await mkdtemp(join(tmpdir(), 'pi-acp-subagents-telemetry-'))
const wrapper = join(root, 'pi-wrapper.mjs')
const records = async () =>
  (await readFile(join(root, 'stock.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
const wait = async (predicate, label, budget = 45_000) => {
  const deadline = Date.now() + budget
  for (;;) {
    const found = predicate(await records())
    if (found) return found
    assert.ok(Date.now() < deadline, `Expected ${label} before the test deadline`)
    await sleep(5)
  }
}
const waitFor = async (predicate, label, budget = 45_000) => {
  const deadline = Date.now() + budget
  for (;;) {
    const found = predicate()
    if (found) return found
    assert.ok(Date.now() < deadline, `Expected ${label} before the test deadline`)
    await sleep(25)
  }
}
// Per-phase clients and traces so later phases never overwrite earlier evidence.
const phaseClients = []
const env = {
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
const subagentUpdatesOf = client => client.updates.filter(update => update.sessionUpdate === 'subagent_update')
const sessionMessagesOf = client => client.updates.filter(update => update.sessionUpdate === 'session_message')

try {
  await mkdir(join(root, 'agent', 'agents'), { recursive: true })
  await mkdir(join(root, 'agent', 'extensions', 'subagent'), { recursive: true })
  await mkdir(join(root, 'tmp'))
  await writeFile(
    join(root, 'agent', 'settings.json'),
    JSON.stringify({ defaultProvider: 'stock-eval', defaultModel: 'local' })
  )
  await writeFile(join(root, 'agent', 'extensions', 'subagent', 'config.json'), JSON.stringify({}))
  for (const name of ['eval-root', 'eval-leaf'])
    await writeFile(
      join(root, 'agent', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Isolated deterministic product test\nmodel: stock-eval/local\ntools: ${name === 'eval-root' ? 'subagent' : 'read'}\nextensions: ${fixture}\n---\nOnly the deterministic provider executes this test.\n`
    )
  // The completion fixture's S_CANCEL shape: one gated async root that holds the
  // ACP turn open (adapter completion barrier) until its release file appears.
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.includes('--version')) args.push('--extension', ${JSON.stringify(fixture)}, '--extension', ${JSON.stringify(stockEntry)});
const child = spawn(${JSON.stringify(pi)}, args, {stdio: 'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o755 }
  )

  // Phase 1: the subagents capability is negotiated; child sessions must surface.
  await withSmokeAgent(
    async client => {
      phaseClients.push(client)
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: { subagents: {} } })
      const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
      const prompt = client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'S_CANCEL observe subagent telemetry' }]
      })
      const launched = await wait(
        rows => rows.find(row => row.event === 'tool_result' && row.toolName === 'subagent' && !row.isError),
        'stock subagent launch result'
      )
      const childId = launched.details.asyncId
      const announcement = await waitFor(
        () => subagentUpdatesOf(client).find(update => update.sessionId === childId),
        `subagent_update announcing child ${childId}`
      )
      assert.deepEqual(announcement.state, { state: 'running' }, 'the gated child is announced as running')
      check('S_TELEMETRY', 'the async child is announced as an ACP child session', true, {
        childId,
        title: announcement.title,
        description: announcement.description,
        state: announcement.state
      })
      assert.ok(announcement.title, 'the announcement carries a title')
      assert.ok(announcement.description, 'the announcement carries a description')
      assert.deepEqual(announcement.capabilities, {}, 'no cancel capability is advertised')

      await writeFile(join(root, 'release-cancel'), 'release')
      // Correlate the producer's own state change with the ACP mapping: the
      // stock snapshot must report the child complete before the turn settles.
      const completion = await wait(
        rows =>
          rows.find(
            row => row.event === 'snapshot' && row.runs.some(run => run.id === childId && run.state === 'complete')
          ),
        `stock snapshot reporting child ${childId} complete`
      )
      const result = await prompt
      assert.equal(result.stopReason, 'end_turn')
      const settled = subagentUpdatesOf(client)
        .filter(update => update.sessionId === childId)
        .find(update => update.state?.state === 'idle' && update.state?.stopReason === 'end_turn')
      assert.ok(settled, `the completed child was mapped to idle/end_turn (${JSON.stringify(completion)})`)
      check('S_TELEMETRY', 'the producer state change is correlated with its ACP idle mapping', true, {
        childId,
        producerCompleteAt: completion.at,
        settledState: settled.state
      })

      const announced = new Set(subagentUpdatesOf(client).map(update => update.sessionId))
      assert.ok(announced.has(childId))
      const messages = sessionMessagesOf(client)
      const recipients = new Set(messages.map(message => message.recipientSessionId))
      assert.deepEqual([...recipients].sort(), [...announced].sort(), 'one session_message per announced child')
      assert.equal(messages.length, announced.size, 'exactly one session_message per announced child')
      assert.equal(new Set(messages.map(message => message.messageId)).size, messages.length, 'message ids are unique')
      for (const message of messages) {
        assert.equal(message.senderSessionId, sessionId)
        assert.equal(message.content?.length, 1)
        assert.equal(message.content[0]?.type, 'text')
        assert.ok(message.messageId)
      }
      check('S_TELEMETRY', 'one parent-to-child session_message per announced child', true, {
        announcedChildren: [...announced],
        messages: messages.map(message => ({ messageId: message.messageId, child: message.recipientSessionId }))
      })
      await client.request('session/close', { sessionId }).catch(() => {})
    },
    { timeoutMs: 150_000, env }
  )

  // Phase 2: plain capabilities; the same activity must stay invisible. The
  // launch proof keeps the negative control from being vacuous.
  await withSmokeAgent(
    async client => {
      phaseClients.push(client)
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      // Captured before session/new: the phase-2 pi child (and its rows) does
      // not exist yet, so its later launch row is distinguishable by pid.
      const earlierPids = new Set((await records()).map(row => row.pid))
      const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
      const result = await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'S_CANCEL plain capabilities control' }]
      })
      assert.equal(result.stopReason, 'end_turn')
      const launch = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'tool_result' && row.toolName === 'subagent' && !row.isError && !earlierPids.has(row.pid)
          ),
        'phase 2 stock subagent launch (the negative control saw real activity)'
      )
      assert.equal(subagentUpdatesOf(client).length, 0, 'no subagent_update without the capability')
      assert.equal(sessionMessagesOf(client).length, 0, 'no session_message without the capability')
      check('S_TELEMETRY_PLAIN', 'plain clientCapabilities emit no child-session updates', true, {
        stopReason: result.stopReason,
        phase2ChildId: launch.details.asyncId,
        phase2Updates: subagentUpdatesOf(client).length
      })
      await client.request('session/close', { sessionId }).catch(() => {})
    },
    { timeoutMs: 150_000, env }
  )

  // Phase 3: a v2 connection. Subagents are baseline in ACP v2 — no client
  // capability exists — so the same activity must surface on the v2 wire with
  // empty client capabilities. The gate file is removed first so the fresh
  // child holds deterministically for the running announcement.
  await rm(join(root, 'release-cancel'), { force: true })
  await withSmokeAgent(
    async client => {
      phaseClients.push(client)
      const initialize = await client.request('initialize', {
        protocolVersion: 2,
        info: { name: 'pi-acp-eval-v2', version: '0.0.0' },
        capabilities: {}
      })
      assert.equal(initialize.protocolVersion, 2, 'the v2 chain answered the initialize')
      const earlierPids = new Set((await records()).map(row => row.pid))
      const { sessionId } = await client.request('session/new', { cwd: root })
      const prompt = client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'S_CANCEL v2 baseline subagent telemetry' }]
      })
      const launched = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'tool_result' && row.toolName === 'subagent' && !row.isError && !earlierPids.has(row.pid)
          ),
        'phase 3 stock subagent launch on the v2 connection'
      )
      const childId = launched.details.asyncId
      const announcement = await waitFor(
        () => subagentUpdatesOf(client).find(update => update.sessionId === childId),
        `v2 subagent_update announcing child ${childId}`
      )
      assert.deepEqual(announcement.state, { state: 'running' }, 'the gated child is announced as running on v2')
      check('S_TELEMETRY_V2', 'the async child is announced as a v2 subagent session (baseline, no capability)', true, {
        childId,
        title: announcement.title,
        state: announcement.state
      })
      assert.ok(announcement.title, 'the v2 announcement carries a title')
      assert.ok(announcement.description, 'the v2 announcement carries a description')
      assert.deepEqual(announcement.capabilities, {}, 'no cancel capability is advertised on v2')

      await writeFile(join(root, 'release-cancel'), 'release')
      const completion = await wait(
        rows =>
          rows.find(
            row => row.event === 'snapshot' && row.runs.some(run => run.id === childId && run.state === 'complete')
          ),
        `stock snapshot reporting child ${childId} complete (phase 3)`
      )
      const result = await prompt
      assert.equal(typeof result.messageId, 'string', 'the v2 prompt response carries its messageId')
      const settled = subagentUpdatesOf(client)
        .filter(update => update.sessionId === childId)
        .find(update => update.state?.state === 'idle' && update.state?.stopReason === 'end_turn')
      assert.ok(settled, `the completed child was mapped to idle/end_turn on v2 (${JSON.stringify(completion)})`)
      check('S_TELEMETRY_V2', 'the producer state change is correlated with its ACP idle mapping on v2', true, {
        childId,
        producerCompleteAt: completion.at,
        settledState: settled.state
      })

      const announced = new Set(subagentUpdatesOf(client).map(update => update.sessionId))
      assert.ok(announced.has(childId))
      const messages = sessionMessagesOf(client)
      const recipients = new Set(messages.map(message => message.recipientSessionId))
      assert.deepEqual([...recipients].sort(), [...announced].sort(), 'one v2 session_message per announced child')
      assert.equal(messages.length, announced.size, 'exactly one v2 session_message per announced child')
      assert.equal(new Set(messages.map(message => message.messageId)).size, messages.length, 'message ids are unique')
      for (const message of messages) {
        assert.equal(message.senderSessionId, sessionId)
        assert.equal(message.content?.length, 1)
        assert.equal(message.content[0]?.type, 'text')
        assert.ok(message.messageId)
      }
      check('S_TELEMETRY_V2', 'one parent-to-child session_message per announced child on v2', true, {
        announcedChildren: [...announced],
        messages: messages.map(message => ({ messageId: message.messageId, child: message.recipientSessionId }))
      })
      await client.request('session/close', { sessionId }).catch(() => {})
    },
    { timeoutMs: 150_000, env }
  )

  verifyStock('after tests')
  console.log(JSON.stringify({ identity, checks }, null, 2))
} finally {
  // Release every gate first so a failed phase cannot strand gated runners.
  await writeFile(join(root, 'release-cancel'), 'release').catch(() => {})
  const acpMessages = phaseClients.flatMap(client => [...client.messages])
  const rows = await records()
  const runnerPids = []
  for (const dir of new Set(
    rows
      .filter(row => row.event === 'tool_result')
      .map(row => row.details?.asyncDir)
      .filter(Boolean)
  )) {
    assert.ok(String(dir).startsWith(join(root, 'tmp') + '/'), 'only this isolated test owns these runner artifacts')
    try {
      const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'))
      if (Number.isInteger(status.pid) && status.pid > 0) runnerPids.push(status.pid)
    } catch {
      /* The runner may have already removed its status file. */
    }
  }
  const pids = [...new Set([...rows.map(row => row.pid).filter(Number.isInteger), ...runnerPids])]
  const deadline = Date.now() + 20_000
  while (pids.some(isLive) && Date.now() < deadline) await sleep(25)
  const livePids = pids.filter(isLive)
  check('S_TELEMETRY', 'all recorded isolated Pi/runner processes exited', livePids.length === 0, { pids, livePids })
  const destination = process.env.PI_ACP_EVAL_LOG_DIR
  if (destination) {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'stock-trace.jsonl'), await readFile(join(root, 'stock.jsonl')).catch(() => ''))
    await writeFile(
      join(destination, 'acp-trace.jsonl'),
      acpMessages.map(message => JSON.stringify(message)).join('\n') + '\n'
    )
  }
  assert.deepEqual(livePids, [], 'the telemetry eval left isolated processes alive')
  if (!process.env.PI_ACP_EVAL_KEEP) await rm(root, { recursive: true, force: true })
}
