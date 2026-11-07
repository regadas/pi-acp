import test from 'node:test'
import assert from 'node:assert/strict'
import { killPosixProcessGroup, type GroupSignal } from '../../src/pi-rpc/process-tree.js'

type ScriptedGroup = {
  signalGroup: GroupSignal
  signals: Array<NodeJS.Signals | 0>
  /** Make the group disappear once `survives` signals of the given kind arrived. */
  dieAfter: (survives: number, on: NodeJS.Signals) => void
}

function scriptedGroup(): ScriptedGroup {
  const signals: Array<NodeJS.Signals | 0> = []
  let lives = true
  let survives = 0
  let on: NodeJS.Signals = 'SIGTERM'
  const signalGroup: GroupSignal = (_pgid, signal) => {
    if (signal === 0) {
      if (!lives) throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      return
    }
    signals.push(signal)
    if (signal === on && survives > 0 && --survives === 0) lives = false
  }
  return {
    signalGroup,
    signals,
    dieAfter: (count, kind) => {
      survives = count
      on = kind
    }
  }
}

test('killPosixProcessGroup confirms once the group is gone after SIGTERM', async () => {
  const group = scriptedGroup()
  group.dieAfter(1, 'SIGTERM')
  const result = await killPosixProcessGroup(12, 60, 60, {
    signalGroup: group.signalGroup,
    pollMs: 5
  })
  assert.deepEqual(result, { confirmed: true })
  assert.deepEqual(group.signals, ['SIGTERM'], 'no SIGKILL is sent when SIGTERM empties the group')
})

test('killPosixProcessGroup escalates to SIGKILL after the grace', async () => {
  const group = scriptedGroup()
  group.dieAfter(1, 'SIGKILL')
  const result = await killPosixProcessGroup(12, 20, 200, {
    signalGroup: group.signalGroup,
    pollMs: 5
  })
  assert.deepEqual(result, { confirmed: true })
  assert.deepEqual(group.signals, ['SIGTERM', 'SIGKILL'], 'a group surviving SIGTERM is SIGKILLed')
})

test('killPosixProcessGroup with zero grace force-kills without SIGTERM', async () => {
  const group = scriptedGroup()
  group.dieAfter(1, 'SIGKILL')
  const result = await killPosixProcessGroup(12, 0, 200, {
    signalGroup: group.signalGroup,
    pollMs: 5
  })
  assert.deepEqual(result, { confirmed: true })
  assert.deepEqual(group.signals, ['SIGKILL'], 'the probe-style force kill skips the SIGTERM grace')
})

test('killPosixProcessGroup fails closed when the group survives the deadline', async () => {
  const group = scriptedGroup()
  const result = await killPosixProcessGroup(12, 10, 20, {
    signalGroup: group.signalGroup,
    pollMs: 5
  })
  assert.equal(result.confirmed, false)
  assert.match(result.reason, /survived the kill/)
  assert.deepEqual(group.signals.slice(0, 2), ['SIGTERM', 'SIGKILL'])
})

test('killPosixProcessGroup resolves unconfirmed when the first signal fails', async () => {
  const signalGroup: GroupSignal = () => {
    throw new Error('permission denied')
  }
  const result = await killPosixProcessGroup(12, 20, 20, { signalGroup, pollMs: 5 })
  assert.equal(result.confirmed, false)
  assert.match(result.reason, /group SIGTERM failed/)
})

test('killPosixProcessGroup confirms termination when the group disappears before escalation', async () => {
  const signals: Array<NodeJS.Signals | 0> = []
  const signalGroup: GroupSignal = (_pgid, signal) => {
    if (signal === 0) return
    signals.push(signal)
    if (signal === 'SIGKILL') throw Object.assign(new Error('not found'), { code: 'ESRCH' })
  }
  const result = await killPosixProcessGroup(12, 20, 200, { signalGroup, pollMs: 5 })
  assert.deepEqual(result, { confirmed: true }, 'an ESRCH from the escalation signal means the group is already gone')
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('killPosixProcessGroup confirms a group that is already gone before the first signal', async () => {
  const signalGroup: GroupSignal = () => {
    throw Object.assign(new Error('not found'), { code: 'ESRCH' })
  }
  const result = await killPosixProcessGroup(12, 20, 20, { signalGroup, pollMs: 5 })
  assert.deepEqual(result, { confirmed: true }, "an empty group is the kill's success condition, not a failure")
})
