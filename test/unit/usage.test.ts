import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  combineOwnedTurnUsage,
  extractPiEventUsage,
  extractPiUsage,
  finiteNonNegative,
  parseSessionStatsUsage
} from '../../src/acp/translate/usage.js'

test('finiteNonNegative: accepts finite >= 0 numbers only', () => {
  assert.equal(finiteNonNegative(0), 0)
  assert.equal(finiteNonNegative(42.5), 42.5)
  assert.equal(finiteNonNegative(-1), undefined)
  assert.equal(finiteNonNegative(Number.NaN), undefined)
  assert.equal(finiteNonNegative(Number.POSITIVE_INFINITY), undefined)
  assert.equal(finiteNonNegative('10'), undefined)
})

test('extractPiUsage and extractPiEventUsage: normalize Pi and ACP usage shapes', () => {
  assert.deepEqual(extractPiUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 18,
    cachedReadTokens: 2,
    cachedWriteTokens: 1
  })
  assert.deepEqual(extractPiUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7, thoughtTokens: 1 }), {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
    thoughtTokens: 1
  })
  assert.equal(extractPiUsage({ input: 10 }), null)
  assert.equal(extractPiUsage(null), null)

  assert.deepEqual(
    extractPiEventUsage(
      { type: 'message_end', message: { role: 'assistant', usage: { input: 6, output: 4, totalTokens: 10 } } },
      undefined
    ),
    { inputTokens: 6, outputTokens: 4, totalTokens: 10 }
  )
  assert.equal(
    extractPiEventUsage({ type: 'message_end', message: { role: 'user', usage: { input: 6, output: 4 } } }, undefined),
    null
  )
  assert.deepEqual(
    extractPiEventUsage({ type: 'message_update' }, {
      type: 'text_delta',
      partial: { usage: { input: 2, output: 3 } }
    } as never),
    { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
  )
})

test('addUsage and combineOwnedTurnUsage: sum token fields accurately', () => {
  const first = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 2 }
  const second = { inputTokens: 4, outputTokens: 6, totalTokens: 10, cachedWriteTokens: 1, thoughtTokens: 3 }
  assert.deepEqual(addUsage(null, first), first)
  assert.deepEqual(addUsage(first, second), {
    inputTokens: 14,
    outputTokens: 11,
    totalTokens: 25,
    cachedReadTokens: 2,
    cachedWriteTokens: 1,
    thoughtTokens: 3
  })
  assert.equal(combineOwnedTurnUsage(null, null), undefined)
  assert.deepEqual(combineOwnedTurnUsage(first, null), first)
  assert.deepEqual(combineOwnedTurnUsage(null, second), second)
  assert.deepEqual(combineOwnedTurnUsage(first, second), addUsage(first, second))
})

test('parseSessionStatsUsage: extracts context usage_update dedup key and token totals independently', () => {
  const full = parseSessionStatsUsage({
    tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, total: 19 },
    cost: 0.25,
    contextUsage: { tokens: 7, contextWindow: 100 }
  })
  assert.deepEqual(full, {
    usageUpdate: {
      dedupKey: '7:100:0.25',
      update: {
        sessionUpdate: 'usage_update',
        used: 7,
        size: 100,
        cost: { amount: 0.25, currency: 'USD' }
      }
    },
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 19,
      cachedReadTokens: 3,
      cachedWriteTokens: 2
    }
  })

  const contextOnly = parseSessionStatsUsage({ contextUsage: { tokens: 5, contextWindow: 50 } })
  assert.equal(contextOnly.usage, undefined)
  assert.deepEqual(contextOnly.usageUpdate, {
    dedupKey: '5:50:',
    update: { sessionUpdate: 'usage_update', used: 5, size: 50 }
  })

  assert.deepEqual(parseSessionStatsUsage(null), {})
})
