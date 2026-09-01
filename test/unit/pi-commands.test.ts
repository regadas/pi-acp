import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands preserves pi-authoritative commands including extensions and skills', () => {
  const { commands } = toAvailableCommandsFromPiGetCommands({
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  })
  assert.deepEqual(commands, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])
})

test('toAvailableCommandsFromPiGetCommands ignores malformed names', () => {
  assert.deepEqual(toAvailableCommandsFromPiGetCommands({ commands: [{ name: '' }, {}] }).commands, [])
})
