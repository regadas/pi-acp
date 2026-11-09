import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendTitleContext,
  buildTitlePrompt,
  decodeTitleWidget,
  encodeTitleWidget,
  firstMessageTitle,
  titleFromModelOutput
} from '../../src/acp/session-title.js'

test('buildTitlePrompt: caps model input and keeps one neutral excerpt header', () => {
  const prompt = buildTitlePrompt('x'.repeat(9000))

  assert.match(prompt, /^Generate a very short title/)
  // One header for every path: the prompt is also used for the turn-end tail.
  assert.equal(prompt.split('Conversation excerpt:\n')[1]?.length, 4000)
  assert.equal(prompt.includes("User's first message:"), false)
  assert.equal(prompt.includes('first message'), false)
})

test('titleFromModelOutput: accepts only a JSON title, including fenced or wrapped replies', () => {
  assert.equal(titleFromModelOutput('{"title":"Fix ACP Session Titles"}'), 'Fix ACP Session Titles')
  assert.equal(
    titleFromModelOutput('Sure:\n```json\n{"title":"Fix ACP Session Titles"}\n```'),
    'Fix ACP Session Titles'
  )
  assert.equal(titleFromModelOutput('{"title":"   "}'), null)
  assert.equal(titleFromModelOutput('{"nope":1}'), null)
  // A reasoning model's prose is never a title, even when it looks short.
  assert.equal(titleFromModelOutput('Fix ACP session titles.'), null)
  assert.equal(titleFromModelOutput('We need answer only JSON object with title.'), null)
  assert.equal(titleFromModelOutput('  \n\n  '), null)
})

test('titleFromModelOutput: normalizes and truncates without splitting surrogate pairs', () => {
  assert.equal(titleFromModelOutput('{"title":"  \\"Fix   the   title\\"  "}'), 'Fix the title')

  // 256 code points, the cap both reference ACP agents publish with (the trim
  // may shorten it further).
  const long = titleFromModelOutput(`{"title":"${'word '.repeat(60)}"}`)
  assert.equal(long?.endsWith('…'), true)
  assert.ok(Array.from(long ?? '').length <= 256)
  assert.ok(Array.from(long ?? '').length > 200)
})

test('appendTitleContext: keeps only the trailing 1000 characters', () => {
  const grown = appendTitleContext(appendTitleContext(undefined, 'a'.repeat(800)), 'b'.repeat(800))
  assert.equal(grown.length, 1000)
  assert.equal(grown.endsWith('b'), true)
  assert.equal(appendTitleContext(undefined, 'short'), 'short')
})

test('title widget: never splits a surrogate pair at the cap', () => {
  // Odd offset before 300 emoji: the cap lands in the middle of a pair, where a
  // UTF-16 slice used to leave a lone high surrogate that strict clients reject.
  const normalized = titleFromModelOutput(JSON.stringify({ title: `a${'🚀'.repeat(300)}` }))
  assert.ok(normalized)
  assert.ok(Array.from(normalized).length <= 256)
  const wire = encodeTitleWidget(normalized)
  const payload = JSON.parse(wire[0]!) as { title: string }
  assert.equal(/[\uD800-\uDBFF]$/.test(payload.title), false)
  assert.equal(/[\uDC00-\uDFFF]$/.test(payload.title), false)
  assert.equal(decodeTitleWidget(wire)?.title, normalized)
})

test('firstMessageTitle: drops fences and attachments, keeps one short sentence', () => {
  assert.equal(
    firstMessageTitle('Please rename @src/acp/session.ts\n```ts\nconst a = 1\n```\nthanks'),
    'Please rename thanks'
  )
  assert.equal(firstMessageTitle('Fix the title. Then also do the other thing.'), 'Fix the title')
  assert.equal(firstMessageTitle('a b c d e f g h i j k l m n o p'), 'a b c d e f g h i j k l')
  assert.equal(firstMessageTitle('   \n  '), null)
})

test('title widget: round-trips through the shared codec and rejects anything else', () => {
  const lines = encodeTitleWidget('Fix ACP Session Titles')
  assert.deepEqual(lines, ['{"version":1,"title":"Fix ACP Session Titles"}'])
  assert.deepEqual(decodeTitleWidget(lines), { title: 'Fix ACP Session Titles', provisional: false })
  assert.deepEqual(decodeTitleWidget(encodeTitleWidget('Placeholder', true)), {
    title: 'Placeholder',
    provisional: true
  })

  assert.equal(decodeTitleWidget(undefined), null)
  assert.equal(decodeTitleWidget([]), null)
  assert.equal(decodeTitleWidget(['not json']), null)
  assert.equal(decodeTitleWidget(['{"version":2,"title":"nope"}']), null)
  // The adapter must not trust the extension's payload verbatim.
  assert.deepEqual(decodeTitleWidget(['{"version":1,"title":"  padded   title "}']), {
    title: 'padded title',
    provisional: false
  })
  assert.equal(decodeTitleWidget(['{"version":1,"title":"   "}']), null)
})
