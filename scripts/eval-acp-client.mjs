import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { accessSync, closeSync, constants as fsConstants, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { withSmokeAgent } from './smoke-client.mjs'

/** POSIX PATH lookup mirroring the adapter's `findExecutableOnPath` (src/pi-rpc/command.ts). */
function findExecutableOnPath(name, { cwd = process.cwd(), pathValue = process.env.PATH ?? '/usr/bin:/bin' } = {}) {
  const resolvedCwd = cwd.replace(/\/+$/, '')
  for (const dir of pathValue.split(':')) {
    const base = dir === '' ? resolvedCwd : dir.startsWith('/') ? dir : `${resolvedCwd}/${dir}`
    const candidate = `${base}/${name}`
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* Not an executable file in this PATH entry. */
    }
  }
  return null
}

/** Reads the `#!` interpreter line; null for non-shebang files (same probe bound as the adapter). */
function readShebangLine(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(512)
    const length = readSync(fd, head, 0, head.length, 0)
    const text = head.subarray(0, length).toString('latin1')
    if (!text.startsWith('#!')) return null
    const newline = text.indexOf('\n')
    if (newline === -1 && length === head.length) return null
    return text.slice(2, newline === -1 ? undefined : newline).trim()
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Mirrors the adapter's POSIX default-discovery Bun reroute
 * (`bunRuntimeInvocation` in src/pi-rpc/command.ts): only direct-JS installs
 * with a bare Node/Bun shebang and no `..` in the PATH candidate launch via
 * Bun. Drift is caught end-to-end by the direct variant's runtime receipt: if
 * the adapter stops rerouting, the Bun receipt assertion fails in CI.
 */
function classifyDefaultLaunchPi({ explicit, pathValue = process.env.PATH, cwd = process.cwd() } = {}) {
  const bun = findExecutableOnPath('bun', { cwd, pathValue })
  if (!bun) return { bunLaunch: false, reason: 'bun not found on PATH' }
  const candidate = explicit ?? findExecutableOnPath('pi', { cwd, pathValue })
  if (!candidate) return { bunLaunch: false, reason: 'pi not found on PATH' }
  if (candidate.split('/').includes('..'))
    return { bunLaunch: false, reason: `PATH candidate contains ..: ${candidate}` }
  let entry
  try {
    entry = realpathSync.native(candidate)
  } catch {
    return { bunLaunch: false, reason: `cannot resolve ${candidate}` }
  }
  if (!/\.(?:js|mjs|cjs)$/i.test(entry)) return { bunLaunch: false, reason: `not a direct-JS entry: ${entry}` }
  const interpreter = readShebangLine(entry)
  if (
    !interpreter ||
    !(/^\/\S*\/env[ \t]+(?:node|bun)$/.test(interpreter) || /^\/\S*\/(?:node|bun)$/.test(interpreter))
  )
    return { bunLaunch: false, reason: `shebang keeps its configured runtime: ${interpreter ?? 'none'}` }
  return {
    bunLaunch: true,
    reason: `direct-JS entry ${entry} launches via bun`,
    piPath: candidate,
    piDir: dirname(candidate),
    entry,
    bun
  }
}

/** Selfcheck for the classifier above: synthetic installs, no process spawning. */

/**
 * The direct variant's default discovery resolves `pi` from PATH, so an
 * accepted explicit entry must actually be reachable under that name:
 * pinning its directory does not help when it contains no `pi` (e.g. a
 * dist/cli.js entry). Create a disposable bin whose `pi` symlink points at
 * the exact accepted entry; the caller prepends it to PATH.
 */
async function pinExplicitPiBin(entry, binDir) {
  await mkdir(binDir, { recursive: true })
  await symlink(entry, join(binDir, 'pi'))
  return binDir
}

async function directLaunchSelfcheck() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-direct-selfcheck-'))
  const binDir = async name => {
    const created = join(dir, name)
    await mkdir(created, { recursive: true })
    await writeFile(join(created, 'bun'), '#!/bin/sh\n', { mode: 0o755 })
    return created
  }
  try {
    const cwd = join(dir, 'work')
    await mkdir(cwd)
    // Deterministic lookup space: every scenario pins its own PATH; the tail
    // entry never exists, so ambient system binaries cannot leak in.
    const elsewhere = join(dir, 'not-a-real-dir')
    const scoped = bin => `${bin}:${elsewhere}`
    // npm-style direct-JS install: a bin symlink to a `#!/usr/bin/env node` JS entry.
    const direct = await binDir('direct')
    await mkdir(join(dir, 'pkg'))
    await writeFile(join(dir, 'pkg', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    await symlink(join(dir, 'pkg', 'cli.js'), join(direct, 'pi'))
    const viaBun = classifyDefaultLaunchPi({ pathValue: scoped(direct), cwd })
    assert.equal(viaBun.bunLaunch, true)
    assert.equal(viaBun.entry, join(realpathSync.native(dir), 'pkg', 'cli.js'))
    assert.equal(viaBun.piDir, direct)
    assert.equal(viaBun.bun, join(direct, 'bun'))
    // Every later scenario is also a bin symlink, so only the intended
    // discriminator (shebang, entry extension, missing dependency) differs.
    const piSymlink = async (bin, entryName, content) => {
      await writeFile(join(bin, entryName), content, { mode: 0o755 })
      await symlink(join(bin, entryName), join(bin, 'pi'))
    }
    // Bare `bun` shebang entries reroute too.
    const bunShebang = await binDir('bun-shebang')
    await piSymlink(bunShebang, 'entry.js', '#!/usr/bin/env bun\n')
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(bunShebang), cwd }).bunLaunch, true)
    // A shell launcher keeps its configured runtime.
    const shell = await binDir('shell')
    await piSymlink(shell, 'entry.js', '#!/bin/sh\nexec pi "$@"\n')
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(shell), cwd }).bunLaunch, false)
    // Interpreter flags and non-JS entries never reroute.
    const flags = await binDir('flags')
    await piSymlink(flags, 'entry.js', '#!/usr/bin/env -S node --flag\n')
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(flags), cwd }).bunLaunch, false)
    const script = await binDir('script')
    await piSymlink(script, 'entry.sh', '#!/usr/bin/env node\n')
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(script), cwd }).bunLaunch, false)
    // No bun on PATH: the default launch stays on the configured runtime.
    const noBun = join(dir, 'no-bun')
    await mkdir(noBun)
    await writeFile(join(noBun, 'entry.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    await symlink(join(noBun, 'entry.js'), join(noBun, 'pi'))
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(noBun), cwd }).bunLaunch, false)
    // No pi on PATH at all (bun is available).
    const bunOnly = await binDir('bun-only')
    assert.equal(classifyDefaultLaunchPi({ pathValue: scoped(bunOnly), cwd }).bunLaunch, false)
    // A PATH candidate containing `..` is never Bun-launched: Bun's realpath
    // collapses it lexically, so the resolved entry identity cannot be trusted.
    const dotdot = await binDir('dotdot')
    await mkdir(join(dotdot, 'x'))
    await piSymlink(dotdot, 'entry.js', '#!/usr/bin/env node\n')
    const dotdotResult = classifyDefaultLaunchPi({ pathValue: `${dotdot}/x/..:${elsewhere}`, cwd })
    assert.equal(dotdotResult.bunLaunch, false)
    assert.match(dotdotResult.reason, /\.\./)
    // Explicit PI_ACP_EVAL_PI handling: a direct-JS entry is used as given
    // (its directory is pinned ahead of PATH for default discovery); an
    // explicit shell launcher never guesses at Bun.
    const explicitDirect = classifyDefaultLaunchPi({
      explicit: join(direct, 'pi'),
      pathValue: scoped(shell),
      cwd
    })
    assert.equal(explicitDirect.bunLaunch, true)
    assert.equal(explicitDirect.piDir, direct)
    assert.equal(
      classifyDefaultLaunchPi({ explicit: join(shell, 'pi'), pathValue: scoped(direct), cwd }).bunLaunch,
      false
    )
    // An explicit entry that cannot be resolved skips instead of guessing.
    assert.equal(
      classifyDefaultLaunchPi({ explicit: join(dir, 'missing'), pathValue: scoped(direct), cwd }).bunLaunch,
      false
    )
    // Explicit PI_ACP_EVAL_PI entries are pinned as `pi` on a disposable bin:
    // the classifier accepts a direct-JS entry, but default discovery
    // resolves `pi` from PATH, so the entry must actually be reachable under
    // that name for the direct variant to prove the accepted entry.
    const pinned = await mkdtemp(join(dir, 'pinned-bin-'))
    await pinExplicitPiBin(viaBun.entry, pinned)
    const pinnedResult = classifyDefaultLaunchPi({ pathValue: `${pinned}:${scoped(direct)}`, cwd })
    assert.equal(pinnedResult.bunLaunch, true)
    assert.equal(pinnedResult.piPath, join(pinned, 'pi'))
    assert.equal(pinnedResult.piDir, pinned)
    assert.equal(pinnedResult.entry, viaBun.entry)
    // Empty PATH entries resolve against the cwd, like the adapter.
    await writeFile(join(cwd, 'entry.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    await symlink(join(cwd, 'entry.js'), join(cwd, 'pi'))
    assert.equal(classifyDefaultLaunchPi({ pathValue: `:${direct}`, cwd }).bunLaunch, true)
    console.log('selfcheck-direct ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv.includes('--selfcheck-direct')) {
  await directLaunchSelfcheck()
  process.exit(0)
}

// Actual built ACP stdio + installed Pi; only the provider and extension work are deterministic.
const root = await mkdtemp(join(tmpdir(), 'pi-acp-client-eval-'))
const pi = process.env.PI_ACP_EVAL_PI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
const tracePath = join(root, 'pi.jsonl')
const wrapper = join(root, 'pi-wrapper.mjs')
const acpWrapper = join(root, 'acp-wrapper.mjs')
const acpTracePath = join(root, 'acp.jsonl')
await mkdir(join(root, '.pi', 'extensions'), { recursive: true })
await mkdir(join(root, 'agent'), { recursive: true })
await writeFile(
  join(root, '.pi', 'extensions', 'eval.ts'),
  await readFile(new URL('./fixtures/acp-harness-extension.ts', import.meta.url))
)
await writeFile(
  join(root, 'agent', 'settings.json'),
  JSON.stringify({
    defaultProvider: 'acp-eval',
    defaultModel: 'local',
    compaction: { reserveTokens: 10, keepRecentTokens: 10 }
  })
)
// A user resource discovered natively from the isolated agent directory (no CLI injection).
await writeFile(join(root, 'agent', 'APPEND_SYSTEM.md'), 'ACP_HARNESS_APPEND_SYSTEM_SENTINEL')
// An additional workspace root: its instruction file must reach the model through the
// adapter-owned, root-scoped workspace-instructions prompt section on every run.
const wsRoot = join(root, 'ws-root')
await mkdir(wsRoot, { recursive: true })
await writeFile(join(wsRoot, 'AGENTS.md'), 'ACP_HARNESS_WS_ROOT_SENTINEL: additional workspace root instructions')
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
        clientInfo: { name: 'acp-client-eval', version: '1' },
        clientCapabilities: { elicitation: { form: {} }, _meta: { terminal_output: true } }
      })
      const { sessionId } = await client.request('session/new', {
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
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
      let launchSettled = false
      const asyncTurn = prompt('launch async').then(result => {
        launchSettled = true
        return result
      })
      await waitTrace(backgroundActive, asyncStart)
      const terminal = await waitTrace(e => e.statusKey === 'eval-terminal', asyncStart)
      // Owned completion: terminal status without a consumed notice must hold the request open.
      assert.equal(launchSettled, false, 'a terminal-pending-delivery child must hold the foreground request')
      await writeFile(join(root, 'deliver-async'), terminal.statusText)
      assert.equal((await asyncTurn).stopReason, 'end_turn')
      check('held foreground releases only after delayed structured delivery and synthesis', launchSettled)
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
      let heldSettled = false
      const heldLaunch = prompt('launch async').then(result => {
        heldSettled = true
        return result
      })
      await waitTrace(backgroundActive, busyStart)
      const heldTerminal = await waitTrace(e => e.statusKey === 'eval-terminal', busyStart)
      assert.equal(heldSettled, false, 'the second held request stays open through pending delivery')
      const admittedAt = Date.now()
      const busyQuestion = prompt('ordinary question after autonomous progress')
      await sleep(150)
      assert.ok(texts().includes('Queued message'), 'ordinary input queues locally while the completion barrier holds')
      assert.ok(
        !(await trace())
          .slice(busyStart)
          .some(e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress'),
        'the queued question is not admitted before the held request completes'
      )
      await writeFile(join(root, 'deliver-async'), heldTerminal.statusText)
      await waitTrace(
        e => e.type === 'message_update' && e.assistantMessageEvent?.delta === 'AUTONOMOUS_PROGRESS',
        busyStart
      )
      await writeFile(join(root, 'finish-autonomous'), 'release')
      assert.equal((await heldLaunch).stopReason, 'end_turn')
      await waitTrace(
        e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress',
        busyStart
      )
      assert.equal((await busyQuestion).stopReason, 'end_turn')
      const busyRecords = (await trace()).slice(busyStart)
      const userPrompt = busyRecords.find(
        e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress'
      )
      assert.ok(userPrompt && !('streamingBehavior' in userPrompt))
      assert.ok(
        busyRecords.some(
          e =>
            e.type === 'message_start' &&
            e.message?.role === 'user' &&
            JSON.stringify(e.message.content).includes('ordinary question after autonomous progress')
        )
      )
      assert.equal(
        busyRecords.filter(e => e.direction === 'in' && e.message === 'ordinary question after autonomous progress')
          .length,
        1
      )
      assert.ok(busyRecords.some(e => e.type === 'response' && e.id === userPrompt.id && e.success))
      assert.ok(busyRecords.some(e => e.type === 'agent_settled'))
      assert.ok(Date.now() - admittedAt < 30_000, 'admission must follow the held completion, not hang')
      const busySurvivor = JSON.parse((await trace()).findLast(e => e.statusKey === 'eval-session').statusText)
      assert.equal(busySurvivor.pid, busyIdentity.pid)
      console.log(
        `Held completion with queued follow-up latency: ${Date.now() - admittedAt}ms; Pi PID survived: ${busySurvivor.pid}`
      )
      check(
        'real Pi autonomous progress after structured delivery, FIFO admission of ordinary input and one subprocess survive',
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
      const queuedSession = await client.request('session/new', {
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
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
      // Exact snapshot proof of the stopped required run covers unrelated liveness;
      // quiescence no longer needs the aggregate detached-work disclaimer.
      assert.equal(
        texts().includes('detached work may still be running'),
        false,
        'exact stop proof must cover unrelated liveness without a detached-work disclaimer'
      )
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
        'queued stop retries stay exactly scoped; exact stop proof covers unrelated liveness and recovery works',
        queuedRecords.some(e => e.statusKey === 'eval-stopped')
      )
      await client.request('session/close', { sessionId: queuedSession.sessionId })
      const rejectedSession = await client.request('session/new', {
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
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
      // Audit finding 6: the persisted session lifecycle runs on its own
      // session and phase, so the trace slices asserted above stay unperturbed.
      const lifecycleSession = await client.request('session/new', {
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
      const lifecyclePrompt = text =>
        client.request('session/prompt', {
          sessionId: lifecycleSession.sessionId,
          prompt: [{ type: 'text', text }]
        })
      assert.equal((await lifecyclePrompt('/eval-runtime')).stopReason, 'end_turn')
      const runtimeReceipts = () =>
        client.updates.filter(
          u => u.sessionUpdate === 'agent_message_chunk' && u.content.text?.startsWith('RUNTIME_RECEIPT ')
        )
      assert.equal(runtimeReceipts().length, 1)
      const wrapperRuntime = JSON.parse(runtimeReceipts()[0].content.text.slice('RUNTIME_RECEIPT '.length))
      assert.equal(wrapperRuntime.bun, null, 'the wrapper variant must run real Pi under Node')
      assert.ok(typeof wrapperRuntime.node === 'string' && wrapperRuntime.node)
      console.log(`Wrapper variant Pi runtime: node ${wrapperRuntime.node}, pid ${wrapperRuntime.pid}`)
      check('wrapper variant runs real Pi under Node (extension runtime receipt)', true)
      assert.equal((await lifecyclePrompt('persisted lifecycle turn')).stopReason, 'end_turn')
      const lifecycleFileStart = (await trace()).length
      assert.equal((await lifecyclePrompt('/eval-confirm')).stopReason, 'end_turn')
      const lifecycleIdentity = JSON.parse(
        (await trace()).slice(lifecycleFileStart).find(e => e.statusKey === 'eval-session').statusText
      )
      assert.equal(lifecycleIdentity.id, lifecycleSession.sessionId)
      const listed = await client.request('session/list', { cwd: root })
      const listedLifecycle = listed.sessions.find(s => s.sessionId === lifecycleSession.sessionId)
      assert.ok(listedLifecycle, 'the persisted lifecycle session must be listed')
      // Pi records the session cwd in its canonical (realpath) form, which on
      // macOS resolves the tmpdir symlink; assert directory identity instead.
      assert.equal(realpathSync.native(listedLifecycle.cwd), realpathSync.native(root))
      await client.request('session/close', { sessionId: lifecycleSession.sessionId })
      const lifecycleLoadBefore = client.messages.length
      const lifecycleLoadStart = (await trace()).length
      const loaded = await client.request('session/load', {
        sessionId: lifecycleSession.sessionId,
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
      const replayedChunks = update =>
        client.messages
          .slice(lifecycleLoadBefore)
          .filter(
            m =>
              m.method === 'session/update' &&
              m.params.sessionId === lifecycleSession.sessionId &&
              m.params.update.sessionUpdate === update
          )
          .map(m => m.params.update)
      assert.ok(
        replayedChunks('user_message_chunk').some(u => u.content.text.includes('persisted lifecycle turn')),
        'load must replay the persisted user turn'
      )
      assert.ok(
        replayedChunks('agent_message_chunk').some(u => u.content.text.includes('HARNESS_RESPONSE')),
        'load must replay the persisted assistant turn'
      )
      const loadRecords = (await trace()).slice(lifecycleLoadStart)
      assert.ok(
        loadRecords.some(e => e.direction === 'in' && e.type === 'get_entries'),
        'load must request real Pi get_entries'
      )
      assert.ok(loadRecords.some(e => e.type === 'response' && e.command === 'get_entries' && e.success))
      const thoughtLevel = loaded.configOptions.find(o => o.id === 'thought_level')
      assert.ok(thoughtLevel, 'load must advertise the thought_level config option')
      // A discriminating change: the requested level must differ from the
      // current one, so a dropped write or a value lost across close/resume
      // fails the assertions below instead of comparing a level to itself.
      const currentLevel = thoughtLevel.currentValue
      assert.ok(thoughtLevel.options.length > 1, 'thought_level must advertise more than the current level')
      const requestedLevel = thoughtLevel.options.find(o => o.value !== currentLevel)?.value
      assert.ok(requestedLevel, 'an advertised level other than the current one must exist')
      const configured = await client.request('session/set_config_option', {
        sessionId: lifecycleSession.sessionId,
        configId: 'thought_level',
        value: requestedLevel
      })
      assert.ok(
        configured.configOptions.some(o => o.id === 'thought_level' && o.currentValue === requestedLevel),
        'set_config_option must apply a different advertised thought level'
      )
      await client.request('session/close', { sessionId: lifecycleSession.sessionId })
      const resumeBefore = client.messages.length
      const resumed = await client.request('session/resume', {
        sessionId: lifecycleSession.sessionId,
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
      assert.ok(
        resumed.configOptions.some(o => o.id === 'thought_level' && o.currentValue === requestedLevel),
        'resume must preserve the changed thought level'
      )
      assert.equal(
        client.messages
          .slice(resumeBefore)
          .filter(
            m =>
              m.method === 'session/update' &&
              m.params.sessionId === lifecycleSession.sessionId &&
              ['user_message_chunk', 'agent_message_chunk'].includes(m.params.update.sessionUpdate)
          ).length,
        0,
        'resume must not replay conversation history'
      )
      await client.request('session/delete', { sessionId: lifecycleSession.sessionId })
      await assert.rejects(readFile(lifecycleIdentity.file), error => error.code === 'ENOENT')
      const listedAfterDelete = await client.request('session/list', { cwd: root })
      assert.ok(
        !listedAfterDelete.sessions.some(s => s.sessionId === lifecycleSession.sessionId),
        'the deleted session must not be listed'
      )
      check(
        'persisted lifecycle: list(id,cwd), close, get_entries replay, thought_level config, resume without replay, delete removes file and listing',
        true
      )
      const disconnectSession = await client.request('session/new', {
        cwd: root,
        mcpServers: [],
        additionalDirectories: [wsRoot]
      })
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

  // Full-evaluation-end receipts: every session has run by now, including the
  // queued, rejected-restored and disconnect scenarios after the hook phase.
  const systemRows = (await trace()).filter(e => e.statusKey === 'eval-system-prompt')
  assert.ok(systemRows.length > 0, 'the harness must observe rendered system prompts')
  assert.ok(
    systemRows.every(row => {
      const observed = JSON.parse(row.statusText)
      return observed.sentinel && !observed.policy && observed.wsRoot
    }),
    'every model run keeps the discovered APPEND_SYSTEM.md sentinel, carries no adapter system-prompt appendix, and includes the workspace-root instructions section'
  )
  check(
    'discovered APPEND_SYSTEM.md sentinel retained, no adapter appendix, workspace-root instructions rendered on every model run',
    true
  )
  const wsRequestRows = (await trace()).filter(e => e.statusKey === 'eval-ws-request')
  assert.ok(wsRequestRows.length > 0, 'the harness must report provider workspace-request receipts')
  // Receipts are uniquely identified per (pi child, request): count distinct
  // requests, never cumulative status counters (which double-count when summed).
  const uniqueRequests = new Map()
  const piChildren = new Set()
  for (const row of wsRequestRows) {
    const receipt = JSON.parse(row.statusText)
    piChildren.add(receipt.pid)
    uniqueRequests.set(`${receipt.pid}:${receipt.seq}`, receipt.received)
  }
  assert.ok(uniqueRequests.size > 0, 'provider requests must have been observed')
  console.log(
    `Workspace-root instructions: ${uniqueRequests.size} distinct provider requests across ${piChildren.size} pi children`
  )
  check(
    'workspace-root instructions reach every distinct provider request at full evaluation end, including extension-triggered runs and post-tool-call continuations',
    [...uniqueRequests.values()].every(Boolean)
  )

  // Default-launch variant (audit finding 6): run the adapter WITHOUT
  // PI_ACP_PI_COMMAND so its own default discovery resolves `pi` from PATH
  // and reroutes direct-JS installs to Bun. The runtime is proven by the
  // extension receipt inside Pi, never inferred from PATH. Bounded and
  // minimal by design: one command-only turn; the wrapper variant above
  // remains the full-tracing lifecycle evaluation.
  const direct =
    process.platform === 'win32'
      ? { bunLaunch: false, reason: 'Windows default launch has its own CI job; the Bun reroute is POSIX-only' }
      : classifyDefaultLaunchPi({ explicit: process.env.PI_ACP_EVAL_PI })
  if (!direct.bunLaunch) {
    if (process.env.PI_ACP_EVAL_REQUIRE_DIRECT === '1')
      throw new Error(`direct-launch variant required but unavailable: ${direct.reason}`)
    console.log(`SKIP direct-launch variant: ${direct.reason}`)
  } else {
    const directRoot = await mkdtemp(join(tmpdir(), 'pi-acp-direct-'))
    // Default discovery resolves `pi` from PATH, and the accepted entry's own
    // directory need not contain one (e.g. an explicit dist/cli.js), so pin a
    // disposable bin whose `pi` symlink points at the exact accepted entry.
    const pinnedBin = await pinExplicitPiBin(direct.entry, join(directRoot, 'bin'))
    console.log(
      `Direct-launch variant: ${direct.reason} (bun ${direct.bun}, pi pinned to ${join(pinnedBin, 'pi')} ahead of PATH)`
    )
    try {
      // The agent-dir extension auto-loads (no wrapper --extension), so the
      // isolated agent directory carries the provider settings and receipt.
      await mkdir(join(directRoot, 'agent', 'extensions'), { recursive: true })
      await writeFile(
        join(directRoot, 'agent', 'settings.json'),
        JSON.stringify({ defaultProvider: 'acp-eval', defaultModel: 'local' })
      )
      await writeFile(
        join(directRoot, 'agent', 'extensions', 'eval.ts'),
        await readFile(new URL('./fixtures/acp-harness-extension.ts', import.meta.url))
      )
      await withSmokeAgent(
        async client => {
          await client.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'acp-client-eval', version: '1' },
            clientCapabilities: {}
          })
          const { sessionId } = await client.request('session/new', { cwd: directRoot, mcpServers: [] })
          const result = await client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: '/eval-runtime' }]
          })
          assert.equal(result.stopReason, 'end_turn')
          const runtimeReceipts = () =>
            client.updates.filter(
              u => u.sessionUpdate === 'agent_message_chunk' && u.content.text?.startsWith('RUNTIME_RECEIPT ')
            )
          assert.equal(runtimeReceipts().length, 1)
          const receipt = JSON.parse(runtimeReceipts()[0].content.text.slice('RUNTIME_RECEIPT '.length))
          assert.equal(typeof receipt.pid, 'number')
          assert.ok(typeof receipt.node === 'string' && receipt.node)
          assert.ok(
            typeof receipt.bun === 'string' && receipt.bun.length > 0,
            'the default launch must run direct-JS Pi under Bun'
          )
          console.log(
            `Direct default launch: Pi pid ${receipt.pid} under bun ${receipt.bun} (node compat ${receipt.node})`
          )
          // One ordinary provider prompt through the same Bun-hosted Pi
          // process: the receipt proves the runtime, this proves the adapter's
          // turn lifecycle and the deterministic provider path actually run
          // under it.
          const ordinary = await client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'direct-launch ordinary provider prompt' }]
          })
          assert.equal(ordinary.stopReason, 'end_turn')
          const chunks = client.updates
            .filter(u => u.sessionUpdate === 'agent_message_chunk')
            .map(u => u.content.text)
            .join('\n')
          assert.ok(
            chunks.includes('HARNESS_RESPONSE'),
            'the ordinary prompt must settle a provider turn (HARNESS_RESPONSE)'
          )
          check('default launch without PI_ACP_PI_COMMAND runs direct-JS Pi under Bun (runtime receipt)', true)
          // Same-process proof: a second runtime receipt after the ordinary
          // provider prompt must report the identical pid and Bun runtime, so
          // the ordinary turn genuinely ran in the receipted Bun-hosted Pi.
          const secondRuntime = await client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: '/eval-runtime' }]
          })
          assert.equal(secondRuntime.stopReason, 'end_turn')
          assert.equal(runtimeReceipts().length, 2, 'the second runtime receipt must arrive on the same session')
          const [firstReceipt, secondReceipt] = runtimeReceipts().map(u =>
            JSON.parse(u.content.text.slice('RUNTIME_RECEIPT '.length))
          )
          assert.equal(secondReceipt.pid, firstReceipt.pid, 'the ordinary prompt must run in the same Pi process')
          assert.equal(secondReceipt.bun, firstReceipt.bun, 'the same Pi process must still be hosted by Bun')
          assert.ok(secondReceipt.bun)
          check('default-launch ordinary provider prompt settles end to end under Bun (same-process pid receipt)', true)
        },
        {
          timeoutMs: 60_000,
          env: {
            PATH: `${pinnedBin}${delimiter}${process.env.PATH}`,
            HOME: directRoot,
            XDG_CONFIG_HOME: directRoot,
            PI_CODING_AGENT_DIR: join(directRoot, 'agent')
          }
        }
      )
    } finally {
      await rm(directRoot, { recursive: true, force: true })
    }
  }
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
console.log('Real Pi + fake subagents host evaluation passed; stock host and live client UI not exercised here.')
