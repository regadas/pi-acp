import test from 'node:test'
import assert from 'node:assert/strict'
import { isThinkingLevel, supportedThinkingLevels } from '../../src/acp/thinking-levels.js'

test('isThinkingLevel: accepts every pi 0.80.10 level including max', () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(isThinkingLevel(level), true, level)
  }
  assert.equal(isThinkingLevel('ultra'), false)
})

test('supportedThinkingLevels: non-reasoning models support only off', () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ['off'])
  assert.deepEqual(supportedThinkingLevels({}), ['off'])
  assert.deepEqual(supportedThinkingLevels({ reasoning: 'yes' }), ['off'])
})

test('supportedThinkingLevels: reasoning model without a map gets base levels only', () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high'])
})

test('supportedThinkingLevels: xhigh and max require a defined non-null mapping', () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }), [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
  ])
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }), [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ])
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: null, max: 'max' } }), [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'max'
  ])
})

test('supportedThinkingLevels: null mappings disable base levels (Kimi-like max-only models)', () => {
  // Mirror of pi 0.80.10's Kimi Coding K3 metadata: only `max` is exposed.
  const kimiLike = {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max' }
  }
  assert.deepEqual(supportedThinkingLevels(kimiLike), ['max'])

  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null } }), [
    'off',
    'low',
    'medium',
    'high'
  ])
})
