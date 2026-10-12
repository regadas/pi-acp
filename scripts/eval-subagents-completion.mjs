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
const fixture = resolve('scripts/fixtures/subagents-completion-provider.ts')
const checks = []
const check = (scenario, assertion, passed, evidence) => {
  checks.push({ scenario, assertion, passed, ...(evidence === undefined ? {} : { evidence }) })
  console.log(`${passed ? 'PASS' : 'FAIL'} [${scenario}] ${assertion}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const APPEND_SENTINEL = 'GLOBAL_APPEND_SENTINEL: user-provided prompt resource'
const RELEASE_GATES = [
  'early',
  'late',
  'entry',
  'cancel',
  'nested',
  'twob',
  'detached',
  'unstructured',
  'deadline',
  'foreign',
  'supervisor',
  'workflow',
  'wfcancel',
  'wfearly'
]
const isLive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const chunk = text => update => update.sessionUpdate === 'agent_message_chunk' && update.content?.text?.includes(text)

// Every scenario gets an isolated HOME/agent/tmp tree; the adapter and every stock runner
// subprocess are recorded, drained and verified to exit before the scenario returns.
const runScenario = async scenario => {
  const root = await mkdtemp(join(tmpdir(), `pi-acp-completion-${scenario.name.toLowerCase()}-`))
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
  const waitForUpdate = async (predicate, label, budget = 45_000) => {
    const deadline = Date.now() + budget
    for (;;) {
      const client = scenarioClient
      const found = client?.updates.find(predicate)
      if (found) return found
      assert.ok(Date.now() < deadline, `Expected ACP update: ${label}`)
      await sleep(5)
    }
  }
  let scenarioClient
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
        // Native supervisor transport only; external intercom result delivery stays off.
        intercomBridge: scenario.supervisor ? { mode: 'always', resultDelivery: false } : { mode: 'off' },
        ...(scenario.batch ? { completionBatch: scenario.batch } : {})
      })
    )
    for (const name of ['eval-root', 'eval-leaf'])
      await writeFile(
        join(root, 'agent', 'agents', `${name}.md`),
        `---\nname: ${name}\ndescription: Isolated deterministic product test\nmodel: stock-eval/local\ntools: ${name === 'eval-root' ? 'subagent' : scenario.supervisor ? 'read, contact_supervisor' : 'read'}\nextensions: ${fixture}\n---\nOnly the deterministic provider executes this test.\n`
      )
    // A user resource discovered natively from the isolated agent directory (no CLI injection).
    await writeFile(join(root, 'agent', 'APPEND_SYSTEM.md'), APPEND_SENTINEL)
    // Explicit async workflow child: dispatch completes while the child keeps running as a promoted row.
    for (const name of ['workflow', 'wfcancel'])
      await writeFile(
        join(root, `${name}.js`),
        `const [child] = await runs.all([{ key: 'child', agent: 'eval-leaf', task: 'LEAF_GATED:${name}', async: true }]);\nreturn child.runId;\n`
      )
    // An explicit-async early child plus an awaited gated child: dispatch waits while the early child finishes.
    await writeFile(
      join(root, 'wfearly.js'),
      `const early = await runs.run('early', { agent: 'eval-leaf', task: 'LEAF_QUICK:wfearly', async: true });\nconst slow = await runs.run('slow', { agent: 'eval-leaf', task: 'LEAF_GATED:wfearly' });\nreturn [early.runId, slow.runId];\n`
    )
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
    await withSmokeAgent(
      async client => {
        scenarioClient = client
        await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
        const prompt = text => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
        const messageIndexOf = predicate => client.messages.findLastIndex(predicate)
        const promptResponseIndex = () => {
          const index = client.messages.findLastIndex(message => message.result?.stopReason)
          assert.ok(index >= 0, 'the prompt must have responded')
          return index
        }
        const settledPromptGuard = () => promptResponseIndex() >= 0
        const launchRow = (after = 0) =>
          wait(
            rows =>
              rows.slice(after).find(row => row.event === 'tool_result' && row.toolName === 'subagent' && !row.isError),
            'stock subagent launch result'
          )
        const noticeRow = (id, after = 0) =>
          wait(
            rows =>
              rows
                .slice(after)
                .find(
                  row =>
                    row.event === 'custom' &&
                    row.customType === 'subagent-notify' &&
                    JSON.stringify(row.details?.runs ?? []).includes(JSON.stringify(id))
                ),
            `structured completion notice for ${id}`
          )
        const providerRow = (text, after = 0) =>
          wait(rows => rows.slice(after).find(row => row.event === 'provider' && row.response?.includes(text)), text)
        await scenario.drive({
          client,
          sessionId,
          root,
          prompt,
          records,
          wait,
          waitForUpdate,
          launchRow,
          noticeRow,
          providerRow,
          messageIndexOf,
          promptResponseIndex,
          settledPromptGuard,
          check,
          assert
        })
        await client.request('session/close', { sessionId }).catch(() => {})
      },
      {
        timeoutMs: scenario.timeoutMs ?? 90_000,
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
  } finally {
    const acpMessages = scenarioClient ? [...scenarioClient.messages] : []
    scenarioClient = undefined
    for (const gate of RELEASE_GATES) await writeFile(join(root, `release-${gate}`), 'release').catch(() => {})
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
    check(scenario.name, 'all recorded isolated Pi/runner processes exited', livePids.length === 0, { pids, livePids })
    const destination = process.env.PI_ACP_EVAL_LOG_DIR
    if (destination) {
      await mkdir(join(destination, scenario.name), { recursive: true })
      await writeFile(
        join(destination, scenario.name, 'stock-trace.jsonl'),
        await readFile(join(root, 'stock.jsonl')).catch(() => '')
      )
      await writeFile(
        join(destination, scenario.name, 'acp-trace.jsonl'),
        acpMessages.map(message => JSON.stringify(message)).join('\n') + '\n'
      )
    }
    assert.deepEqual(livePids, [], `scenario ${scenario.name} left isolated processes alive`)
    if (!process.env.PI_ACP_EVAL_KEEP) await rm(root, { recursive: true, force: true })
  }
}

const indexChunk = (client, text, after = 0) =>
  client.messages.findIndex(
    (message, index) =>
      index >= after &&
      message.method === 'session/update' &&
      message.params.update.sessionUpdate === 'agent_message_chunk' &&
      message.params.update.content?.text?.includes(text)
  )
const promptResponseIndexOf = client => {
  const index = client.messages.findLastIndex(message => message.result?.stopReason)
  assert.ok(index >= 0, 'the prompt must have responded')
  return index
}

const scenarios = [
  {
    name: 'S_EARLY',
    batch: { enabled: true, debounceMs: 4000, maxWaitMs: 4000 },
    timeoutMs: 120_000,
    async drive({ client, root, prompt, records, wait, launchRow, noticeRow, providerRow, check }) {
      let settled = false
      const promptStart = client.messages.length
      const turn = prompt('S_EARLY').then(result => {
        settled = true
        return result
      })
      const launched = await launchRow()
      const id = launched.details.asyncId
      assert.ok(launched.details.asyncDir.startsWith(join(root, 'tmp')), 'stock job directory must be isolated')
      // The provider deliberately ends its response without any wait tool.
      await providerRow('EARLY_YIELD:early')
      // Observation only: the instant state right after the yield is not a discriminating hold check.
      check('S_EARLY', 'observed: prompt unresolved right after the early yield', !settled, { asyncId: id })
      // Release the gated root; its terminal status is observed well before the debounced notice queues.
      await writeFile(join(root, 'release-early'), 'release')
      // A genuinely fast provider with a runnable waiting draft: the stock batches the
      // completion notice, so the extension-authored draft reaches the provider first.
      const firstProbe = await providerRow('WAITING_PROBE')
      const probes = async () => (await records()).filter(row => row.event === 'provider' && row.probe)
      const notice = await noticeRow(id)
      assert.ok(firstProbe.at < notice.at, 'the fast provider notice queued after a probe')
      check('S_EARLY', 'runnable waiting-draft probe before a later native notice', true, {
        firstProbeAt: firstProbe.at,
        noticeAt: notice.at
      })
      await providerRow('FINAL_SYNTHESIS:early')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = client.messages.findIndex(
        message =>
          message.method === 'session/update' &&
          message.params.update.sessionUpdate === 'agent_message_chunk' &&
          message.params.update.content?.text?.includes('FINAL_SYNTHESIS:early')
      )
      assert.ok(synthesisChunk > promptStart && synthesisChunk < responseIndex)
      check('S_EARLY', 'completion notice delivery and final synthesis precede the ACP response', true, {
        synthesisChunk,
        responseIndex
      })
      // Discriminating post-response window: an autonomous start after the response is the regression.
      const responseAt = Date.now()
      await sleep(3_000)
      const afterGrace = await records()
      const startsAfter = afterGrace.filter(
        row => row.event === 'agent_start' && row.pid === launched.pid && row.at >= responseAt
      )
      const lastSettled = afterGrace.findLast(row => row.event === 'agent_settled' && row.pid === launched.pid)
      assert.equal(startsAfter.length, 0, 'no owned model run may start within 3s after the response')
      assert.ok(lastSettled && lastSettled.at <= responseAt, 'native settlement precedes the ACP response')
      check('S_EARLY', 'no parent agent start in a 3s window after the ACP response; native settle precedes it', true, {
        responseAt,
        lastNativeSettleAt: lastSettled?.at,
        startsAfter
      })
      const probeRows = await probes()
      for (let index = 1; index < probeRows.length; index++)
        assert.ok(probeRows[index].at - probeRows[index - 1].at >= 900, 'probes keep at most one per second cadence')
      assert.ok(probeRows.length <= 30, 'probe count stays bounded')
      check('S_EARLY', 'probe cadence bounded at one per second', true, {
        count: probeRows.length,
        gaps: probeRows.slice(1).map((row, index) => row.at - probeRows[index].at)
      })
      // Revival: the same owner resumes the finished run; the revived capture stays required.
      const revivalStart = client.messages.length
      const rowsBeforeRevival = (await records()).length
      const revival = prompt('S_EARLY resume the earlier run now')
      const resumed = await wait(
        rows =>
          rows
            .slice(rowsBeforeRevival)
            .find(
              row =>
                row.event === 'tool_result' && row.toolName === 'subagent' && row.input?.action?.trim() === 'resume'
            ),
        'stock resume tool result'
      )
      assert.equal(resumed.isError, false, 'stock resume must accept the completed run')
      const revivedId = resumed.details.asyncId
      await noticeRow(revivedId, rowsBeforeRevival)
      await providerRow('FINAL_SYNTHESIS:early', rowsBeforeRevival)
      assert.equal((await revival).stopReason, 'end_turn')
      const revivalResponse = promptResponseIndexOf(client)
      const revivalChunk = indexChunk(client, 'FINAL_SYNTHESIS:early', revivalStart)
      assert.ok(revivalChunk >= 0 && revivalChunk < revivalResponse)
      check('S_EARLY', 'whitespace-padded resume revival stays required through its own delivery and synthesis', true, {
        revivedId,
        originalId: id,
        action: resumed.input.action
      })
    }
  },
  {
    name: 'S_LATE',
    async drive({ client, prompt, records, launchRow, noticeRow, providerRow, check }) {
      const turn = prompt('S_LATE')
      const launched = await launchRow()
      const id = launched.details.asyncId
      await providerRow('EARLY_YIELD:late')
      const notice = await noticeRow(id)
      await providerRow('FINAL_SYNTHESIS:late')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const probeRows = (await records()).filter(row => row.event === 'provider' && row.probe)
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = client.messages.findIndex(
        message =>
          message.method === 'session/update' &&
          message.params.update.sessionUpdate === 'agent_message_chunk' &&
          message.params.update.content?.text?.includes('FINAL_SYNTHESIS:late')
      )
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex)
      check('S_LATE', 'fast notice consumed through a native continuation, synthesis before response', true, {
        noticeAt: notice.at,
        probeCount: probeRows.length
      })
      const parentRows = (await records()).filter(row => row.event === 'provider' && row.marker === 'S_LATE')
      assert.ok(parentRows.length > 0 && parentRows.every(row => row.systemSentinel && row.systemPolicy))
      const session = (await records()).find(row => row.event === 'session')
      assert.equal(session.cliAppend, false, 'no CLI append flag: the sentinel comes from discovered APPEND_SYSTEM.md')
      check('S_LATE', 'discovered APPEND_SYSTEM.md content and adapter policy reach the provider', true, {
        rows: parentRows.length
      })
    }
  },
  {
    name: 'S_SUPERVISOR',
    supervisor: true,
    timeoutMs: 120_000,
    async drive({ client, root, prompt, records, wait, launchRow, noticeRow, providerRow, check }) {
      let settled = false
      const turn = prompt('S_SUPERVISOR').then(result => {
        settled = true
        return result
      })
      const launched = await launchRow()
      const id = launched.details.asyncId
      const yielded = await providerRow('EARLY_YIELD:supervisor')
      const asked = await wait(
        rows => rows.find(row => row.event === 'tool_result' && row.toolName === 'contact_supervisor'),
        'child contact_supervisor call',
        5_000
      ).catch(() => undefined)
      const request = await wait(
        rows => rows.find(row => row.event === 'custom' && row.customType === 'subagent_supervisor_request'),
        'parent consumes the native supervisor request'
      )
      const wake = (await records()).find(row => row.event === 'supervisor-wake')
      assert.equal(request.details?.runId, id, 'the request is attributed to the exact required run')
      assert.ok(wake && wake.data?.requestId === request.details.requestId, 'public wake event names the request')
      assert.ok(request.at > yielded.at, 'the child asked after the parent yielded into the barrier')
      assert.equal(settled, false)
      const replied = await wait(
        rows => rows.find(row => row.event === 'tool_result' && row.toolName === 'subagent_supervisor' && !row.isError),
        'parent replies through subagent_supervisor'
      )
      const answered = await wait(rows => rows.find(row => row.event === 'leaf-answered'), 'child receives the reply')
      assert.match(answered.reply, /SUPERVISOR_ANSWER/)
      await providerRow('SUPERVISOR_REPLIED')
      await sleep(2_000)
      const rows = await records()
      assert.equal(
        rows.some(row => row.event === 'leaf-settled' && row.marker === 'LEAF_ASK:supervisor'),
        false,
        'the child is still running after the reply'
      )
      assert.equal(settled, false, 'the barrier keeps holding while the answered child runs')
      const wakeProbe = rows.find(
        row => row.event === 'provider' && row.marker === 'S_SUPERVISOR' && row.supervisorDraft
      )
      check('S_SUPERVISOR', 'running child asks after the barrier; parent consumes and replies while it runs', true, {
        asyncId: id,
        requestId: request.details.requestId,
        yieldAt: yielded.at,
        wakeAt: wake.at,
        consumedAt: request.at,
        repliedAt: replied.at,
        childAnsweredAt: answered.at,
        waitingDraftNamedRequest: Boolean(wakeProbe),
        childToolResultRow: asked ? 'observed' : 'child tool_result not traced before reply'
      })
      await writeFile(join(root, 'release-supervisor'), 'release')
      const leafEnd = await wait(
        rows => rows.find(row => row.event === 'leaf-settled' && row.marker === 'LEAF_ASK:supervisor'),
        'answered child finishes'
      )
      const notice = await noticeRow(id)
      const synthesis = await providerRow('FINAL_SYNTHESIS:supervisor')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = indexChunk(client, 'FINAL_SYNTHESIS:supervisor')
      const replyChunk = indexChunk(client, 'SUPERVISOR_REPLIED')
      assert.ok(replyChunk >= 0 && replyChunk < synthesisChunk && synthesisChunk < responseIndex)
      // Same-millisecond rows are ordered by trace position; the synthesis call saw the notice.
      const trace = await records()
      const position = row => trace.findIndex(entry => JSON.stringify(entry) === JSON.stringify(row))
      assert.ok(position(answered) < position(leafEnd) && position(leafEnd) < position(notice))
      assert.ok(position(notice) < position(synthesis) && synthesis.notice === true)
      check('S_SUPERVISOR', 'child completion notice and distinct final synthesis precede the ACP response', true, {
        leafSettledAt: leafEnd.at,
        noticeAt: notice.at,
        synthesisAt: synthesis.at,
        replyChunk,
        synthesisChunk,
        responseIndex
      })
    }
  },
  {
    name: 'S_PRECONSUMED',
    timeoutMs: 120_000,
    async drive({ client, prompt, records, launchRow, noticeRow, providerRow, check }) {
      const turn = prompt('S_PRECONSUMED')
      const launched = await launchRow()
      const id = launched.details.asyncId
      const notice = await noticeRow(id)
      const synthesis = await providerRow('FINAL_SYNTHESIS:pre')
      assert.equal((await turn).stopReason, 'end_turn')
      const rows = (await records()).filter(row => row.pid === launched.pid)
      const boundaries = rows.filter(row => row.event === 'boundary')
      const starts = rows.filter(row => row.event === 'agent_start')
      const probes = rows.filter(row => row.event === 'provider' && row.probe)
      assert.ok(boundaries.length >= 1 && notice.at <= boundaries[0].at, 'the notice was consumed before the barrier')
      assert.equal(starts.length, 1, 'native in-run continuation: the notice was consumed inside the same run')
      assert.ok(
        synthesis.notice && synthesis.at <= boundaries[0].at,
        'synthesis answered the notice before the barrier'
      )
      assert.equal(boundaries.length, 1, 'the barrier released at entry without any continuation')
      assert.deepEqual(boundaries[0].entries, [], 'no waiting draft at entry')
      assert.equal(probes.length, 0)
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = indexChunk(client, 'FINAL_SYNTHESIS:pre')
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex)
      check('S_PRECONSUMED', 'notice consumed in-run before barrier entry releases at entry with no probe', true, {
        noticeAt: notice.at,
        synthesisAt: synthesis.at,
        boundaryAt: boundaries[0].at,
        agentStarts: starts.length,
        probes: probes.length
      })
    }
  },
  {
    name: 'S_WORKFLOW',
    timeoutMs: 150_000,
    async drive({ client, root, prompt, records, wait, launchRow, providerRow, check }) {
      let settledAt
      const turn = prompt('S_WORKFLOW').then(result => {
        settledAt = Date.now()
        return result
      })
      const launched = await launchRow()
      const workflowId = launched.details.asyncId
      const dispatched = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'custom' &&
              row.customType === 'subagent-notify' &&
              row.details?.runs?.some(run => run.runId === workflowId)
          ),
        'workflow dispatch completion notice'
      )
      const run = dispatched.details.runs.find(entry => entry.runId === workflowId)
      const child = (run.childRuns ?? []).find(entry => entry.status === 'running' || entry.status === 'pending')
      assert.equal(run.workflowRunId, workflowId)
      assert.ok(child?.runId && child.workflowKey, 'the dispatch notice maps the live promoted child to its key')
      const earlyCall = await wait(
        rows => rows.find(row => row.event === 'provider' && row.response?.some(part => part.startsWith('bg_wait('))),
        'early bg_wait call while the child runs'
      )
      await sleep(2_000)
      assert.equal(settledAt, undefined, 'the promoted live child keeps the request open after the dispatch notice')
      check('S_WORKFLOW', 'workflow dispatch completes while its promoted child holds the request', true, {
        workflowId,
        childRunId: child.runId,
        workflowKey: child.workflowKey,
        dispatchNoticeAt: dispatched.at
      })
      await writeFile(join(root, 'release-workflow'), 'release')
      const leafEnd = await wait(
        rows => rows.find(row => row.event === 'leaf-settled' && row.marker === 'LEAF_GATED:workflow'),
        'workflow child finishes'
      )
      const childNotice = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'custom' &&
              row.customType === 'subagent-notify' &&
              row.details?.runs?.some(entry => entry.runId === child.runId)
          ),
        'the genuine native child completion notice'
      )
      const synthesis = await providerRow('FINAL_SYNTHESIS:workflow')
      assert.equal((await turn).stopReason, 'end_turn')
      const rows = await records()
      const position = row => rows.findIndex(entry => JSON.stringify(entry) === JSON.stringify(row))
      const collections = rows.filter(
        row =>
          row.event === 'tool_result' && row.toolName === 'bg_wait' && !row.isError && row.input?.id === child.runId
      )
      assert.ok(collections.length >= 1, 'bg_wait returned the exact child completion')
      for (const collection of collections) {
        assert.ok(
          collection.details?.completions?.some(entry => entry.runId === child.runId && entry.state === 'complete'),
          'each collection carries the exact terminal completion references'
        )
        assert.ok(position(collection) < position(childNotice), 'collection preceded the native notice')
      }
      assert.ok(settledAt > childNotice.at, 'collection did not release the request; the native notice was still owed')
      const folded = rows.find(
        row =>
          row.event === 'snapshot' &&
          !row.runs.some(entry => entry.id === child.runId) &&
          row.runs.some(
            entry =>
              entry.id === workflowId &&
              entry.children?.some(
                step => step.kind === 'step' && step.id === child.workflowKey && step.state === 'complete'
              )
          )
      )
      assert.ok(folded, 'the finished child folded back under the workflow as its keyed step')
      assert.ok(position(childNotice) < position(synthesis) && synthesis.notice, 'synthesis answered the child notice')
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = indexChunk(client, 'FINAL_SYNTHESIS:workflow')
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex)
      check(
        'S_WORKFLOW',
        'bg_wait collections are not delivery; native child notice then distinct synthesis precede the response',
        true,
        {
          earlyCollectionCallAt: earlyCall.at,
          leafSettledAt: leafEnd.at,
          collections: collections.map(row => row.at),
          foldedAt: folded.at,
          childNoticeAt: childNotice.at,
          synthesisAt: synthesis.at,
          responseAt: settledAt,
          synthesisChunk,
          responseIndex
        }
      )
    }
  },
  {
    name: 'S_WFEARLY',
    timeoutMs: 150_000,
    async drive({ client, root, prompt, records, wait, providerRow, check }) {
      let settledAt
      const turn = prompt('S_WFEARLY').then(result => {
        settledAt = Date.now()
        return result
      })
      const launches = await wait(rows => {
        const found = rows.filter(row => row.event === 'tool_result' && row.toolName === 'subagent' && !row.isError)
        return found.length >= 2 ? found : undefined
      }, 'workflow and companion root launches')
      const workflowId = launches.find(row => row.input?.workflow)?.details.asyncId
      const companionId = launches.find(row => !row.input?.workflow)?.details.asyncId
      assert.ok(workflowId && companionId)
      const isNotice = row => row.event === 'custom' && row.customType === 'subagent-notify'
      const names = (row, id) => row.details?.runs?.some(run => run.runId === id)
      // The early child's genuine notice is consumed while the awaited child still holds dispatch.
      const early = await wait(
        rows =>
          rows.find(
            row =>
              isNotice(row) && row.details?.runs?.some(run => run.runId !== workflowId && run.runId !== companionId)
          ),
        'early workflow child notice before dispatch'
      )
      const earlyId = early.details.runs.find(run => run.runId !== workflowId && run.runId !== companionId).runId
      const beforeRelease = await records()
      assert.equal(beforeRelease.filter(row => isNotice(row) && names(row, workflowId)).length, 0, 'no dispatch yet')
      assert.equal(settledAt, undefined)
      await writeFile(join(root, 'release-wfearly'), 'release')
      const dispatch = await wait(
        rows => rows.find(row => isNotice(row) && names(row, workflowId)),
        'workflow dispatch notice'
      )
      const mapped = dispatch.details.runs.find(run => run.runId === workflowId)
      const child = (mapped.childRuns ?? []).find(entry => entry.runId === earlyId)
      assert.equal(mapped.workflowRunId, workflowId)
      assert.equal(child?.workflowKey, 'early', 'dispatch associates the early child by exact run and key')
      assert.equal(child.status, 'running', 'stock dispatch still reports the stale running launch receipt')
      const synthesis = await providerRow('FINAL_SYNTHESIS:wfearly')
      assert.equal((await turn).stopReason, 'end_turn')
      const rows = await records()
      const position = row => rows.findIndex(entry => JSON.stringify(entry) === JSON.stringify(row))
      const childNotices = rows.filter(row => isNotice(row) && names(row, earlyId) && !names(row, workflowId))
      assert.equal(childNotices.length, 1, 'no second child notice was needed')
      assert.ok(position(early) < position(dispatch) && position(dispatch) < position(synthesis) && synthesis.notice)
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = indexChunk(client, 'FINAL_SYNTHESIS:wfearly')
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex && settledAt >= synthesis.at)
      check(
        'S_WFEARLY',
        'child notice consumed before dispatch lineage; exact mapping then synthesis and response',
        true,
        {
          workflowId,
          earlyChildId: earlyId,
          earlyNoticeAt: early.at,
          dispatchNoticeAt: dispatch.at,
          dispatchChildStatus: child.status,
          synthesisAt: synthesis.at,
          responseAt: settledAt,
          childNotices: childNotices.length,
          synthesisChunk,
          responseIndex
        }
      )
    }
  },
  {
    name: 'S_WFCANCEL',
    timeoutMs: 150_000,
    async drive({ client, sessionId, root, prompt, records, wait, launchRow, providerRow, check }) {
      assert.equal((await prompt('/eval-foreign')).stopReason, 'end_turn')
      const foreign = await wait(rows => rows.find(row => row.event === 'foreign-spawn'), 'foreign spawn reply')
      const foreignDetails = foreign.reply?.data?.details ?? foreign.reply?.data
      await wait(
        rows => rows.find(row => row.event === 'leaf-live' && row.marker === 'LEAF_GATED:foreign'),
        'foreign gated leaf live'
      )
      const turn = prompt('S_WFCANCEL')
      const launched = await launchRow()
      const workflowId = launched.details.asyncId
      const dispatched = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'custom' &&
              row.customType === 'subagent-notify' &&
              row.details?.runs?.some(run => run.runId === workflowId)
          ),
        'workflow dispatch notice consumed'
      )
      const child = dispatched.details.runs
        .find(entry => entry.runId === workflowId)
        .childRuns.find(entry => entry.status === 'running')
      await providerRow('WORKFLOW_ACK:wfcancel')
      await wait(
        rows => rows.find(row => row.event === 'leaf-live' && row.marker === 'LEAF_GATED:wfcancel'),
        'promoted child live'
      )
      await sleep(1_000)
      client.notify('session/cancel', { sessionId })
      const result = await turn
      assert.equal(result.stopReason, 'cancelled')
      const stops = (await records()).filter(row => row.event === 'stop-reply')
      assert.ok(
        stops.some(row => row.request.params.id === child.runId && row.reply.success),
        'cancellation stops the promoted child of the completed dispatch root'
      )
      assert.ok(
        stops.every(
          row => row.request.params.id !== foreignDetails?.runId && row.request.params.id !== foreignDetails?.asyncId
        ),
        'no stop targets foreign work'
      )
      const leafEnd = await wait(
        rows => rows.find(row => row.event === 'leaf-settled' && row.marker === 'LEAF_GATED:wfcancel'),
        'stopped child settles'
      )
      assert.equal(leafEnd.aborted, true, 'the child was aborted, not released')
      assert.equal(leafEnd.gateReleased, false)
      const foreignPid = await (async () => {
        for (let attempt = 0; attempt < 50 && foreignDetails?.asyncDir; attempt++) {
          try {
            const status = JSON.parse(await readFile(join(foreignDetails.asyncDir, 'status.json'), 'utf8'))
            if (Number.isInteger(status.pid) && status.pid > 0) return status.pid
          } catch {
            /* The runner may not have written its status file yet. */
          }
          await sleep(100)
        }
      })()
      assert.ok(Number.isInteger(foreignPid), 'the foreign runner pid is required for survival proof')
      assert.ok(isLive(foreignPid), 'the foreign runner survives the cancellation')
      await writeFile(join(root, 'release-foreign'), 'release')
      const deadline = Date.now() + 20_000
      while (isLive(foreignPid) && Date.now() < deadline) await sleep(25)
      assert.ok(!isLive(foreignPid), 'the foreign runner drains after its release')
      check('S_WFCANCEL', 'cancel stops the promoted workflow child; foreign runner survives then drains', true, {
        workflowId,
        childRunId: child.runId,
        stops: stops.map(row => row.request.params.id),
        leafAborted: leafEnd.aborted,
        gateReleased: leafEnd.gateReleased,
        foreignPid
      })
    }
  },
  {
    name: 'S_ENTRY',
    batch: { enabled: true, debounceMs: 4000, maxWaitMs: 4000 },
    timeoutMs: 120_000,
    async drive({ client, prompt, wait, launchRow, noticeRow, providerRow, check }) {
      const turn = prompt('S_ENTRY')
      const launched = await launchRow()
      const id = launched.details.asyncId
      // The debounced notice queues while the barrier is open: it appears in the boundary's
      // pending preview while the handler chain is still returning, and the stock's wake
      // acceptance lands it together with the probe. Another extension's awaited settlement
      // handler then holds the boundary open with the notice queued.
      const boundary = await wait(
        rows => rows.find(row => row.event === 'boundary' && row.scenario === 'S_ENTRY' && row.pending > 0),
        'boundary row with a queued notice'
      )
      assert.ok(boundary.pending >= 1, 'the notice was queued at the boundary')
      const notice = await noticeRow(id)
      assert.ok(
        notice.at - boundary.at >= 2_400,
        'the queued notice is consumed only after the boundary handlers return'
      )
      await providerRow('FINAL_SYNTHESIS:entry')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = client.messages.findIndex(
        message =>
          message.method === 'session/update' &&
          message.params.update.sessionUpdate === 'agent_message_chunk' &&
          message.params.update.content?.text?.includes('FINAL_SYNTHESIS:entry')
      )
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex)
      check('S_ENTRY', 'notice queued during the barrier consumed after every handler returns', true, {
        pendingAtBoundary: boundary.pending,
        continuedWithDraft: boundary.entries.includes('pi-acp-completion-wait'),
        boundaryAt: boundary.at,
        noticeAt: notice.at
      })
    }
  },
  {
    name: 'S_CANCEL',
    async drive({ client, sessionId, root, prompt, records, wait, launchRow, check }) {
      assert.equal((await prompt('/eval-foreign')).stopReason, 'end_turn')
      const foreign = await wait(rows => rows.find(row => row.event === 'foreign-spawn'), 'foreign spawn reply')
      const foreignLeaf = await wait(
        rows => rows.find(row => row.event === 'leaf-live' && row.marker === 'LEAF_GATED:foreign'),
        'foreign gated leaf live'
      )
      assert.ok(foreignLeaf, 'a foreign async run is live without any ACP capture')
      const turn = prompt('S_CANCEL')
      const launched = await launchRow()
      const id = launched.details.asyncId
      // The boundary row is only observable after the adapter's handler returns, so the
      // suspended barrier is proven by the held prompt: the yield was sent, the required
      // root is gated-live, and the ACP prompt stays unresolved past a settle delay.
      const yieldAt = (
        await wait(
          rows => rows.find(row => row.event === 'provider' && row.response?.includes('EARLY_YIELD:cancel')),
          'early yield sent'
        )
      ).at
      await wait(
        rows => rows.find(row => row.event === 'leaf-live' && row.marker === 'LEAF_GATED:cancel'),
        'gated required root live'
      )
      let settled = false
      void turn.then(
        () => (settled = true),
        () => (settled = true)
      )
      await sleep(2000)
      assert.equal(settled, false, 'the barrier is suspended while the required root runs')
      const suspendElapsed = Date.now() - yieldAt
      const cancelAt = Date.now()
      client.notify('session/cancel', { sessionId })
      const result = await turn
      assert.equal(result.stopReason, 'cancelled')
      const cancelElapsed = Date.now() - cancelAt
      assert.ok(cancelElapsed < 6000, `the owner cancel must wake the suspended barrier promptly (${cancelElapsed}ms)`)
      const stop = await wait(rows => rows.find(row => row.event === 'stop-reply'), 'exact stop request')
      assert.equal(stop.request.params.id, id, 'cancellation stops exactly the required root')
      assert.equal(stop.reply.success, true)
      const foreignDetails = foreign.reply?.data?.details ?? foreign.reply?.data
      const foreignId = foreignDetails?.runId ?? foreignDetails?.asyncId
      const stops = (await records()).filter(row => row.event === 'stop-reply')
      assert.ok(
        stops.every(row => row.request.params.id === id),
        'no stop may target foreign work'
      )
      const leafEnd = await wait(
        rows => rows.find(row => row.event === 'leaf-settled' && row.marker === 'LEAF_GATED:cancel'),
        'stopped leaf settles aborted'
      )
      assert.equal(leafEnd.aborted, true)
      assert.equal(leafEnd.gateReleased, false)
      const warning = client.updates.some(
        update =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content?.text?.includes('detached work may still be running')
      )
      assert.equal(warning, false, 'exact owned proof needs no detached-work warning')
      check('S_CANCEL', 'cancel wakes the suspended barrier and stops only the exact required root', true, {
        asyncId: id,
        suspendElapsedMs: suspendElapsed,
        cancelElapsedMs: cancelElapsed,
        foreignId
      })
      // The foreign run survived cancellation and delivers autonomously after its release.
      const foreignPid = await (async () => {
        const dir = foreignDetails?.asyncDir
        if (!dir) return undefined
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'))
            if (Number.isInteger(status.pid) && status.pid > 0) return status.pid
          } catch {
            /* The runner may not have written its status file yet. */
          }
          await sleep(100)
        }
        return undefined
      })()
      if (Number.isInteger(foreignPid)) {
        assert.ok(isLive(foreignPid), 'the foreign runner must survive the exact cancellation')
        await writeFile(join(root, 'release-foreign'), 'release')
        // The stock delivers completions only to their owning epoch; the cancellation
        // transaction may have rotated it, so the autonomous chunk is recorded, not required.
        const chunk = () =>
          client.updates.some(
            update =>
              update.sessionUpdate === 'agent_message_chunk' && update.content?.text?.includes('FINAL_SYNTHESIS:cancel')
          )
        const deadline = Date.now() + 20_000
        while (isLive(foreignPid) && Date.now() < deadline) await sleep(25)
        assert.ok(!isLive(foreignPid), 'the foreign runner must drain after its release')
        check('S_CANCEL', 'foreign run survives the exact cancellation and drains after release', true, {
          foreignPid,
          autonomousDeliveryObserved: chunk()
        })
      } else
        check('S_CANCEL', 'foreign runner pid is available for survival proof', false, { foreignReply: foreign.reply })
    }
  },
  {
    name: 'S_NESTED',
    timeoutMs: 120_000,
    async drive({ client, root, prompt, wait, launchRow, noticeRow, providerRow, check }) {
      let settled = false
      const turn = prompt('S_NESTED').then(result => {
        settled = true
        return result
      })
      const launched = await launchRow()
      const id = launched.details.asyncId
      // Real three-process chain: adapter Pi -> async root Pi (eval-root) -> nested leaf Pi.
      // git-main keeps the root job running until its subtree drains, so the live nested
      // descendant manifests as the required root staying live.
      const nestedLaunch = await wait(
        rows =>
          rows.find(row => row.event === 'tool_result' && row.toolName === 'subagent' && row.pid !== launched.pid),
        'nested leaf launch inside the root run'
      )
      const nestedId = nestedLaunch.details.asyncId
      await wait(
        rows => rows.find(row => row.event === 'leaf-live' && row.marker === 'LEAF_GATED:nested'),
        'nested leaf live'
      )
      await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'snapshot' &&
              JSON.stringify(row.runs).includes(id) &&
              JSON.stringify(row.runs).includes('"state":"running"')
          ),
        'required root live in the status snapshot'
      )
      await sleep(1_500)
      assert.equal(settled, false, 'the live nested descendant keeps the required root running and holds the prompt')
      check('S_NESTED', 'nested async descendant holds the foreground through its live subtree', true, {
        rootId: id,
        nestedId
      })
      // Draining the nested leaf lets the root runner finish; its structured completion
      // notice then names the exact root. git-main single-agent roots report no childRuns:
      // the subtree drain itself is what held the root live.
      await writeFile(join(root, 'release-nested'), 'release')
      const leafEnd = await wait(
        rows => rows.find(row => row.event === 'leaf-settled' && row.marker === 'LEAF_GATED:nested'),
        'nested leaf drained'
      )
      const notice = await noticeRow(id)
      const run = notice.details.runs.find(entry => entry.runId === id)
      assert.ok(run, 'the root notice is structured for the exact root run')
      assert.ok(leafEnd.at < notice.at, 'the nested descendant drained before the root completion notice')
      const synthesis = await providerRow('FINAL_SYNTHESIS:nested')
      assert.ok(synthesis.notice && synthesis.at >= notice.at, 'the distinct synthesis responds to the root notice')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      const yieldChunk = indexChunk(client, 'NESTED_YIELD')
      const synthesisChunk = indexChunk(client, 'FINAL_SYNTHESIS:nested')
      assert.ok(yieldChunk >= 0 && yieldChunk < synthesisChunk && synthesisChunk < responseIndex)
      check('S_NESTED', 'descendant drain, root delivery and synthesis precede the response', true, {
        synthesisChunk,
        responseIndex,
        rootNotice: { runId: run?.runId, childRuns: run?.childRuns },
        nestedId
      })
    }
  },
  {
    name: 'S_TWO',
    async drive({ client, root, prompt, wait, noticeRow, providerRow, check }) {
      let settled = false
      const turn = prompt('S_TWO').then(result => {
        settled = true
        return result
      })
      const launches = await wait(rows => {
        const found = rows.filter(row => row.event === 'tool_result' && row.toolName === 'subagent')
        return found.length >= 2 ? found : undefined
      }, 'two stock launches')
      const [twoa, twob] = launches.map(row => row.details.asyncId)
      await providerRow('TWO_YIELD')
      await noticeRow(twoa)
      await providerRow('NOTICE_ACK:LEAF_DONE:twoa')
      assert.equal(settled, false, 'partial delivery must not release the prompt')
      await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'snapshot' &&
              JSON.stringify(row.runs).includes(twoa) &&
              JSON.stringify(row.runs).includes(twob) &&
              JSON.stringify(row.runs).includes('"state":"running"')
          ),
        'partial roots snapshot: one delivered, one running'
      )
      check('S_TWO', 'terminal delivered root coexists with a running required root', true, { twoa, twob })
      await writeFile(join(root, 'release-twob'), 'release')
      await noticeRow(twob)
      await providerRow('LEAF_DONE:twob')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      for (const text of ['NOTICE_ACK:LEAF_DONE:twoa', 'LEAF_DONE:twob']) {
        const chunkIndex = client.messages.findIndex(
          message =>
            message.method === 'session/update' &&
            message.params.update.sessionUpdate === 'agent_message_chunk' &&
            message.params.update.content?.text?.includes(text)
        )
        assert.ok(chunkIndex >= 0 && chunkIndex < responseIndex, `${text} must precede the response`)
      }
      check('S_TWO', 'both notices acknowledged before the response', true, { twoa, twob })
    }
  },
  {
    name: 'S_CHAIN',
    async drive({ client, prompt, wait, launchRow, noticeRow, providerRow, check }) {
      const turn = prompt('S_CHAIN')
      const first = await launchRow()
      await providerRow('CHAIN_YIELD')
      const chaina = first.details.asyncId
      await noticeRow(chaina)
      // The continuation launches a NEW required root; the fresh capture resets ownership.
      const second = await wait(rows => {
        const found = rows.filter(row => row.event === 'tool_result' && row.toolName === 'subagent')
        return found.length >= 2 ? found[1] : undefined
      }, 'second stock launch from the continuation')
      const chainb = second.details.asyncId
      assert.notEqual(chainb, chaina)
      await noticeRow(chainb)
      await providerRow('FINAL_SYNTHESIS:chain')
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const responseIndex = promptResponseIndexOf(client)
      const synthesisChunk = client.messages.findIndex(
        message =>
          message.method === 'session/update' &&
          message.params.update.sessionUpdate === 'agent_message_chunk' &&
          message.params.update.content?.text?.includes('FINAL_SYNTHESIS:chain')
      )
      assert.ok(synthesisChunk >= 0 && synthesisChunk < responseIndex)
      check('S_CHAIN', 'a new root launched by the continuation stays required through delivery', true, {
        chaina,
        chainb
      })
    }
  },
  {
    name: 'S_DETACH',
    timeoutMs: 150_000,
    async drive({ client, sessionId, root, prompt, records, wait, launchRow, providerRow, check }) {
      const turn = prompt('S_DETACH')
      const launched = await launchRow()
      const id = launched.details.asyncId
      const detachRows = rows => rows.filter(row => row.event === 'tool_result' && row.toolName === 'acp_detach')
      // The model first sends an empty batch: real Pi rejects it against the tool's JSON
      // schema before execution, so no extension tool_result event exists for it. That
      // pre-execution rejection is proven by the empty-batch provider row being followed
      // by the next provider call with no intervening dispatched acp_detach result.
      const emptyCall = await wait(
        rows => rows.find(row => row.event === 'provider' && row.response?.includes('acp_detach({"runIds":[]})')),
        'empty-batch acp_detach call'
      )
      const results = await wait(
        rows => (detachRows(rows).length >= 2 ? detachRows(rows) : undefined),
        'both dispatched acp_detach results'
      )
      const [atomic, valid] = results
      assert.ok(
        atomic.at > emptyCall.at && !results.some(row => row.at < atomic.at && row.at > emptyCall.at),
        'the schema-invalid empty batch was never dispatched'
      )
      assert.ok(
        atomic.isError &&
          /ffffffff-ffff-4fff-8fff-ffffffffffff/.test(JSON.stringify(atomic.content)) &&
          /nothing was detached/i.test(JSON.stringify(atomic.content)),
        'a valid+foreign batch must be rejected atomically'
      )
      assert.equal(valid.isError, false, 'the exact owned batch detaches')
      assert.ok(JSON.stringify(valid.details).includes(id))
      check('S_DETACH', 'acp_detach exercises real schema dispatch with atomic batch validation', true, {
        asyncId: id,
        schemaRejectedBatch: 'runIds: [] (pre-execution JSON-schema rejection, no dispatch)',
        atomic: atomic.content
      })
      const detachedOkAt = (await providerRow('DETACHED_OK')).at
      const result = await turn
      assert.equal(result.stopReason, 'end_turn')
      const detachedElapsed = Date.now() - detachedOkAt
      assert.ok(detachedElapsed < 15_000, `the detached prompt must return promptly (${detachedElapsed}ms)`)
      const runnerPid = JSON.parse(await readFile(join(launched.details.asyncDir, 'status.json'), 'utf8')).pid
      assert.ok(Number.isInteger(runnerPid) && isLive(runnerPid), 'the detached runner survives the prompt')
      check('S_DETACH', 'explicit detach releases the prompt promptly while the run survives', true, {
        runnerPid,
        detachedElapsedMs: detachedElapsed
      })
      await client.request('session/close', { sessionId })
      assert.ok(isLive(runnerPid), 'the detached runner survives session close')
      check('S_DETACH', 'detached runner survives session close', true, { runnerPid })
      const originalSession = (await records()).find(row => row.event === 'session')
      await client.request('session/resume', { sessionId, cwd: root, mcpServers: [] })
      const resumedSession = await wait(
        rows =>
          rows.find(
            row =>
              row.event === 'session' && row.sessionId === originalSession.sessionId && row.pid !== originalSession.pid
          ),
        'resumed pi process'
      )
      assert.equal(resumedSession.sessionId, originalSession.sessionId)
      const restored = prompt('PLAIN question on the restored session')
      const restoredRow = await providerRow('RESUMED_PLAIN')
      assert.equal((await restored).stopReason, 'end_turn')
      assert.ok(
        restoredRow.systemSentinel && restoredRow.systemPolicy && resumedSession.cliAppend === false,
        'resumed requests keep the discovered APPEND_SYSTEM.md content and policy'
      )
      const stops = (await records()).filter(row => row.event === 'stop-reply')
      assert.equal(stops.length, 0, 'the restored prompt must not stop detached work')
      check('S_DETACH', 'resumed session admits ordinary work without adopting or stopping detached runs', true, {
        runnerPid,
        resumedPid: resumedSession.pid
      })
      await writeFile(join(root, 'release-detached'), 'release')
      // The restored runner may deliver through the resumed stock binding; its drain is the
      // owned claim, the autonomous delivery is recorded as observed stock behavior.
      const restoredResponseIndex = promptResponseIndexOf(client)
      let autonomousDeadline = Date.now() + 15_000
      let autonomousDelivery = false
      while (Date.now() < autonomousDeadline) {
        if (indexChunk(client, 'RESUMED_PLAIN', restoredResponseIndex + 1) >= 0) {
          autonomousDelivery = true
          break
        }
        await sleep(25)
      }
      const drainDeadline = Date.now() + 20_000
      while (isLive(runnerPid) && Date.now() < drainDeadline) await sleep(25)
      assert.ok(!isLive(runnerPid), 'the detached runner must drain after its release')
      check('S_DETACH', 'detached runner drains after release without any stop request', true, {
        runnerPid,
        autonomousDeliveryObserved: autonomousDelivery
      })
    }
  },
  {
    name: 'S_UNSTRUCTURED',
    async drive({ client, prompt, records, wait, launchRow, check }) {
      const session = await wait(rows => rows.find(row => row.event === 'session'), 'session row')
      const failure = prompt('S_UNSTRUCTURED')
      await launchRow()
      const synthetic = await wait(
        rows => rows.find(row => row.event === 'custom' && row.content?.includes('SYNTHETIC_UNSTRUCTURED_NOTICE')),
        'synthetic fixture-injected unstructured notice'
      )
      assert.ok(
        synthetic,
        'the unstructured negative is a public fixture-injected message, not a historical runner claim'
      )
      await assert.rejects(failure, /lacks structured run IDs/, 'missing structured metadata must fail visibly')
      const attribution = client.updates.find(
        update =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content?.text?.includes('Background harness: pi-subagents completion notice lacks structured run IDs')
      )
      assert.ok(attribution, 'the owner failure must be attributed as a visible message chunk')
      check('S_UNSTRUCTURED', 'synthetic unstructured notice fails the exact owner visibly', true, {
        syntheticNotice: 'SYNTHETIC_UNSTRUCTURED_NOTICE (public fixture sendMessage; not a 0.67 runner claim)'
      })
      const recovery = await prompt('S_UNSTRUCTURED follow-up after the failure')
      assert.equal(recovery.stopReason, 'end_turn')
      const afterRows = (await records()).filter(row => row.event === 'provider')
      assert.ok(afterRows.some(row => row.pid === session.pid && row.response.includes('UNSTRUCTURED_YIELD')))
      check('S_UNSTRUCTURED', 'the failed owner keeps its channel; a later prompt works on the same process', true, {
        pid: session.pid
      })
    }
  },
  {
    name: 'S_DEADLINE',
    batch: { enabled: true, debounceMs: 40_000, maxWaitMs: 40_000 },
    timeoutMs: 150_000,
    async drive({ client, prompt, records, wait, waitForUpdate, launchRow, providerRow, check }) {
      const terminalRoot = prompt('S_DEADLINE')
      const launched = await launchRow()
      const id = launched.details.asyncId
      await providerRow('EARLY_YIELD:deadline')
      const rejection = await terminalRoot.then(
        () => assert.fail('a missing delivery within the deadline must fail, never succeed'),
        error => error
      )
      assert.match(String(rejection), /was not consumed within 30s of terminal status/)
      const probeRows = (await records()).filter(row => row.event === 'provider' && row.probe)
      assert.ok(probeRows.length >= 20, 'the deadline window is spanned by bounded probes')
      assert.ok(probeRows.length <= 30, 'probes are capped at 30 per terminal capture')
      for (let index = 1; index < probeRows.length; index++)
        assert.ok(probeRows[index].at - probeRows[index - 1].at >= 900, 'probe cadence stays at one per second')
      check('S_DEADLINE', 'missing delivery inside the 30s window fails with bounded probe cadence and count', true, {
        asyncId: id,
        probeCount: probeRows.length
      })
      // The stock's idle-parent wake runs autonomously after the failed turn: the notice is
      // appended without message_start and PARENT_WAKE_TEXT is steered as the runnable input.
      const before = client.messages.length
      const rejectionAt = Date.now()
      await waitForUpdate(
        update =>
          update.sessionUpdate === 'agent_message_chunk' && update.content?.text?.includes('WAKE_SYNTHESIS:deadline'),
        'late autonomous wake synthesis after the failed turn'
      )
      const wakeStart = await wait(
        rows => rows.find(row => row.event === 'agent_start' && row.at >= rejectionAt),
        'autonomous agent run after the failure'
      )
      const lateIndex = client.messages.findIndex(
        (message, index) =>
          index >= before &&
          message.method === 'session/update' &&
          chunk('WAKE_SYNTHESIS:deadline')(message.params.update)
      )
      assert.ok(lateIndex >= 0)
      const promptsAfter = client.messages.slice(before).filter(message => message.method === 'session/prompt').length
      assert.equal(promptsAfter, 0, 'the late wake must not synthesize a new prompt')
      check('S_DEADLINE', 'late completion wake runs autonomously after the visible failure', true, {
        lateIndex,
        wakeStartAt: wakeStart.at,
        rejectionAt
      })
    }
  }
]

const selected = scenarios.filter(
  scenario => !process.env.PI_ACP_EVAL_SCENARIO || scenario.name === process.env.PI_ACP_EVAL_SCENARIO
)
if (process.env.PI_ACP_EVAL_SCENARIO)
  assert.ok(selected.length === 1, `Unknown scenario ${process.env.PI_ACP_EVAL_SCENARIO}`)
for (const scenario of selected) await runScenario(scenario)
identity.after = verifyStock('after tests')
const destination = process.env.PI_ACP_EVAL_LOG_DIR
if (destination) {
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'completion-checks.json'), JSON.stringify({ identity, checks }, null, 2) + '\n')
}
assert.ok(
  checks.every(entry => entry.passed),
  'Completion evaluation failures (see checks above)'
)
console.log(
  `Owned-completion evaluation passed on pi ${identity.piVersion} with pi-subagents git ${identity.before.head} loaded via ${identity.declaredEntry}.`
)
console.log(
  'Evidence limits: bounded probes may add provider calls; completion and supervisor delivery each use a 30s window; workflow async children are delivered only by their native notice (bg_wait is not delivery); automatic steering recovery is not reproduced; no live Zed/Windows client was driven.'
)
