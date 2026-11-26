import test from 'node:test'
import assert from 'node:assert/strict'
import {
  boundedFieldKey,
  resultHasDetailsDiff,
  sameBoundedField,
  ToolCallStateTracker
} from '../../src/acp/translate/tool-call-state.js'

test('ToolCallStateTracker: emits minimal deltas, blocks status downgrades and post-terminal edits, and clears locations', () => {
  const tracker = new ToolCallStateTracker()
  const initial = tracker.begin({
    toolCallId: 'tc-1',
    name: 'edit',
    title: 'edit src/a.ts',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: '/repo/src/a.ts', line: 10 }],
    rawInput: { path: 'src/a.ts' }
  })
  assert.deepEqual(initial, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    name: 'edit',
    title: 'edit src/a.ts',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: '/repo/src/a.ts', line: 10 }],
    rawInput: { path: 'src/a.ts' }
  })

  // Identical fields suppress no-op deltas.
  assert.equal(
    tracker.delta('tc-1', {
      status: 'pending',
      title: 'edit src/a.ts',
      kind: 'edit',
      locations: [{ path: '/repo/src/a.ts', line: 10 }],
      rawInput: { path: 'src/a.ts' }
    }),
    null
  )

  // Advance status and clear locations explicitly with [].
  assert.deepEqual(tracker.delta('tc-1', { status: 'in_progress', clearLocations: true }), {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'in_progress',
    locations: []
  })

  // Repeating clearLocations once cleared is a no-op; status downgrade is ignored.
  assert.equal(tracker.delta('tc-1', { status: 'pending', clearLocations: true }), null)

  // Terminal transition emits once, then ignores subsequent deltas.
  assert.deepEqual(tracker.delta('tc-1', { status: 'completed', rawOutput: { ok: true } }), {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    rawOutput: { ok: true }
  })
  assert.equal(tracker.delta('tc-1', { status: 'failed', title: 'late' }), null)
  assert.equal(tracker.delta('unknown', { status: 'in_progress' }), null)
})

test('ToolCallStateTracker: tracks diff previews and bounded field comparisons', () => {
  const tracker = new ToolCallStateTracker()
  tracker.begin({ toolCallId: 'tc-2', title: 'edit', kind: 'edit', status: 'in_progress' })
  assert.deepEqual(tracker.getDiffPreview('tc-2'), { hadDiffPreview: false, lastDiffContent: undefined })

  const preview = [{ type: 'content' as const, content: { type: 'text' as const, text: '@@ -1 +1 @@' } }]
  tracker.recordDiffPreview('tc-2', preview)
  assert.deepEqual(tracker.getDiffPreview('tc-2'), { hadDiffPreview: true, lastDiffContent: preview })

  tracker.delete('tc-2')
  assert.equal(tracker.getDiffPreview('tc-2'), undefined)

  // Bounded keys cap large payloads (strings, oversized nested objects, and cycles)
  // while still matching identical object references.
  const huge = 'x'.repeat(20_000)
  assert.equal(boundedFieldKey(huge), null)
  assert.equal(boundedFieldKey({ nested: [{ payload: huge }] }), null)
  const manyKeys: Record<string, string> = {}
  for (let i = 0; i < 2_000; i += 1) manyKeys[`k${i}`] = '1234567890'
  assert.equal(boundedFieldKey(manyKeys), null)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(boundedFieldKey(circular), null)
  assert.equal(sameBoundedField(huge, null, huge, null), true)
  assert.equal(sameBoundedField({ a: huge }, null, { a: huge }, null), false)

  assert.equal(resultHasDetailsDiff({ details: { diff: '--- a\n+++ b' } }), true)
  assert.equal(resultHasDetailsDiff({ details: { diff: '   ' } }), false)
  assert.equal(resultHasDetailsDiff(null), false)
})
