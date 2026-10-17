import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcRequestTimeoutError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: child exit after prompt accepted + agent_start fails the turn instead of hanging', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } })
  await tick()

  proc.emitTermination({ code: 1, stderrTail: 'fatal: out of memory' })

  await assert.rejects(p, (e: any) => {
    assert.equal(e?.code, -32603)
    assert.match(String(e?.message), /exited unexpectedly \(code=1/)
    assert.match(String(e?.message), /out of memory/)
    return true
  })

  // Already-enqueued turn updates must have been delivered before rejection.
  const texts = conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text)
  assert.ok(texts.includes('partial '))
})

test('PiAcpSession: child exit settles queued prompts along with the active turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')
  proc.emit({ type: 'agent_start' })
  await tick()
  assert.equal(proc.prompts.length, 1)

  proc.emitTermination({ code: 1 })

  const results = await Promise.allSettled([first, second, third])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    assert.equal((result as PromiseRejectedResult).reason?.code, -32603)
  }
  assert.equal(proc.prompts.length, 1, 'queued prompts must not be sent to a dead child')
})

test('PiAcpSession: child exit after client cancellation still resolves cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await session.cancel()

  proc.emitTermination({ code: 0, signal: null, stderrTail: 'permission denied: authentication required' })

  assert.equal(await p, 'cancelled')
})

test('PiAcpSession: adapter-requested (expected) termination settles the turn as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await tick()

  proc.emitTermination({ code: 0, expected: true })

  assert.equal(await p, 'cancelled')
})

test('PiAcpSession: duplicate termination deliveries settle the turn exactly once', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  await tick()

  proc.emitTermination({ code: 1 })
  proc.emitTermination({ code: 2 })

  await assert.rejects(p, (e: any) => {
    assert.match(String(e?.message), /code=1/)
    return true
  })

  // A late agent_settled from buffered output must not double-settle either.
  proc.emit({ type: 'agent_settled' })
  await tick()
})

test('PiAcpSession: abort failure disposes the child and settles active and queued turns as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abort = async () => {
    proc.abortCount += 1
    throw new PiRpcRequestTimeoutError('abort', 10)
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })

  await session.cancel()

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(await session.prompt('after-dead-channel'), 'cancelled')

  const updatesAfterSettlement = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(conn.updates.length, updatesAfterSettlement, 'disposed session must ignore late pi output')
})

test('PiAcpSession: prompt timeout rejects, disposes, and suppresses late events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message, attachments = []) => {
    proc.prompts.push({ message, attachments })
    throw new PiRpcRequestTimeoutError('prompt', 10)
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')

  await assert.rejects(first, (error: any) => {
    assert.equal(error?.code, -32603)
    assert.match(String(error?.message), /prompt timed out/)
    return true
  })
  await assert.rejects(second, (error: any) => {
    assert.equal(error?.code, -32603)
    return true
  })
  assert.equal(proc.disposeCount, 1)

  const updatesAfterSettlement = conn.updates.length
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(conn.updates.length, updatesAfterSettlement)
})

test('PiAcpSession: shutdown still settles when abort rejects (e.g. abort timeout)', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abort = async () => {
    proc.abortCount += 1
    throw new Error('pi abort timed out after 10000ms')
  }
  const session = makeSession(conn, proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  await tick()

  const shutdown = session.shutdown()
  proc.emit({ type: 'agent_settled' })

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  await shutdown
  assert.equal(proc.abortCount, 1)
})

for (const history of ['none', 'idle-cancel', 'active-cancel', 'intervening-success']) {
  test(`PiAcpSession: fresh parked and queued work rejects death after ${history}`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = makeSession(conn, proc)
    if (history === 'idle-cancel') await session.cancel()
    if (history === 'active-cancel' || history === 'intervening-success') {
      const old = session.prompt('old')
      proc.emit({ type: 'agent_start' })
      await session.cancel()
      proc.emit({ type: 'agent_settled' })
      assert.equal(await old, 'cancelled')
      assert.equal(proc.disposed, false)
    }
    if (history === 'intervening-success') {
      proc.state = { isStreaming: false }
      assert.equal(await session.prompt('success'), 'end_turn')
    }
    proc.emit({ type: 'agent_start' })
    let ran = false
    const parked = session.runCommand(async () => {
      ran = true
      return 'unexpected'
    })
    const queuedCommand = session.runCommand(async () => {
      ran = true
      return 'unexpected'
    })
    const queuedPrompt = session.prompt('queued')
    const resultsPromise = Promise.allSettled([parked, queuedCommand, queuedPrompt])
    await tick()
    assert.equal(ran, false)
    proc.emitTermination({ code: 7, stderrTail: 'fatal audit crash' })
    for (const result of await resultsPromise) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.equal(result.reason.code, -32603)
        assert.match(result.reason.message, /code=7.*fatal audit crash/s)
      }
    }
    assert.equal(ran, false)
    session.dispose()
  })
}

test('PiAcpSession: current command cancellation still dominates a subsequent unexpected exit', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const command = session.runCommand(async () => {
    await gate
    return 'late'
  })
  await tick()
  await session.cancel()
  proc.emitTermination({ code: 7 })
  release()
  assert.equal(await command, null)
  session.dispose()
})

// Real-child composition for the unexpected-quarantine channel failure: a real
// PiRpcProcess.fromChild wrapper child plus a real PiAcpSession. The fixture
// speaks the lifecycle bridge so a prompt is staged, accepted and observed
// running (agent_start, no pending prompt RPC); the wrapper root then exits
// and an asynchronous stdin fault quarantines the channel while the
// process-tree termination barrier is held (killTree seam, never confirmed).
// The one-shot channel-unusable notification must settle accepted and queued
// work visibly — flushing updates and preserving cancellation precedence —
// without ever releasing the termination/retirement barrier or targeting the
// reaped pid.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiRpcProcess, type PiRpcTermination } from '../../src/pi-rpc/process.js'
import { SessionManager } from '../../src/acp/session-manager.js'
import { SessionStore } from '../../src/acp/session-store.js'

const WRAPPER_FIXTURE = fileURLToPath(new URL('../fixtures/fake-pi-admitted-wrapper.mjs', import.meta.url))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function admittedWrapperSession(t: import('node:test').TestContext, hold: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-channel-unusable-'))
  const pidFile = join(dir, 'pids.txt')
  const previousPidFile = process.env.PI_ACP_TEST_TREE_PID_FILE
  process.env.PI_ACP_TEST_TREE_PID_FILE = pidFile

  const child = spawn(process.execPath, [WRAPPER_FIXTURE, hold ? 'hold' : ''], { stdio: 'pipe' })
  let killTreeCalls = 0
  const proc = PiRpcProcess.fromChild(child, {
    // A never-settling tree kill models the held barrier: the seam's presence
    // gates termination settlement exactly like a cmd.exe wrapper child.
    killTree: () => {
      killTreeCalls += 1
      return new Promise(() => {})
    },
    closeFallbackMs: 60_000,
    requestTimeoutMs: 5_000
  })
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({ sessionId: 'chan-1', cwd: dir, proc, conn: asAgentConn(conn) })

  t.after(() => {
    if (previousPidFile === undefined) delete process.env.PI_ACP_TEST_TREE_PID_FILE
    else process.env.PI_ACP_TEST_TREE_PID_FILE = previousPidFile
    proc.dispose()
    try {
      child.kill('SIGKILL')
    } catch {
      /* Best-effort cleanup. */
    }
    try {
      const [grandchildPid, wrapperPid] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
      for (const pid of [grandchildPid, wrapperPid]) {
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* Raced natural exit. */
          }
        }
      }
    } catch {
      /* No pid report: nothing to clean up. */
    }
  })

  return {
    child,
    proc,
    session,
    conn,
    dir,
    pidFile,
    sessionFile: join(dir, 'session.jsonl'),
    killTreeCalls: () => killTreeCalls,
    agentStarted: new Promise<void>(resolve => {
      proc.onEvent(ev => {
        if (ev.type === 'agent_start') resolve()
      })
    }),
    exited: new Promise<void>(resolve => {
      child.once('exit', () => resolve())
    }),
    closed: new Promise<void>(resolve => {
      child.once('close', () => resolve())
    })
  }
}

async function admitAndAccept(t: import('node:test').TestContext) {
  // The holder grandchild keeps the wrapper's stdio pipes open, so no close
  // event can precede the injected fault: the quarantine is observably the
  // first terminal event on the channel.
  const harness = await admittedWrapperSession(t, true)
  const first = harness.session.prompt('hello')
  await bounded(harness.agentStarted, 5_000, 'agent_start after acceptance')
  // Queued behind the accepted turn; nothing but disposal or settlement can
  // start it.
  const second = harness.session.prompt('two')
  return { ...harness, first, second }
}

function readHolderPid(pidFile: string): number {
  const [grandchildPid] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)
  return grandchildPid
}

for (const variant of ['late-close', 'withheld-close'] as const) {
  test(
    `PiAcpSession/PiRpcProcess: an unexpected quarantine behind a held tree barrier settles accepted and queued work (${variant})`,
    { timeout: 10_000 },
    async t => {
      const { child, proc, session, conn, sessionFile, pidFile, killTreeCalls, first, second, closed } =
        await admitAndAccept(t)
      let terminated = false
      void proc.whenTerminated().then(() => {
        terminated = true
      })
      const terminations: PiRpcTermination[] = []
      proc.onTermination(info => terminations.push(info))

      // The wrapper root exits while the holder keeps the pipes open; a later
      // close only proves the direct root and its inherited pipe holders are
      // gone, never the whole tree.
      child.stdin.write(`${JSON.stringify({ type: 'test-exit-wrapper' })}\n`)
      await bounded(
        new Promise<void>(resolve => {
          child.once('exit', () => resolve())
        }),
        5_000,
        'wrapper exit'
      )

      // An asynchronous stdin fault quarantines the channel unexpectedly.
      child.stdin.emit('error', new Error('write EPIPE'))

      await assert.rejects(first, (error: unknown) => {
        assert.match(String((error as Error)?.message ?? ''), /channel is unusable/)
        return true
      })
      await assert.rejects(second, (error: unknown) => {
        assert.match(String((error as Error)?.message ?? ''), /channel is unusable/)
        return true
      })
      assert.ok(
        conn.updates.some(u => (u.update as { content?: { text?: string } }).content?.text?.includes('partial ')),
        'buffered turn updates flush before the rejections'
      )
      assert.equal(session.isUnavailable(), true, 'the session is unusable for later requests')

      if (variant === 'late-close') {
        // Release the pipes only now: the close that follows the quarantine
        // must not be treated as whole-tree death evidence.
        process.kill(readHolderPid(pidFile), 'SIGKILL')
        await bounded(closed, 5_000, 'late close after the quarantine')
      } else {
        await sleep(150)
      }

      assert.equal(killTreeCalls(), 0, 'a reaped root pid is never tree-killed')
      assert.equal(terminations.length, 0, 'no termination record is synthesized')
      assert.equal(terminated, false, 'the termination barrier stays held')
      await sleep(150)
      assert.equal(terminated, false, 'neither a late close nor withheld pipes release the barrier')

      // The retirement barrier stays fail-closed for restore/delete: no
      // replacement writer may open the session file behind the held tree.
      const manager = new SessionManager(new SessionStore())
      manager.retireProcess('chan-1', proc, [sessionFile])
      await assert.rejects(
        bounded(manager.waitForRetiredProcesses(['chan-1', sessionFile], 50), 5_000, 'retirement barrier'),
        /did not exit within/
      )
    }
  )
}

test(
  'PiAcpSession/PiRpcProcess: client cancellation keeps precedence over a held-barrier quarantine',
  { timeout: 10_000 },
  async t => {
    const { child, session, killTreeCalls, first, second } = await admitAndAccept(t)

    // The client cancels while the turn is accepted: the transaction settles
    // against the still-live channel, and the fault must not reclassify the
    // already-cancelled work into an error.
    await session.cancel()

    child.stdin.write(`${JSON.stringify({ type: 'test-exit-wrapper' })}\n`)
    await bounded(
      new Promise<void>(resolve => {
        child.once('exit', () => resolve())
      }),
      5_000,
      'wrapper exit'
    )
    child.stdin.emit('error', new Error('write EPIPE'))

    assert.equal(await first, 'cancelled')
    assert.equal(await second, 'cancelled')
    assert.equal(killTreeCalls(), 0)
  }
)
