import test from 'node:test'
import assert from 'node:assert/strict'
import { createShutdownCoordinator } from '../../src/acp/shutdown.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

// The stdio entrypoint's shutdown seam. `src/index.ts` only wires this to
// process signals, so the behavior is exercised here instead of importing an
// effectful entrypoint.

class FakeAgent {
  disposeCalls: number[] = []
  private settle: (() => void) | null = null

  disposeAndWait(timeoutMs: number): Promise<void> {
    this.disposeCalls.push(timeoutMs)
    return new Promise<void>(resolve => {
      this.settle = resolve
    })
  }

  finishTermination(): void {
    this.settle?.()
  }
}

function makeCoordinator() {
  const exits: number[] = []
  const coordinator = createShutdownCoordinator<FakeAgent>({
    timeoutMs: 3_000,
    exit: () => exits.push(exits.length)
  })
  return { coordinator, exits }
}

test('shutdown coordinator: exits only after the agent children finished terminating', async () => {
  const { coordinator, exits } = makeCoordinator()
  const agent = new FakeAgent()
  coordinator.trackAgent(agent)

  coordinator.shutdown()
  assert.deepEqual(agent.disposeCalls, [3_000], 'disposal runs with the configured bounded deadline')
  assert.equal(exits.length, 0, 'exiting here would preempt the SIGTERM -> SIGKILL escalation')

  agent.finishTermination()
  await tick()
  assert.equal(exits.length, 1)
})

test('shutdown coordinator: retains the last agent after the connection reported teardown', async () => {
  const { coordinator, exits } = makeCoordinator()
  const agent = new FakeAgent()

  coordinator.trackAgent(agent)
  // An ACP connection abort disposes the agent and clears it from the app; its
  // pi children are still being escalated at that point.
  coordinator.trackAgent(null)

  coordinator.shutdown()
  assert.deepEqual(agent.disposeCalls, [3_000], 'the retained agent is still awaited')
  assert.equal(exits.length, 0)

  agent.finishTermination()
  await tick()
  assert.equal(exits.length, 1)
})

test('shutdown coordinator: a newer connection replaces the retained agent', () => {
  const { coordinator } = makeCoordinator()
  const first = new FakeAgent()
  const second = new FakeAgent()

  coordinator.trackAgent(first)
  coordinator.trackAgent(null)
  coordinator.trackAgent(second)

  coordinator.shutdown()
  assert.deepEqual(first.disposeCalls, [])
  assert.deepEqual(second.disposeCalls, [3_000])
})

test('shutdown coordinator: repeated shutdowns dispose once', () => {
  const { coordinator, exits } = makeCoordinator()
  const agent = new FakeAgent()
  coordinator.trackAgent(agent)

  coordinator.shutdown()
  coordinator.shutdown()
  coordinator.shutdown()

  assert.deepEqual(agent.disposeCalls, [3_000])
  assert.equal(exits.length, 0, 'the single in-flight shutdown still owns the exit')
})

test('shutdown coordinator: exits immediately when no agent ever connected', () => {
  const { coordinator, exits } = makeCoordinator()

  coordinator.shutdown()
  assert.equal(exits.length, 1)
})

test('shutdown coordinator: a failed disposal still exits', async () => {
  const exits: number[] = []
  const coordinator = createShutdownCoordinator<{ disposeAndWait(ms: number): Promise<void> }>({
    timeoutMs: 3_000,
    exit: () => exits.push(exits.length)
  })
  coordinator.trackAgent({ disposeAndWait: async () => Promise.reject(new Error('teardown failed')) })

  coordinator.shutdown()
  await tick()
  assert.equal(exits.length, 1, 'a rejected disposal must not hang the adapter')
})
