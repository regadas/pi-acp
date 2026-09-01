import test from 'node:test'
import assert from 'node:assert/strict'
import { getSessionConfiguration } from '../../src/acp/session-config.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

test('thinking options prefer pi authoritative max-only discovery', async () => {
  const proc = new FakePiRpcProcess()
  proc.state = { thinkingLevel: 'max', model: { provider: 'x', id: 'y', reasoning: true } }
  proc.availableThinkingLevels = ['max']
  const options = await getSessionConfiguration(proc as any)
  const thinking = options.find(option => option.id === 'thought_level') as any
  assert.deepEqual(
    thinking.options.map((option: any) => option.value),
    ['max']
  )
  assert.equal(thinking.currentValue, 'max')
})
