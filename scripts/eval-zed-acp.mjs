import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { withSmokeAgent } from './smoke-client.mjs'

// Actual built ACP stdio + installed Pi; only the provider and extension work are deterministic.
const root = await mkdtemp(join(tmpdir(), 'pi-acp-zed-eval-'))
const pi = process.env.PI_ACP_EVAL_PI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
const tracePath = join(root, 'pi.jsonl')
const wrapper = join(root, 'pi-wrapper.mjs')
const acpWrapper = join(root, 'acp-wrapper.mjs')
const acpTracePath = join(root, 'acp.jsonl')
await mkdir(join(root, '.pi', 'extensions'), { recursive: true })
await mkdir(join(root, 'agent'), { recursive: true })
await writeFile(
  join(root, '.pi', 'extensions', 'eval.ts'),
  await readFile(new URL('./fixtures/zed-harness-extension.ts', import.meta.url))
)
await writeFile(
  join(root, 'agent', 'settings.json'),
  JSON.stringify({
    defaultProvider: 'acp-eval',
    defaultModel: 'local',
    compaction: { reserveTokens: 10, keepRecentTokens: 10 }
  })
)
await writeFile(
  wrapper,
  `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('--version')) args.push('--extension', ${JSON.stringify(join(root, '.pi', 'extensions', 'eval.ts'))});
const child = spawn(${JSON.stringify(pi)}, args, { stdio: ['pipe','pipe','inherit'] });
function trace(stream, direction, target) {
 let buffer = ''; stream.on('data', chunk => { target.write(chunk); buffer += chunk; let i;
 while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0,i); buffer = buffer.slice(i+1); try { appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({time: Date.now(), direction, ...JSON.parse(line)})+'\\n'); } catch {} }
 });
}
trace(process.stdin, 'in', child.stdin); trace(child.stdout, 'out', process.stdout);
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`,
  { mode: 0o755 }
)
await writeFile(
  acpWrapper,
  `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(process.execPath, [${JSON.stringify(resolve('dist/index.js'))}], { stdio: ['pipe','pipe','inherit'] });
function trace(stream, direction, target) {
 let buffer = ''; stream.on('data', chunk => { target.write(chunk); buffer += chunk; let i;
 while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0,i); buffer = buffer.slice(i+1); try { appendFileSync(${JSON.stringify(acpTracePath)}, JSON.stringify({time: Date.now(), direction, ...JSON.parse(line)})+'\\n'); } catch {} }
 });
}
trace(process.stdin, 'in', child.stdin); trace(child.stdout, 'out', process.stdout);
process.stdin.on('end', () => child.stdin.end());
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`
)
const trace = async () =>
  (await readFile(tracePath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitTrace = async (predicate, after = 0) => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const records = (await trace()).slice(after)
    const record = records.find(predicate)
    if (record) return record
    assert.ok(Date.now() < deadline, 'Expected correlated Pi event')
    await sleep(5)
  }
}
const backgroundActive = event =>
  event.widgetKey === 'pi-acp-lifecycle' && JSON.parse(event.widgetLines[0]).state === 'active'
const checks = []
const check = (name, passed) => {
  checks.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
}
let holdPermission = false
let permissionSeen
let lastPermission
let acpMessages = []
let stopsBeforeDisconnect = 0
try {
  await withSmokeAgent(
    async client => {
      acpMessages = client.messages
      await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'zed-eval', version: '1' },
        clientCapabilities: { elicitation: { form: {} }, _meta: { terminal_output: true } }
      })
      const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
      const prompt = text => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      const texts = () =>
        client.updates
          .filter(u => u.sessionUpdate === 'agent_message_chunk')
          .map(u => u.content.text)
          .join('\n')
      assert.equal((await prompt('/eval-confirm')).stopReason, 'end_turn')
      check('preacceptance confirm reaches ACP permission', texts().includes('CONFIRMED:true'))
      assert.equal((await prompt('/eval-input')).stopReason, 'end_turn')
      check('preacceptance input reaches negotiated form', texts().includes('INPUT:typed'))
      const beforeDisplay = (await trace()).filter(e => e.type === 'extension_ui_response').length
      assert.equal((await prompt('/eval-display')).stopReason, 'end_turn')
      await sleep(100)
      check(
        'fire-and-forget UI has no RPC replies',
        (await trace()).filter(e => e.type === 'extension_ui_response').length === beforeDisplay
      )
      check('notification is visible', texts().includes('DISPLAY_NOTICE'))
      const initialResponseCount = texts().split('HARNESS_RESPONSE').length
      const identity = JSON.parse((await trace()).find(e => e.statusKey === 'eval-session').statusText)
      assert.ok(identity.id && identity.file)
      assert.ok(!(await readFile(identity.file, 'utf8')).includes('"role":"assistant"'))
      let restoredIdentity
      let recovery
      for (let i = 0; i < 2; i++) {
        holdPermission = true
        const seen = new Promise(resolve => {
          permissionSeen = resolve
        })
        const active = prompt('/eval-confirm')
        await seen
        const queued = prompt('/eval-display')
        await sleep(50)
        client.notify('session/cancel', { sessionId })
        assert.equal((await active).stopReason, 'cancelled')
        assert.equal((await queued).stopReason, 'cancelled')
        client.respond(lastPermission.id, { outcome: { outcome: 'selected', optionId: 'yes' } })
        holdPermission = false
        recovery = await prompt('/eval-confirm')
        assert.equal(recovery.stopReason, 'end_turn')
        restoredIdentity = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
        assert.equal(restoredIdentity.id, identity.id)
        assert.equal(restoredIdentity.file, identity.file)
        assert.ok(!(await readFile(identity.file, 'utf8')).includes('"role":"assistant"'))
      }
      check('repeated UI cancel clears FIFO and allows re-prompt', recovery.stopReason === 'end_turn')
      check(
        'pending ACP permission requests are explicitly cancelled',
        client.messages.some(message => message.method === '$/cancel_request')
      )
      check(
        'fresh preflight-only session survives quarantine and restore',
        restoredIdentity.file === identity.file && restoredIdentity.pid !== identity.pid
      )
      holdPermission = true
      const timeoutSeen = new Promise(resolve => {
        permissionSeen = resolve
      })
      const timeoutStart = (await trace()).length
      const timed = prompt('/eval-timeout')
      await timeoutSeen
      const expiredPermission = lastPermission
      assert.equal((await timed).stopReason, 'end_turn')
      assert.ok(texts().includes('TIMEOUT_DEFAULT:false'), 'real Pi resolves the timed confirm to its native default')
      const expiredCard = expiredPermission.params.toolCall.toolCallId
      const completedCards = () =>
        client.updates.filter(
          u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === expiredCard && u.status === 'completed'
        )
      // The adapter's deadline begins at event receipt, after native transport.
      const expiryDeadline = Date.now() + 5000
      while (
        !client.messages.some(m => m.method === '$/cancel_request' && m.params.requestId === expiredPermission.id) ||
        completedCards().length === 0
      ) {
        assert.ok(Date.now() < expiryDeadline, 'native dialog expiry must cancel ACP and complete its card')
        await sleep(5)
      }
      assert.equal(completedCards().length, 1)
      client.respond(expiredPermission.id, { outcome: { outcome: 'selected', optionId: 'yes' } })
      holdPermission = false
      assert.equal((await prompt('/eval-display')).stopReason, 'end_turn')
      const timeoutRecords = (await trace()).slice(timeoutStart)
      const nativeDialog = timeoutRecords.find(e => e.type === 'extension_ui_request' && e.title === 'Harness timeout')
      assert.ok(nativeDialog)
      assert.ok(
        !timeoutRecords.some(
          e => e.direction === 'in' && e.type === 'extension_ui_response' && e.id === nativeDialog.id
        ),
        'expiry and late acceptance must not write to an expired native dialog'
      )
      assert.equal(completedCards().length, 1, 'late acceptance does not complete the card twice')
      check('native timeout defaults, cancels ACP and suppresses late answers without stale Pi replies', true)
      const native = prompt('native queue')
      const queueDeadline = Date.now() + 5000
      while (!(await trace()).some(e => e.type === 'queue_update' && e.followUp?.includes('NATIVE_QUEUED'))) {
        assert.ok(Date.now() < queueDeadline, 'Pi native follow-up should queue')
        await sleep(5)
      }
      client.notify('session/cancel', { sessionId })
      assert.equal((await native).stopReason, 'cancelled')
      await sleep(150)
      check(
        'clear_queue prevents native follow-up consumption after abort',
        !(await trace()).some(
          e =>
            e.type === 'message_start' &&
            e.message?.role === 'user' &&
            JSON.stringify(e.message.content).includes('NATIVE_QUEUED')
        )
      )
      const asyncStart = (await trace()).length
      let settled = false
      const asyncTurn = prompt('launch async').then(result => {
        settled = true
        return result
      })
      await waitTrace(backgroundActive, asyncStart)
      const terminal = await waitTrace(e => e.statusKey === 'eval-terminal', asyncStart)
      assert.equal((await asyncTurn).stopReason, 'end_turn')
      check('ACP releases foreground independently of terminal-pending-delivery child', settled)
      const idleChildStart = (await trace()).length
      assert.equal((await prompt('ordinary question while child is live')).stopReason, 'end_turn')
      check(
        'idle model admits ordinary input without adopting live child',
        !(await trace()).slice(idleChildStart).some(e => e.statusKey === 'eval-stopped')
      )
      await writeFile(join(root, 'deliver-async'), terminal.statusText)
      await waitTrace(e => e.type === 'agent_settled', (await trace()).length)
      check(
        'real Pi emits delayed subagent-contract message',
        (await trace()).some(e => e.type === 'message_end' && e.message?.content === 'ASYNC_COMPLETION')
      )
      check('async completion delivered without another prompt', texts().includes('ASYNC_COMPLETION'))
      check(
        'async triggered assistant response delivered',
        texts().split('HARNESS_RESPONSE').length > initialResponseCount + 1
      )
      const busyIdentity = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
      const busyStart = (await trace()).length
      assert.equal((await prompt('/eval-hold-autonomous')).stopReason, 'end_turn')
      const heldLaunch = prompt('launch async')
      const heldTerminal = await waitTrace(e => e.statusKey === 'eval-terminal', busyStart)
      assert.equal((await heldLaunch).stopReason, 'end_turn')
      await writeFile(join(root, 'deliver-async'), heldTerminal.statusText)
      await waitTrace(
        e => e.type === 'message_update' && e.assistantMessageEvent?.delta === 'AUTONOMOUS_PROGRESS',
        busyStart
      )
      const busyQuestionStart = (await trace()).length
      const withdrawn = prompt('withdraw this ordinary question')
      await waitTrace(
        e => e.widgetKey === 'pi-acp-lifecycle' && JSON.parse(e.widgetLines[0]).state === 'waiting',
        busyQuestionStart
      )
      client.notify('session/cancel', { sessionId })
      assert.equal((await withdrawn).stopReason, 'cancelled')
      const withdrawalRecords = (await trace()).slice(busyQuestionStart)
      assert.ok(!withdrawalRecords.some(e => e.direction === 'in' && ['abort', 'clear_queue'].includes(e.type)))
      assert.ok(!withdrawalRecords.some(e => e.direction === 'in' && e.message === 'withdraw this ordinary question'))
      const admittedAt = Date.now()
      const busyQuestion = prompt('ordinary question after autonomous progress')
      await waitTrace(
        e => e.widgetKey === 'pi-acp-lifecycle' && JSON.parse(e.widgetLines[0]).state === 'waiting',
        busyQuestionStart + withdrawalRecords.length
      )
      await sleep(100)
      assert.ok(texts().includes('AUTONOMOUS_PROGRESS'))
      assert.ok(texts().includes('Input queued'))
      await writeFile(join(root, 'finish-autonomous'), 'release')
      assert.equal((await busyQuestion).stopReason, 'end_turn')
      const admittedRecords = (await trace()).slice(busyQuestionStart)
      const userPrompt = admittedRecords.find(
        e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress'
      )
      assert.ok(userPrompt && !('streamingBehavior' in userPrompt))
      assert.ok(
        admittedRecords.some(
          e =>
            e.type === 'message_start' &&
            e.message?.role === 'user' &&
            JSON.stringify(e.message.content).includes('ordinary question after autonomous progress')
        )
      )
      assert.equal(
        admittedRecords.filter(e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress')
          .length,
        1
      )
      assert.ok(admittedRecords.some(e => e.type === 'response' && e.id === userPrompt.id && e.success))
      assert.ok(admittedRecords.some(e => e.type === 'agent_settled'))
      assert.ok(Date.now() - admittedAt < 5000, 'delivery follows model settlement, not delegated pipeline drain')
      assert.equal((await prompt('/eval-confirm')).stopReason, 'end_turn')
      const busySurvivor = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
      assert.equal(busySurvivor.pid, busyIdentity.pid)
      console.log(`Staged native follow-up latency: ${Date.now() - admittedAt}ms; Pi PID survived: ${busySurvivor.pid}`)
      check(
        'real Pi autonomous progress, native staged admission, exact withdrawal and correlated follow-up survive on one subprocess',
        true
      )
      const raceStart = (await trace()).length
      assert.equal((await prompt('native admission race')).stopReason, 'end_turn')
      const raceRecords = (await trace()).slice(raceStart)
      const racedPrompts = raceRecords.filter(e => e.direction === 'in' && e.message === 'native admission race')
      assert.equal(racedPrompts.length, 2, 'one rejected preacceptance attempt plus one admitted dispatch')
      assert.ok(racedPrompts.every(e => !('streamingBehavior' in e)))
      assert.equal(
        raceRecords.filter(e => e.type === 'response' && racedPrompts.some(p => p.id === e.id) && e.success).length,
        1
      )
      assert.ok(
        raceRecords.some(
          e =>
            e.type === 'response' &&
            e.id === racedPrompts[0].id &&
            !e.success &&
            e.error.startsWith('Agent is already processing.')
        )
      )
      assert.ok(!raceRecords.some(e => e.direction === 'in' && ['abort', 'clear_queue'].includes(e.type)))
      check(
        'real Pi ready-to-raw race rejects then re-admits once without native queue insertion or foreign abort',
        true
      )
      const hookStart = (await trace()).length
      assert.equal((await prompt('/eval-settlement-gate')).stopReason, 'end_turn')
      const hookEntered = await waitTrace(e => e.statusKey === 'eval-hook-entered', hookStart)
      const hookIdentity = JSON.parse(hookEntered.statusText)
      let withdrawnOutcome
      const hookWithdrawn = prompt('withdraw during long native hook').then(
        result => {
          withdrawnOutcome = result
          return result
        },
        error => {
          withdrawnOutcome = error
          return error
        }
      )
      try {
        // Actual wall-clock native hook; not a fake timer or provider sleep.
        await sleep(31_100)
        assert.equal(withdrawnOutcome, undefined, 'healthy native settlement must not time out staged admission')
        const cancelAt = Date.now()
        client.notify('session/cancel', { sessionId })
        while (!withdrawnOutcome && Date.now() - cancelAt < 1000) await sleep(5)
        assert.equal(
          withdrawnOutcome?.stopReason,
          'cancelled',
          'local cancellation must not await deferred native withdraw'
        )
        assert.equal((await hookWithdrawn).stopReason, 'cancelled')
        const cancellationMs = Date.now() - cancelAt
        const newToken = prompt('new token after long native hook')
        await sleep(50)
        await writeFile(join(root, 'release-settlement-hook'), 'release')
        const released = await waitTrace(e => e.statusKey === 'eval-hook-released', hookStart)
        assert.ok(JSON.parse(released.statusText).elapsedMs > 30_000)
        await waitTrace(
          e => e.type === 'message_update' && e.assistantMessageEvent?.delta === 'DEFERRED_SYNTHESIS_PROGRESS',
          hookStart
        )
        const duringSynthesis = (await trace()).slice(hookStart)
        assert.ok(
          !duringSynthesis.some(
            e =>
              e.direction === 'in' &&
              ['withdraw during long native hook', 'new token after long native hook'].includes(e.message)
          )
        )
        await writeFile(join(root, 'finish-deferred-synthesis'), 'release')
        assert.equal((await newToken).stopReason, 'end_turn')
        assert.equal((await prompt('/eval-confirm')).stopReason, 'end_turn')
        const survivor = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
        assert.equal(survivor.pid, hookIdentity.pid)
        const hookRecords = (await trace()).slice(hookStart)
        assert.ok(!hookRecords.some(e => e.direction === 'in' && ['abort', 'clear_queue'].includes(e.type)))
        assert.equal(
          hookRecords.filter(e => e.direction === 'in' && e.message === 'withdraw during long native hook').length,
          0
        )
        const delivered = hookRecords.filter(
          e => e.direction === 'in' && e.message === 'new token after long native hook'
        )
        assert.equal(delivered.length, 1)
        assert.ok(hookRecords.some(e => e.type === 'response' && e.id === delivered[0].id && e.success))
        assert.ok(
          hookRecords.some(
            e =>
              e.type === 'message_start' &&
              e.message?.role === 'user' &&
              JSON.stringify(e.message.content).includes('new token after long native hook')
          )
        )
        console.log(
          `Native settlement hook held ${JSON.parse(released.statusText).elapsedMs}ms; local cancellation ${cancellationMs}ms; Pi PID ${survivor.pid} survived`
        )
        check(
          'actual native hook over 30 seconds and deferred synthesis preserve local withdrawal, new token, exact delivery and subprocess',
          true
        )
      } finally {
        await writeFile(join(root, 'release-settlement-hook'), 'release')
        await writeFile(join(root, 'finish-deferred-synthesis'), 'release')
      }
      const cancelStart = (await trace()).length
      const cancelledAsync = prompt('launch async')
      await waitTrace(backgroundActive, cancelStart)
      const queuedAsync = prompt('/eval-display')
      client.notify('session/cancel', { sessionId })
      assert.equal((await cancelledAsync).stopReason, 'cancelled')
      assert.equal((await queuedAsync).stopReason, 'cancelled')
      const countAfterCancel = texts().split('ASYNC_COMPLETION').length
      const stop = await waitTrace(e => e.statusKey === 'eval-stopped', cancelStart)
      const launched = (await trace())
        .slice(cancelStart)
        .find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent')
      assert.equal(stop.statusText, launched.result.details.asyncId)
      check(
        'cancel stops exact background work and queued follow-up',
        texts().split('ASYNC_COMPLETION').length === countAfterCancel
      )
      const lateStart = (await trace()).length
      const late = prompt('launch async late')
      await waitTrace(e => e.statusKey === 'eval-launching', lateStart)
      const lateQueued = prompt('/eval-display')
      client.notify('session/cancel', { sessionId })
      assert.equal((await late).stopReason, 'cancelled')
      assert.equal((await lateQueued).stopReason, 'cancelled')
      const lateRecords = (await trace()).slice(lateStart)
      const lateResult = lateRecords.findIndex(e => e.type === 'tool_execution_end' && e.toolName === 'subagent')
      assert.ok(lateResult > lateRecords.findIndex(e => e.direction === 'in' && e.type === 'abort'))
      check(
        'late tool_result during native abort is owned, stopped, and cancels FIFO',
        lateRecords.find(e => e.statusKey === 'eval-stopped').statusText ===
          lateRecords[lateResult].result.details.asyncId
      )
      assert.equal((await prompt('/eval-confirm')).stopReason, 'end_turn')
      holdPermission = true
      const compactSeen = new Promise(resolve => {
        permissionSeen = resolve
      })
      const compact = prompt('/compact')
      await compactSeen
      client.notify('session/cancel', { sessionId })
      assert.equal((await compact).stopReason, 'cancelled')
      holdPermission = false
      recovery = await prompt('/eval-confirm')
      check('cancel during real Pi compaction UI recovers', recovery.stopReason === 'end_turn')
      const beforeExit = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
      await assert.rejects(prompt('/eval-exit'), /exited/)
      recovery = await prompt('/eval-confirm')
      assert.equal(recovery.stopReason, 'end_turn')
      const afterExit = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
      check(
        'unexpected real Pi process exit fails the turn and restores on re-prompt',
        afterExit.id === identity.id && afterExit.file === identity.file && afterExit.pid !== beforeExit.pid
      )
      const stopsBeforeClose = (await trace()).filter(e => e.statusKey === 'eval-stopped').length
      const closeStart = (await trace()).length
      const closingPrompt = prompt('launch async late')
      await waitTrace(e => e.statusKey === 'eval-launching', closeStart)
      await client.request('session/close', { sessionId })
      assert.equal((await closingPrompt).stopReason, 'cancelled')
      check(
        'session close stops background work before retiring Pi',
        (await trace()).filter(e => e.statusKey === 'eval-stopped').length === stopsBeforeClose + 1
      )
      const queuedSession = await client.request('session/new', { cwd: root, mcpServers: [] })
      const queuedStart = (await trace()).length
      const queuedLaunch = client.request('session/prompt', {
        sessionId: queuedSession.sessionId,
        prompt: [{ type: 'text', text: 'launch async queued' }]
      })
      await waitTrace(backgroundActive, queuedStart)
      client.notify('session/cancel', { sessionId: queuedSession.sessionId })
      assert.equal((await queuedLaunch).stopReason, 'cancelled')
      const queuedRecords = (await trace()).slice(queuedStart)
      assert.deepEqual(
        queuedRecords.filter(e => e.statusKey === 'eval-stop-retry').map(e => e.statusText),
        ['not_found', 'invalid_state']
      )
      assert.ok(texts().includes('detached work may still be running'))
      assert.equal(
        (
          await client.request('session/prompt', {
            sessionId: queuedSession.sessionId,
            prompt: [{ type: 'text', text: '/eval-confirm' }]
          })
        ).stopReason,
        'end_turn'
      )
      check(
        'queued stop retries remain exactly scoped; unrelated liveness is explicitly unconfirmed and recovery works',
        queuedRecords.some(e => e.statusKey === 'eval-stopped')
      )
      await client.request('session/close', { sessionId: queuedSession.sessionId })
      const rejectedSession = await client.request('session/new', { cwd: root, mcpServers: [] })
      const rejectedPrompt = text =>
        client.request('session/prompt', { sessionId: rejectedSession.sessionId, prompt: [{ type: 'text', text }] })
      assert.equal((await rejectedPrompt('/eval-unrelated')).stopReason, 'end_turn')
      const rejectStart = (await trace()).length
      assert.equal((await rejectedPrompt('ordinary restored-child question')).stopReason, 'end_turn')
      const restoredRecords = (await trace()).slice(rejectStart)
      assert.ok(restoredRecords.some(e => e.direction === 'in' && e.message === 'ordinary restored-child question'))
      assert.ok(!restoredRecords.some(e => e.statusKey === 'eval-stopped'))
      await writeFile(join(root, 'release-unrelated'), 'release')
      assert.equal((await rejectedPrompt('/eval-confirm')).stopReason, 'end_turn')
      check('real Pi admits idle foreground with restored live child without adoption or stop', true)
      await client.request('session/close', { sessionId: rejectedSession.sessionId })
      const disconnectSession = await client.request('session/new', { cwd: root, mcpServers: [] })
      const disconnectStart = (await trace()).length
      void client
        .request('session/prompt', {
          sessionId: disconnectSession.sessionId,
          prompt: [{ type: 'text', text: 'launch async late' }]
        })
        .catch(() => {})
      await waitTrace(e => e.statusKey === 'eval-launching', disconnectStart)
      stopsBeforeDisconnect = (await trace()).filter(e => e.statusKey === 'eval-stopped').length
    },
    {
      args: [acpWrapper],
      timeoutMs: 100_000,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: root,
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        PI_ACP_PI_COMMAND: wrapper
      },
      onRequest(message, client) {
        if (message.method === 'session/request_permission') {
          lastPermission = message
          if (holdPermission) permissionSeen()
          else client.respond(message.id, { outcome: { outcome: 'selected', optionId: 'yes' } })
        } else if (message.method === 'elicitation/create')
          client.respond(message.id, { action: 'accept', content: { value: 'typed' } })
        else throw new Error(`Unexpected client request ${message.method}`)
      }
    }
  )
  check(
    'ACP disconnect stops owned background work before process exit',
    (await trace()).filter(e => e.statusKey === 'eval-stopped').length === stopsBeforeDisconnect + 1
  )
} finally {
  if (process.env.PI_ACP_EVAL_LOG_DIR) {
    const destination = resolve(process.env.PI_ACP_EVAL_LOG_DIR)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'pi-trace.jsonl'), await readFile(tracePath).catch(() => ''))
    await writeFile(
      join(destination, 'acp-trace.jsonl'),
      await readFile(acpTracePath).catch(() => acpMessages.map(message => JSON.stringify(message)).join('\n') + '\n')
    )
    await writeFile(join(destination, 'checks.json'), JSON.stringify(checks, null, 2) + '\n')
  }
  await rm(root, { recursive: true, force: true })
}
assert.ok(
  checks.every(c => c.passed),
  'ACP evaluation failures (see checks above)'
)
console.log('Real Pi + fake subagents host evaluation passed; stock host and live Zed UI not exercised here.')
