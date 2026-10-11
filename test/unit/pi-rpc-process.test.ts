import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PiRpcProcess,
  PiRpcClosedError,
  PiRpcRequestTimeoutError,
  type PiRpcEvent,
  type PiRpcTermination
} from '../../src/pi-rpc/process.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-pi-rpc.mjs', import.meta.url))

class MockChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  killed = false
  readonly kills: Array<NodeJS.Signals | number> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.kills.push(signal ?? 'SIGTERM')
    return true
  }
}

function asChild(mock: MockChild): ChildProcessWithoutNullStreams {
  return mock as unknown as ChildProcessWithoutNullStreams
}

function collectStdin(mock: MockChild): string[] {
  const lines: string[] = []
  let buffer = ''
  mock.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      lines.push(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
    }
  })
  return lines
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function spawnFixture(behavior: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FIXTURE, behavior], { stdio: 'pipe' })
}

async function cleanupFixture(
  child: ChildProcessWithoutNullStreams,
  proc: PiRpcProcess,
  termination: Promise<PiRpcTermination>,
  label: string
): Promise<void> {
  proc.dispose()
  try {
    child.kill('SIGKILL')
  } catch {
    // Best-effort raw cleanup is independent of PiRpcProcess escalation.
  }
  try {
    await withTimeout(termination, 2_000, label)
  } catch {
    // Cleanup must not mask the test's primary assertion.
  }
}

test('PiRpcProcess: session replay requests flat get_entries snapshots', async () => {
  const mock = new MockChild()
  const lines = collectStdin(mock)
  const proc = PiRpcProcess.fromChild(asChild(mock))

  const pending = proc.getEntries()
  await tick()

  const command = JSON.parse(lines[0]!)
  assert.equal(command.type, 'get_entries')
  mock.stdout.write(
    `${JSON.stringify({
      type: 'response',
      id: command.id,
      command: 'get_entries',
      success: true,
      data: { entries: [], leafId: null }
    })}\n`
  )
  assert.deepEqual(await pending, { entries: [], leafId: null })
})

test('PiRpcProcess: U+2028/U+2029 inside event payloads survive stdout framing', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const events: PiRpcEvent[] = []
  proc.onEvent(ev => events.push(ev))

  const record = JSON.stringify({ type: 'session_info_changed', text: 'a\u2028b\u2029c' })
  mock.stdout.write(Buffer.from(record + '\n', 'utf8'))
  await tick()

  assert.equal(events.length, 1, 'exactly one event; readline would have split this record in two')
  assert.equal(events[0]!.text, 'a\u2028b\u2029c')
})

test('PiRpcProcess: records split across stdout chunks (including mid code point) are reassembled', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const events: PiRpcEvent[] = []
  proc.onEvent(ev => events.push(ev))

  const record = Buffer.from(JSON.stringify({ type: 'session_info_changed', text: 'héllo 🌍 world' }) + '\n', 'utf8')
  const mid = record.indexOf(Buffer.from('🌍', 'utf8')) + 2
  mock.stdout.write(record.subarray(0, mid))
  await tick()
  assert.equal(events.length, 0)
  mock.stdout.write(record.subarray(mid))
  await tick()

  assert.equal(events.length, 1)
  assert.equal(events[0]!.text, 'héllo 🌍 world')
})

test('PiRpcProcess: malformed stdout records do not block later valid records', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const events: PiRpcEvent[] = []
  proc.onEvent(ev => events.push(ev))

  mock.stdout.write('starting fake pi...\n{not json\n')
  mock.stdout.write(JSON.stringify({ type: 'session_info_changed', ok: true }) + '\n')
  await tick()

  assert.deepEqual(events, [{ type: 'session_info_changed', ok: true }])
})

test('PiRpcProcess: an unterminated framing flood is caught and quarantines the child', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { maxStdoutRecordBytes: 8, killGraceMs: 30 })

  mock.stdout.write('123456789')
  await tick()

  assert.deepEqual(mock.kills, ['SIGTERM'])
  await assert.rejects(proc.getState(), PiRpcClosedError)
})

test('PiRpcProcess: a throwing event handler does not break sibling handlers or later events', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const seen: PiRpcEvent[] = []
  proc.onEvent(() => {
    throw new Error('subscriber bug')
  })
  proc.onEvent(ev => seen.push(ev))

  mock.stdout.write('{"type":"agent_start"}\n{"type":"agent_end"}\n')
  await tick()

  assert.deepEqual(
    seen.map(ev => ev.type),
    ['agent_start', 'agent_end']
  )
})

test('PiRpcProcess: every command timeout quarantines the channel and drops late output', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 50, killGraceMs: 30 })
  const stdinLines = collectStdin(mock)
  const events: PiRpcEvent[] = []
  proc.onEvent(ev => events.push(ev))

  await assert.rejects(proc.getState(), (e: unknown) => {
    assert.ok(e instanceof PiRpcRequestTimeoutError)
    assert.equal(e.command, 'get_state')
    return true
  })

  // The timed-out command's outcome is unknown, so the channel is
  // quarantined: the child is being killed and later requests fail fast.
  assert.deepEqual(mock.kills, ['SIGTERM'])
  await assert.rejects(proc.abort(), PiRpcClosedError)

  // The pending entry is gone and the channel is quarantined: the late
  // correlation response is dropped and cannot masquerade as a pi event,
  // and no late event escapes either.
  const request = JSON.parse(stdinLines[0]!) as { id: string }
  mock.stdout.write(
    JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: {} }) + '\n'
  )
  mock.stdout.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"late"}}\n')
  await tick()

  assert.equal(events.length, 0)

  await sleep(60)
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL'], 'quarantine escalates to SIGKILL after the grace period')
})

test('PiRpcProcess: prompt timeout quarantines the channel and suppresses late records', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 30, killGraceMs: 30 })
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))

  await assert.rejects(proc.prompt('slow preflight'), (error: unknown) => {
    assert.ok(error instanceof PiRpcRequestTimeoutError)
    assert.equal(error.command, 'prompt')
    return true
  })
  assert.deepEqual(mock.kills, ['SIGTERM'])

  mock.stdout.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"late"}}\n')
  mock.stdout.write('{"type":"response","id":"late","command":"prompt","success":true}\n')
  await tick()
  assert.deepEqual(events, [])
  await sleep(60)
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL'])

  const terminations: PiRpcTermination[] = []
  proc.onTermination(termination => terminations.push(termination))
  mock.emit('close', null, 'SIGKILL')
  await tick()
  assert.equal(terminations[0]?.expected, false, 'fault quarantine is not an ACP cancellation')
})

test('PiRpcProcess: prompt omits unwithdrawable native queue fallback and resolves on success', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 5_000 })
  const stdinLines = collectStdin(mock)

  const ordering: string[] = []
  proc.onEvent(event => ordering.push(String(event.type)))

  const images = [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
  const prompt = proc.prompt('hello world', images, () => ordering.push('accepted'))
  await tick()

  assert.equal(stdinLines.length, 1, 'exactly one raw request line per prompt')
  const request = JSON.parse(stdinLines[0]!) as Record<string, unknown>
  assert.equal(request.type, 'prompt')
  assert.equal(request.message, 'hello world')
  assert.deepEqual(request.images, images)
  assert.equal(typeof request.id, 'string')
  assert.ok((request.id as string).length > 0)
  // A busy race must reject before acceptance, not insert unwithdrawable text
  // into a foreign native queue. Owned adapter prompts can then re-admit safely.
  assert.equal(request.streamingBehavior, undefined)

  // A success response (immediate acceptance or queued as follow-up) resolves.
  // The synchronous callback is the exact ownership boundary: records already
  // ahead of the response remain foreign, while later records in the same
  // stdout chunk observe acceptance before Promise callbacks can run.
  mock.stdout.write(
    [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'response', id: request.id, command: 'prompt', success: true }),
      JSON.stringify({ type: 'turn_end' })
    ].join('\n') + '\n'
  )
  await prompt
  assert.deepEqual(ordering, ['agent_start', 'accepted', 'turn_end'])
  proc.dispose()
})

test('PiRpcProcess: close fallback settles once and ignores later pipe data', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { closeFallbackMs: 20 })
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))

  mock.stdout.write('{"type":"agent_start"}\n')
  mock.emit('exit', 4, null)
  const termination = await withTimeout(terminationPromise, 250, 'close fallback')
  assert.equal(termination.code, 4)
  assert.deepEqual(
    events.map(event => event.type),
    ['agent_start']
  )

  mock.stdout.write('{"type":"agent_end"}\n')
  await tick()
  assert.deepEqual(
    events.map(event => event.type),
    ['agent_start']
  )
})

test('PiRpcProcess: duplicate child error+exit settles termination exactly once', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 5_000 })
  const terminations: PiRpcTermination[] = []
  proc.onTermination(t => terminations.push(t))

  const pending = proc.getState()
  await tick()

  mock.emit('error', new Error('boom'))
  mock.emit('exit', 1, null)
  mock.emit('close', 1, null)

  await assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof PiRpcClosedError)
    assert.match(e.message, /boom/)
    return true
  })
  assert.equal(terminations.length, 1)
  assert.equal(terminations[0]!.reason, 'error')
  assert.equal(terminations[0]!.expected, false)

  // New requests fail fast instead of hanging on a dead child.
  await assert.rejects(proc.getState(), PiRpcClosedError)
})

test('PiRpcProcess: onTermination after settlement still delivers the recorded state', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))

  mock.stdout.end()
  mock.emit('exit', 7, null)
  mock.emit('close', 7, null)
  await tick()

  const terminations: PiRpcTermination[] = []
  proc.onTermination(t => terminations.push(t))
  await tick()

  assert.equal(terminations.length, 1)
  assert.equal(terminations[0]!.code, 7)
})

test('PiRpcProcess: dispose rejects pending requests immediately and escalates SIGTERM to SIGKILL', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 5_000, killGraceMs: 40 })

  const pending = proc.getState()
  await tick()
  proc.dispose()

  await assert.rejects(pending, PiRpcClosedError)
  assert.deepEqual(mock.kills, ['SIGTERM'])

  await sleep(80)
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL'])

  // Requests after dispose fail fast.
  await assert.rejects(proc.getState(), PiRpcClosedError)
})

test('PiRpcProcess: a failed stdin write quarantines the channel as an unexpected fault', async () => {
  for (const mode of ['callback', 'throw'] as const) {
    const mock = new MockChild()
    const failure = new Error(`stdin ${mode} failure`)
    mock.stdin.write = ((_chunk: unknown, cb?: (error?: Error | null) => void) => {
      if (mode === 'throw') throw failure
      cb?.(failure)
      return false
    }) as unknown as typeof mock.stdin.write

    const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 5_000, killGraceMs: 30 })
    let termination: PiRpcTermination | null = null
    proc.onTermination(info => {
      termination = info
    })

    // How much of the record pi received is unknown, so the channel can no
    // longer be framed: it is torn down instead of reused.
    await assert.rejects(proc.getState(), PiRpcClosedError)
    assert.deepEqual(mock.kills, ['SIGTERM'], `a failed stdin write (${mode}) terminates the child`)
    await assert.rejects(proc.abort(), PiRpcClosedError)

    mock.emit('close', 0, null)
    await tick()
    assert.equal(termination!.expected, false, 'the quarantine is reported as an unexpected fault')
  }
})

test('PiRpcProcess: asynchronous stdin errors reject pending requests and retain ownership until close', async t => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { requestTimeoutMs: 5_000, killGraceMs: 30 })
  t.after(() => {
    proc.dispose()
    mock.emit('close', null, 'SIGKILL')
  })
  const terminations: PiRpcTermination[] = []
  proc.onTermination(termination => terminations.push(termination))
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  const pending = Promise.all([
    assert.rejects(proc.getState(), PiRpcClosedError),
    assert.rejects(proc.getEntries(), PiRpcClosedError)
  ])
  await tick()
  assert.equal(proc.hasPendingRequests(), true)

  mock.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  await withTimeout(pending, 500, 'stdin error pending cleanup')

  assert.equal(proc.hasPendingRequests(), false)
  assert.deepEqual(mock.kills, ['SIGTERM'])
  assert.equal(terminations.length, 0, 'a stream error does not release the live child')
  await assert.rejects(proc.getState(), PiRpcClosedError)
  mock.stdout.write('{"type":"agent_start"}\n')
  await tick()
  assert.deepEqual(events, [], 'a broken channel suppresses later stdout records')
  await sleep(60)
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL'])
  mock.emit('close', null, 'SIGKILL')
  assert.equal(terminations.length, 1)
  assert.equal(terminations[0]!.expected, false)
  mock.stdin.emit('error', new Error('late stdin error'))
  assert.equal(terminations.length, 1)
})

test('PiRpcProcess: a child closing stdin cannot crash the server with asynchronous EPIPE (real child)', async t => {
  const fixture = fileURLToPath(new URL('../fixtures/fake-pi-rpc-closed-stdin.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture], { stdio: 'pipe' })
  const proc = PiRpcProcess.fromChild(child, { requestTimeoutMs: 5_000, killGraceMs: 100 })
  const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))
  t.after(() => cleanupFixture(child, proc, terminationPromise, 'closed stdin fixture cleanup'))
  const ready = new Promise<void>(resolve =>
    proc.onEvent(event => {
      if (event.type === 'session_info_changed' && event.ready === true) resolve()
    })
  )
  await withTimeout(ready, 2_000, 'closed stdin fixture readiness')

  await Promise.all([
    assert.rejects(proc.getState(), PiRpcClosedError),
    assert.rejects(proc.getEntries(), PiRpcClosedError),
    assert.rejects(proc.sendExtensionUiResponse({ id: 'x'.repeat(2 * 1024 * 1024), cancelled: true }), {
      code: 'EPIPE'
    })
  ])
  assert.equal(proc.hasPendingRequests(), false)
  await assert.rejects(proc.getState(), PiRpcClosedError)
  const termination = await withTimeout(terminationPromise, 2_000, 'closed stdin fixture termination')
  assert.equal((child.stdin.errored as NodeJS.ErrnoException).code, 'EPIPE')
  assert.equal(termination.expected, false)
})

test('PiRpcProcess: a failed fire-and-forget stdin write rejects and quarantines the channel', async () => {
  const mock = new MockChild()
  const failure = new Error('stdin closed')
  mock.stdin.write = ((_chunk: unknown, cb?: (error?: Error | null) => void) => {
    cb?.(failure)
    return false
  }) as unknown as typeof mock.stdin.write

  const proc = PiRpcProcess.fromChild(asChild(mock), { killGraceMs: 30 })

  await assert.rejects(proc.sendExtensionUiResponse({ id: 'ui-1', cancelled: true }), /stdin closed/)
  assert.deepEqual(mock.kills, ['SIGTERM'])
  await assert.rejects(proc.getState(), PiRpcClosedError)
})

test('PiRpcProcess: stderr retention is bounded to a tail buffer', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))

  mock.stderr.write('x'.repeat(64 * 1024))
  mock.stderr.write('TAIL-END')
  await tick()

  assert.ok(proc.stderrTail().length <= 8 * 1024, `stderr tail must be capped, got ${proc.stderrTail().length}`)
  assert.ok(proc.stderrTail().endsWith('TAIL-END'))
})

test('PiRpcProcess: buffered stdout events are dispatched before termination settles (real child)', async t => {
  const child = spawnFixture('events-then-exit')
  const proc = PiRpcProcess.fromChild(child, { requestTimeoutMs: 2_000 })
  const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))
  t.after(() => cleanupFixture(child, proc, terminationPromise, 'events fixture cleanup'))

  const events: PiRpcEvent[] = []
  const eventsAtTermination: number[] = []
  proc.onEvent(ev => {
    if (ev.type === 'session_info_changed') events.push(ev)
  })
  proc.onTermination(() => eventsAtTermination.push(events.length))
  const termination = await withTimeout(terminationPromise, 2_000, 'events fixture termination')

  assert.equal(termination.reason, 'exit')
  assert.equal(termination.code, 3)
  assert.equal(termination.expected, false)
  assert.deepEqual(eventsAtTermination, [2], 'both events must be observed before termination settles')
  assert.equal(events[0]!.text, 'line separator: \u2028 and paragraph separator: \u2029 survive')
})

test(
  'PiRpcProcess: a SIGTERM-ignoring child is killed via SIGKILL escalation (real child)',
  { skip: process.platform === 'win32' ? 'POSIX signal identity is unavailable on Windows' : false },
  async t => {
    const child = spawnFixture('ignore-sigterm')
    const proc = PiRpcProcess.fromChild(child, { requestTimeoutMs: 2_000, killGraceMs: 100 })
    const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))
    t.after(() => cleanupFixture(child, proc, terminationPromise, 'SIGTERM fixture cleanup'))

    const readyPromise = new Promise<void>(resolve => {
      proc.onEvent(event => {
        if (event.type === 'session_info_changed' && event.ready === true) resolve()
      })
    })
    await withTimeout(readyPromise, 2_000, 'SIGTERM fixture readiness')
    proc.dispose()

    const termination = await withTimeout(terminationPromise, 2_000, 'SIGKILL escalation')
    assert.equal(termination.expected, true)
    assert.equal(termination.signal, 'SIGKILL')
  }
)

test('PiRpcProcess: an unresponsive but live child cannot hang requests or abort (real child)', async t => {
  const child = spawnFixture('silent')
  const proc = PiRpcProcess.fromChild(child, { requestTimeoutMs: 80, killGraceMs: 100 })
  const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))
  t.after(() => cleanupFixture(child, proc, terminationPromise, 'silent fixture cleanup'))

  // The first timeout quarantines the channel (dispose + kill): the command
  // outcome is unknown, so nothing may reuse this child.
  await assert.rejects(proc.getState(), PiRpcRequestTimeoutError)
  // Later requests fail fast on the quarantined channel instead of waiting
  // out their own timeout.
  await assert.rejects(proc.abort(), PiRpcClosedError)

  const termination = await withTimeout(terminationPromise, 2_000, 'silent fixture termination')
  assert.equal(termination.expected, false, 'a timeout quarantine is an unexpected fault')
})

test('PiRpcProcess: live child error retains termination ownership and kill escalation until close', async () => {
  const mock = Object.assign(new MockChild(), {
    pid: 12345,
    exitCode: null,
    signalCode: null
  })
  const proc = PiRpcProcess.fromChild(asChild(mock), { killGraceMs: 20 })
  let terminated = false
  const done = proc.whenTerminated().then(() => {
    terminated = true
  })
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  mock.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))
  await tick()
  assert.equal(terminated, false, 'error alone does not release the live writer')
  mock.stdout.write('{"type":"agent_end"}\n')
  await tick()
  assert.deepEqual(
    events.map(event => event.type),
    ['agent_end']
  )
  proc.dispose()
  mock.emit('error', new Error('SIGTERM failed'))
  await sleep(50)
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(terminated, false)
  mock.emit('exit', null, 'SIGKILL')
  mock.emit('close', null, 'SIGKILL')
  await done
})

test('PiRpcProcess: error after proven exit still drains stdout before close', async () => {
  const mock = Object.assign(new MockChild(), {
    pid: 12345,
    exitCode: 1,
    signalCode: null
  })
  const proc = PiRpcProcess.fromChild(asChild(mock), { closeFallbackMs: 100 })
  const order: string[] = []
  proc.onEvent(event => order.push(event.type))
  proc.onTermination(() => order.push('terminated'))
  mock.emit('exit', 1, null)
  mock.emit('error', new Error('late error'))
  mock.stdout.write('{"type":"agent_end"}\n')
  mock.emit('close', 1, null)
  await tick()
  assert.deepEqual(order, ['agent_end', 'terminated'])
})

for (const behavior of ['split-writes', 'garbage-then-event', 'stderr-flood', 'late-response']) {
  test(`PiRpcProcess: ${behavior} fixture exercises real pipes`, async t => {
    const child = spawnFixture(behavior)
    const proc = PiRpcProcess.fromChild(child, {
      requestTimeoutMs: behavior === 'late-response' ? 100 : 2_000,
      killGraceMs: 50
    })
    const termination = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))
    t.after(() => cleanupFixture(child, proc, termination, behavior))
    if (behavior === 'late-response') {
      await assert.rejects(proc.getState(), PiRpcRequestTimeoutError)
      await withTimeout(termination, 2_000, behavior)
      await assert.rejects(proc.getState(), PiRpcClosedError)
    } else if (behavior === 'stderr-flood') {
      await proc.getState()
      assert.ok(proc.stderrTail().length <= 8192)
      // stdout and stderr are independent OS pipes; wait for the observed tail.
      const deadline = Date.now() + 2_000
      while (!proc.stderrTail().endsWith('TAIL-END\n')) {
        assert.ok(Date.now() < deadline, 'stderr tail deadline')
        await tick()
      }
    } else {
      const event = await withTimeout(new Promise<PiRpcEvent>(resolve => proc.onEvent(resolve)), 2_000, behavior)
      assert.equal(event.type, 'session_info_changed')
      if (behavior === 'split-writes') assert.equal(event.text, 'héllo 🌍 world')
      else assert.equal(event.ok, true)
    }
  })
}

test('PiRpcProcess: shared wrappers preserve errors, void returns and specialized response hooks', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const lines = collectStdin(mock)
  async function respond(run: () => Promise<unknown>, success: boolean, data: unknown, error?: string) {
    const result = run()
    const command = JSON.parse(lines.at(-1)!)
    mock.stdout.write(
      JSON.stringify({ type: 'response', id: command.id, command: command.type, success, data, error }) + '\n'
    )
    return result
  }
  assert.deepEqual(await respond(() => proc.getState(), true, { isStreaming: false }), { isStreaming: false })
  const abort = proc.abort()
  for (const type of ['clear_queue', 'abort']) {
    await tick()
    const command = JSON.parse(lines.at(-1)!)
    assert.equal(command.type, type)
    mock.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: type, success: true }) + '\n')
  }
  assert.equal(await abort, undefined)
  await assert.rejects(
    respond(() => proc.getCommands(), false, { detail: 'failed' }),
    /pi get_commands failed: {"detail":"failed"}/
  )
  await assert.rejects(
    respond(() => proc.getAvailableThinkingLevels(), false, null, 'Unknown command'),
    (error: unknown) => {
      assert.equal((error as Error & { unsupportedCommand?: boolean }).unsupportedCommand, true)
      return true
    }
  )
  assert.deepEqual(await respond(() => proc.exportHtml(), true, { path: 123 }), { path: '123' })
  const order: string[] = []
  proc.onEvent(event => order.push(event.type))
  const entries = proc.getEntries(() => order.push('snapshot'))
  const command = JSON.parse(lines.at(-1)!)
  mock.stdout.write(
    JSON.stringify({ type: 'response', id: command.id, command: 'get_entries', success: true, data: { entries: [] } }) +
      '\n{"type":"agent_start"}\n'
  )
  await entries
  assert.deepEqual(order, ['snapshot', 'agent_start'])
})

const lifecycleOwner = '11111111-1111-4111-8111-111111111111'
function controlWidget(state: string, owner = lifecycleOwner, error = 'busy') {
  return (
    JSON.stringify({
      type: 'extension_ui_request',
      id: 'control',
      method: 'setWidget',
      widgetKey: 'pi-acp-lifecycle',
      widgetLines: [JSON.stringify({ version: 1, owner, state, error })]
    }) + '\n'
  )
}

test('PiRpcProcess: rejected begin never dispatches user text or kills Pi; next begin can recover', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const messages: string[] = []
  let state = 'rejected'
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    if (command.message) messages.push(command.message)
    if (command.message?.startsWith('/pi-acp-control begin')) mock.stdout.write(controlWidget(state))
    mock.stdout.write(
      JSON.stringify({
        type: 'response',
        id: command.id,
        command: command.type,
        success: true,
        data: { commands: [{ name: 'pi-acp-control' }] }
      }) + '\n'
    )
  })
  await assert.rejects(proc.prompt('must not reach model', [], undefined, lifecycleOwner), /busy/)
  assert.equal(mock.killed, false)
  assert.ok(!messages.includes('must not reach model'))
  state = 'ready'
  await proc.prompt('safe retry', [], undefined, lifecycleOwner)
  assert.equal(messages.at(-1), 'safe retry')
  assert.equal(mock.killed, false)
})

for (const ack of ['missing', 'foreign', 'error']) {
  test(`PiRpcProcess: ${ack} begin acknowledgement fails closed despite RPC success`, async () => {
    const mock = new MockChild()
    const proc = PiRpcProcess.fromChild(asChild(mock))
    const messages: string[] = []
    mock.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk))
      if (command.message) {
        messages.push(command.message)
        if (ack !== 'missing')
          mock.stdout.write(
            controlWidget(ack === 'foreign' ? 'ready' : 'error', ack === 'foreign' ? 'foreign' : lifecycleOwner)
          )
      }
      mock.stdout.write(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data: { commands: [{ name: 'pi-acp-control' }] }
        }) + '\n'
      )
    })
    await assert.rejects(proc.prompt('unsafe', [], undefined, lifecycleOwner), /lifecycle begin failed/)
    assert.equal(messages.length, 1)
    assert.equal(mock.killed, true)
    mock.emit('close', 0, null)
  })
}

for (const finish of [true, false]) {
  test(`PiRpcProcess: owner abort shares a bounded deadline (${finish ? 'slow success' : 'timeout'})`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const mock = new MockChild()
    const proc = PiRpcProcess.fromChild(asChild(mock))
    const commands: Array<{ type: string; message?: string }> = []
    mock.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk))
      commands.push(command)
      const reply = () =>
        mock.stdout.write(
          JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true }) + '\n'
        )
      if (command.type === 'prompt') {
        const final = command.message.startsWith('/pi-acp-control check')
        assert.equal(command.message, `/pi-acp-control ${final ? 'check' : 'cancel'} ${lifecycleOwner} 10000`)
        if (finish) {
          if (final) {
            mock.stdout.write(controlWidget('cancelled'))
            reply()
          } else
            setTimeout(() => {
              mock.stdout.write(controlWidget('stopping'))
              reply()
            }, 8500)
        }
      } else reply()
    })
    const abort = proc.abort(lifecycleOwner)
    const result = finish ? abort : assert.rejects(abort, /cancellation timed out|shutting down|timed out/)
    await tick()
    t.mock.timers.tick(8500)
    await tick()
    if (!finish) {
      t.mock.timers.tick(1500)
      await tick()
    }
    await result
    assert.equal(mock.killed, !finish)
    assert.deepEqual(
      commands.map(c => c.type),
      finish ? ['clear_queue', 'abort', 'prompt', 'clear_queue', 'abort', 'prompt'] : ['clear_queue', 'abort', 'prompt']
    )
    assert.equal(proc.hasPendingRequests(), false)
    mock.emit('close', 0, null)
  })
}

for (const quiet of [false, true]) {
  test(`PiRpcProcess: unconfirmed nested control diagnostic survives pending until ${quiet ? 'quiescence' : 'deadline'}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const mock = new MockChild()
    const proc = PiRpcProcess.fromChild(asChild(mock))
    const diagnostic = 'pi-subagents interrupt failed for nested: owner is not reachable'
    let quiescent = false
    let settled = false
    mock.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk))
      const phase = command.message?.split(' ')[1]
      if (phase === 'cancel') mock.stdout.write(controlWidget('stopping', lifecycleOwner, diagnostic))
      if (phase === 'check')
        mock.stdout.write(
          controlWidget(quiescent ? 'cancelled' : 'pending', lifecycleOwner, quiescent ? '' : diagnostic)
        )
      mock.stdout.write(
        JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true }) + '\n'
      )
    })
    const abort = proc.abort(lifecycleOwner).then(() => {
      settled = true
    })
    const result = quiet
      ? abort
      : assert.rejects(
          abort,
          /detached background work may still be running; last unconfirmed nested control:.*owner is not reachable/
        )
    await tick()
    assert.equal(settled, false, 'a control diagnostic is neither fatal nor quiescence proof')
    quiescent = quiet
    t.mock.timers.tick(quiet ? 25 : 10000)
    await result
    assert.equal(settled, quiet)
    assert.equal(mock.killed, !quiet)
    assert.equal(proc.hasPendingRequests(), false)
    mock.emit('close', 0, null)
  })
}

test('PiRpcProcess: abort rejection quarantines before disposal can renew its deadline', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const lines = collectStdin(mock)
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    mock.stdout.write(
      JSON.stringify({ type: 'response', id: command.id, command: command.type, success: false, error: 'failed' }) +
        '\n'
    )
  })
  await assert.rejects(proc.abort(lifecycleOwner), /failed/)
  assert.equal(mock.killed, true)
  proc.dispose({ backgroundOwner: lifecycleOwner })
  assert.equal(lines.length, 1, 'no second abort transaction after failure')
  mock.emit('close', 0, null)
})

test('PiRpcProcess: last-stop synthesis is reconciled after native abort before read-only success', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const phases: string[] = []
  let stops = 0
  let quiescent = false
  let settled = false
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    const phase = command.message?.split(' ')[1] ?? command.type
    phases.push(phase)
    if (phase === 'cancel') {
      stops++
      quiescent = false // Each stop can enqueue/start synthesis.
      mock.stdout.write(controlWidget('stopping'))
    } else if (phase === 'abort' && stops === 2) quiescent = true
    else if (phase === 'check') {
      assert.equal(phases.at(-2), 'abort')
      mock.stdout.write(controlWidget(quiescent ? 'cancelled' : 'pending'))
    }
    mock.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true }) + '\n')
  })
  const cancellation = proc.abort(lifecycleOwner).then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, false, 'the first native abort exposed new owned work')
  t.mock.timers.tick(25)
  await cancellation
  assert.deepEqual(phases, [
    'clear_queue',
    'abort',
    'cancel',
    'clear_queue',
    'abort',
    'check',
    'cancel',
    'clear_queue',
    'abort',
    'check'
  ])
  assert.equal(mock.killed, false)
  assert.equal(quiescent, true)
})

test('PiRpcProcess: reserved public control prompts never write stdin', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  const lines = collectStdin(mock)
  for (const operation of ['begin', 'cancel', 'check']) {
    await assert.rejects(proc.prompt(`/pi-acp-control ${operation} ${lifecycleOwner}`), /reserved for the adapter/)
  }
  assert.deepEqual(lines, [])
})

for (const boundary of ['clear_queue', 'abort']) {
  for (const close of [false, true]) {
    test(`PiRpcProcess: owner upgrade during ${boundary} shares deadline and ${close ? 'disposes after' : 'awaits'} owned stop`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
      const mock = new MockChild()
      const proc = PiRpcProcess.fromChild(asChild(mock))
      const commands: Array<{ type: string; message?: string }> = []
      let release!: () => void
      let held = false
      mock.stdin.on('data', chunk => {
        const command = JSON.parse(String(chunk))
        commands.push(command)
        const reply = () =>
          mock.stdout.write(
            JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true }) + '\n'
          )
        if (command.type === boundary && !held) {
          held = true
          release = reply
          return
        }
        if (command.type === 'prompt') {
          assert.match(command.message, new RegExp(`^/pi-acp-control (cancel|check) ${lifecycleOwner} 10000$`))
          mock.stdout.write(controlWidget(command.message.includes(' check ') ? 'cancelled' : 'stopping'))
        }
        reply()
      })
      const initial = proc.abort()
      await tick()
      t.mock.timers.tick(2000)
      const upgraded = close ? (proc.dispose({ backgroundOwner: lifecycleOwner }), initial) : proc.abort(lifecycleOwner)
      release()
      await Promise.all([initial, upgraded])
      await tick()
      assert.equal(commands.filter(c => c.type === 'prompt').length, 2)
      assert.equal(mock.killed, close)
      mock.emit('close', 0, null)
    })
  }
}

for (const ending of ['settlement', 'channel-death', 'ordinary-read-timeout']) {
  test(`PiRpcProcess: only admission response budget excludes native unsettled hook time: ${ending}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const mock = new MockChild()
    const proc = PiRpcProcess.fromChild(asChild(mock))
    t.after(() => mock.emit('close', 0, null))
    const lines = collectStdin(mock)
    mock.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk))
      if (command.type === 'get_commands')
        mock.stdout.write(
          JSON.stringify({
            type: 'response',
            id: command.id,
            command: command.type,
            success: true,
            data: { commands: [{ name: 'pi-acp-control' }] }
          }) + '\n'
        )
    })
    mock.stdout.write('{"type":"agent_start"}\n{"type":"agent_end"}\n')
    const stage = proc.stagePrompt('11111111-1111-4111-8111-111111111111').then(
      () => undefined,
      error => error
    )
    await tick()
    t.mock.timers.tick(600_001)
    await tick()
    assert.deepEqual(mock.kills, [], 'unsettled native hook cannot consume admission ACK budget')
    assert.equal(proc.hasPendingRequests(), false, 'admission bookkeeping is not uncancellable foreground/manual work')
    if (ending === 'channel-death') {
      mock.emit('close', 23, null)
      assert.ok((await stage) instanceof PiRpcClosedError)
    } else if (ending === 'ordinary-read-timeout') {
      const read = proc.getState().catch(error => error)
      t.mock.timers.tick(30_001)
      await tick()
      assert.ok((await read) instanceof PiRpcRequestTimeoutError, 'ordinary reads retain their wall-clock deadline')
      assert.ok((await stage) instanceof PiRpcClosedError)
      assert.deepEqual(mock.kills, ['SIGTERM'])
    } else {
      mock.stdout.write('{"type":"agent_settled"}\n')
      t.mock.timers.tick(29_999)
      await tick()
      assert.deepEqual(mock.kills, [])
      t.mock.timers.tick(2)
      await tick()
      assert.ok(
        (await stage) instanceof PiRpcRequestTimeoutError,
        'unanswered admission after idle remains fail-closed'
      )
      assert.deepEqual(mock.kills, ['SIGTERM'])
    }
    assert.ok(lines.some(line => JSON.parse(line).message?.includes('begin')))
  })
}

test('PiRpcProcess: a run starting before ready response prevents raw preacceptance delivery', async t => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  t.after(() => mock.emit('close', 0, null))
  const lines = collectStdin(mock)
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    if (command.type === 'get_commands')
      mock.stdout.write(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data: { commands: [{ name: 'pi-acp-control' }] }
        }) + '\n'
      )
    else if (command.message?.includes('begin')) {
      const owner = command.message.split(' ')[2]
      mock.stdout.write(
        [
          {
            type: 'extension_ui_request',
            id: 'widget',
            method: 'setWidget',
            widgetKey: 'pi-acp-lifecycle',
            widgetLines: [JSON.stringify({ version: 1, owner, state: 'ready' })]
          },
          { type: 'agent_start' },
          { type: 'response', id: command.id, command: command.type, success: true }
        ]
          .map(record => JSON.stringify(record))
          .join('\n') + '\n'
      )
    }
  })
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    if (command.message === 'must remain locally staged')
      mock.stdout.write(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: 'prompt',
          success: true,
          data: { disposition: 'started' }
        }) + '\n'
      )
  })
  const result = await proc
    .prompt('must remain locally staged', [], undefined, '11111111-1111-4111-8111-111111111111')
    .catch(error => error)
  assert.ok(result instanceof Error)
  assert.equal(result.constructor.name, 'PiRpcPromptDeferredError')
  assert.equal(lines.filter(line => JSON.parse(line).message === 'must remain locally staged').length, 0)
  assert.deepEqual(mock.kills, [])
})

test('PiRpcProcess: live admission timer pauses and resumes only its remaining idle budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock))
  t.after(() => mock.emit('close', 0, null))
  const lines = collectStdin(mock)
  mock.stdin.on('data', chunk => {
    const command = JSON.parse(String(chunk))
    if (command.type === 'get_commands')
      mock.stdout.write(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data: { commands: [{ name: 'pi-acp-control' }] }
        }) + '\n'
      )
  })
  let outcome: unknown
  const stage = proc.stagePrompt('11111111-1111-4111-8111-111111111111').then(
    () => {
      outcome = 'accepted'
    },
    (error: unknown) => {
      outcome = error
      return error
    }
  )
  await tick()
  assert.ok(
    lines.some(line => JSON.parse(line).message?.includes('begin')),
    'idle begin has an armed response timer'
  )
  t.mock.timers.tick(20_000)
  mock.stdout.write('{"type":"agent_start"}\n{"type":"agent_end"}\n')
  t.mock.timers.tick(600_001)
  await tick()
  assert.deepEqual(mock.kills, [], 'new native work pauses the already-live timer through awaited settlement hooks')
  assert.equal(outcome, undefined)
  mock.stdout.write('{"type":"agent_settled"}\n')
  t.mock.timers.tick(9_999)
  await tick()
  assert.deepEqual(mock.kills, [], 'remaining idle budget has not expired')
  assert.equal(outcome, undefined)
  t.mock.timers.tick(2)
  await tick()
  assert.deepEqual(mock.kills, ['SIGTERM'], 'resume must not reset admission to a fresh thirty-second budget')
  const error = await stage
  assert.ok(error instanceof PiRpcRequestTimeoutError)
  assert.equal(proc.hasPendingRequests(), false)
})
