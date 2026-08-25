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

  const record = JSON.stringify({ type: 'marker', text: 'a\u2028b\u2029c' })
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

  const record = Buffer.from(JSON.stringify({ type: 'marker', text: 'héllo 🌍 world' }) + '\n', 'utf8')
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
  mock.stdout.write(JSON.stringify({ type: 'marker', ok: true }) + '\n')
  await tick()

  assert.deepEqual(events, [{ type: 'marker', ok: true }])
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

  mock.stdout.write('{"type":"one"}\n{"type":"two"}\n')
  await tick()

  assert.deepEqual(
    seen.map(ev => ev.type),
    ['one', 'two']
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

test('PiRpcProcess: prompt wires followUp streaming behavior and resolves on success', async () => {
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
  // Non-interrupting TOCTOU backstop: pi only consults streamingBehavior when
  // already streaming, where a bare prompt would be rejected outright.
  assert.equal(request.streamingBehavior, 'followUp')

  // A success response (immediate acceptance or queued as follow-up) resolves.
  // The synchronous callback is the exact ownership boundary: records already
  // ahead of the response remain foreign, while later records in the same
  // stdout chunk observe acceptance before Promise callbacks can run.
  mock.stdout.write(
    [
      JSON.stringify({ type: 'foreign_start' }),
      JSON.stringify({ type: 'response', id: request.id, command: 'prompt', success: true }),
      JSON.stringify({ type: 'accepted_start' })
    ].join('\n') + '\n'
  )
  await prompt
  assert.deepEqual(ordering, ['foreign_start', 'accepted', 'accepted_start'])
  proc.dispose()
})

test('PiRpcProcess: close fallback settles once and ignores later pipe data', async () => {
  const mock = new MockChild()
  const proc = PiRpcProcess.fromChild(asChild(mock), { closeFallbackMs: 20 })
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  const terminationPromise = new Promise<PiRpcTermination>(resolve => proc.onTermination(resolve))

  mock.stdout.write('{"type":"before-exit"}\n')
  mock.emit('exit', 4, null)
  const termination = await withTimeout(terminationPromise, 250, 'close fallback')
  assert.equal(termination.code, 4)
  assert.deepEqual(
    events.map(event => event.type),
    ['before-exit']
  )

  mock.stdout.write('{"type":"after-fallback"}\n')
  await tick()
  assert.deepEqual(
    events.map(event => event.type),
    ['before-exit']
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
    if (ev.type === 'marker') events.push(ev)
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
        if (event.type === 'ready') resolve()
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
