import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandArgs } from '../../src/acp/slash-commands.js'

test('parseCommandArgs handles whitespace and quotes for adapter builtins', () => {
  assert.deepEqual(parseCommandArgs(`one "two three" 'four five'`), ['one', 'two three', 'four five'])
})
