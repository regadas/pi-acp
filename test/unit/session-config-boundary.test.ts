import test from 'node:test'
import assert from 'node:assert/strict'
import { applySessionModel, getSessionConfiguration } from '../../src/acp/session-config.js'

// Direct unit tests for the get_state/get_available_models trust boundary:
// prefetch presence (own property, even undefined) must suppress the matching
// RPC, and malformed payloads must degrade to conservative configuration.

function countingProc(
  state: unknown,
  availableModels: unknown,
  calls: string[]
): Parameters<typeof getSessionConfiguration>[0] {
  return {
    async getState() {
      calls.push('get_state')
      return state
    },
    async getAvailableModels() {
      calls.push('get_available_models')
      return availableModels
    }
  } as never
}

test('prefetched state and models are consumed without additional RPCs', async () => {
  const calls: string[] = []
  const proc = countingProc({ thinkingLevel: 'off' }, { models: [] }, calls)

  const options = await getSessionConfiguration(proc, {
    state: { thinkingLevel: 'high', model: { provider: 'test', id: 'a', reasoning: true } },
    availableModels: { models: [{ provider: 'test', id: 'a', name: 'A' }] }
  })

  assert.deepEqual(calls, [], 'a present prefetch must suppress its RPC')
  assert.equal(options.find(option => option.id === 'model')?.currentValue, 'test/a')
  assert.equal(options.find(option => option.id === 'thought_level')?.currentValue, 'high')
})

test('an own-present undefined state prefetch still suppresses the get_state RPC', async () => {
  const calls: string[] = []
  const proc = countingProc({ thinkingLevel: 'off' }, { models: [] }, calls)

  const options = await getSessionConfiguration(proc, { state: undefined })

  assert.deepEqual(calls, ['get_available_models'], 'only the absent prefetch is fetched')
  const thought = options.find(option => option.id === 'thought_level')
  assert.equal(thought?.currentValue, 'off', 'an absent state degrades to the conservative level')
  assert.equal(
    options.find(option => option.id === 'model'),
    undefined,
    'no model option without models'
  )
})

test('missing prefetches each trigger exactly one RPC', async () => {
  const calls: string[] = []
  const proc = countingProc({ thinkingLevel: 'off', model: { provider: 'test', id: 'a' } }, { models: [] }, calls)

  const options = await getSessionConfiguration(proc)

  assert.deepEqual(calls, ['get_state', 'get_available_models'])
  assert.equal(options.find(option => option.id === 'thought_level')?.currentValue, 'off')
  assert.equal(
    options.find(option => option.id === 'model'),
    undefined,
    'an empty models list is not advertised'
  )
})

test('malformed models payloads advertise no model option', async () => {
  for (const payload of [null, 'not-an-object', {}, { models: 'not-a-list' }] as unknown[]) {
    const proc = countingProc({ thinkingLevel: 'off', model: { provider: 'test', id: 'a' } }, payload, [])

    const options = await getSessionConfiguration(proc)

    assert.equal(
      options.find(option => option.id === 'model'),
      undefined,
      `payload: ${JSON.stringify(payload)}`
    )
    assert.ok(
      options.find(option => option.id === 'thought_level'),
      `thought options survive a malformed models payload: ${JSON.stringify(payload)}`
    )
  }
})

test('model entries missing provider or id are dropped; valid entries survive with a coerced name', async () => {
  const proc = countingProc(
    { thinkingLevel: 'off' },
    {
      models: [
        { id: 'no-provider' },
        { provider: 'test', name: 'NoId' },
        null,
        'garbage',
        { provider: 'test', id: 'a', name: 'A' },
        { provider: 7, id: ' b ' },
        { provider: 'test', id: 'c', name: 42 }
      ]
    },
    []
  )

  const options = await getSessionConfiguration(proc)
  const model = options.find(option => option.id === 'model') as
    | { currentValue?: unknown; options?: Array<{ value?: unknown; name?: unknown }> }
    | undefined

  assert.deepEqual(
    model?.options?.map(option => option.value),
    ['test/a', '7/b', 'test/c']
  )
  assert.deepEqual(
    model?.options?.map(option => option.name),
    ['test/A', '7/b', 'test/42']
  )
  assert.equal(model?.currentValue, 'test/a', 'an unknown current model falls back to the first advertised')
})

test('a bare model id resolves through the advertised models', async () => {
  const calls: string[] = []
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  const proc = Object.assign(
    countingProc(
      { thinkingLevel: 'off', model: { provider: 'test', id: 'a' } },
      { models: [{ provider: 'test', id: 'a', name: 'A' }] },
      calls
    ),
    {
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
      }
    }
  )

  const state = await applySessionModel(proc, 'a')
  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'a' }])
  assert.deepEqual(calls, ['get_available_models', 'get_state'])
  assert.deepEqual(state, { thinkingLevel: 'off', model: { provider: 'test', id: 'a' } })

  await assert.rejects(() => applySessionModel(proc, 'zzz'), /Unknown modelId: zzz/)
  assert.equal(setModelCalls.length, 1, 'an unknown bare id must not reach set_model')
})

test('a null state payload degrades to conservative configuration', async () => {
  const proc = countingProc(null, { models: [{ provider: 'test', id: 'a', name: 'A' }] }, [])

  const options = await getSessionConfiguration(proc)

  assert.equal(options.find(option => option.id === 'model')?.currentValue, 'test/a')
  const thought = options.find(option => option.id === 'thought_level') as
    | { currentValue?: unknown; options?: Array<{ value?: unknown }> }
    | undefined
  assert.equal(thought?.currentValue, 'off')
  assert.deepEqual(
    thought?.options?.map(option => option.value),
    ['off']
  )
})
