import test from 'node:test'
import assert from 'node:assert/strict'
import { LfLineDecoder, LfLineTooLongError } from '../../src/pi-rpc/line-decoder.js'

test('LfLineDecoder: preserves U+2028/U+2029 inside a single line', () => {
  const decoder = new LfLineDecoder()
  const record = JSON.stringify({ text: 'a\u2028b\u2029c' })

  const lines = decoder.push(Buffer.from(record + '\n', 'utf8'))

  assert.deepEqual(lines, [record])
  assert.deepEqual(JSON.parse(lines[0]!), { text: 'a\u2028b\u2029c' })
})

test('LfLineDecoder: splits multiple LF-delimited lines from one chunk', () => {
  const decoder = new LfLineDecoder()

  const lines = decoder.push('one\ntwo\nthree\n')

  assert.deepEqual(lines, ['one', 'two', 'three'])
})

test('LfLineDecoder: reassembles a line split across chunks', () => {
  const decoder = new LfLineDecoder()

  assert.deepEqual(decoder.push('{"text":"hel'), [])
  assert.deepEqual(decoder.push('lo"}\n{"n":'), ['{"text":"hello"}'])
  assert.deepEqual(decoder.push('1}\n'), ['{"n":1}'])
})

test('LfLineDecoder: reassembles a UTF-8 code point split across chunk boundaries', () => {
  const decoder = new LfLineDecoder()
  const record = Buffer.from(JSON.stringify({ text: 'héllo 🌍' }) + '\n', 'utf8')
  const mid = record.indexOf(Buffer.from('🌍', 'utf8')) + 2

  assert.deepEqual(decoder.push(record.subarray(0, mid)), [])
  const lines = decoder.push(record.subarray(mid))

  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]!), { text: 'héllo 🌍' })
})

test('LfLineDecoder: U+2028/U+2029 split across chunk boundaries stay intact', () => {
  const decoder = new LfLineDecoder()
  const record = Buffer.from(JSON.stringify({ text: 'a\u2028b' }) + '\n', 'utf8')
  const separatorStart = record.indexOf(Buffer.from('\u2028', 'utf8'))

  assert.deepEqual(decoder.push(record.subarray(0, separatorStart + 1)), [])
  const lines = decoder.push(record.subarray(separatorStart + 1))

  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]!), { text: 'a\u2028b' })
})

test('LfLineDecoder: bounds an unterminated record buffer', () => {
  const decoder = new LfLineDecoder(8)
  assert.deepEqual(decoder.push('12345678'), [])
  assert.throws(() => decoder.push('9'), LfLineTooLongError)
})

test('LfLineDecoder: rejects an over-limit LF-terminated record in one chunk', () => {
  const decoder = new LfLineDecoder(4)

  assert.throws(() => decoder.push('12345\n'), LfLineTooLongError)
})

test('LfLineDecoder: rejects an over-limit record when its LF arrives in a later chunk', () => {
  const decoder = new LfLineDecoder(4)

  assert.deepEqual(decoder.push('1234'), [])
  assert.throws(() => decoder.push('5\n'), LfLineTooLongError)
})

test('LfLineDecoder: end() flushes the trailing unterminated line', () => {
  const decoder = new LfLineDecoder()

  assert.deepEqual(decoder.push('{"partial":'), [])
  assert.equal(decoder.end(), '{"partial":')
  assert.equal(decoder.end(), null)
})

test('LfLineDecoder: fragmented large records scan and count only new text', t => {
  const originalIndexOf = String.prototype.indexOf
  const originalByteLength = Buffer.byteLength
  let scanned = 0
  let counted = 0
  t.mock.method(String.prototype, 'indexOf', function (this: string, search: string, position = 0) {
    if (search === '\n') scanned += this.length - position
    return originalIndexOf.call(this, search, position)
  })
  t.mock.method(Buffer, 'byteLength', (text: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
    if (typeof text === 'string') counted += text.length
    return originalByteLength(text, encoding)
  })
  const size = 2 * 1024 * 1024
  const decoder = new LfLineDecoder(size)
  const chunk = 'x'.repeat(4096)
  for (let i = 0; i < size / chunk.length; i++) decoder.push(chunk)
  const lines = decoder.push('\nnext\ntrail')
  assert.equal(lines[0].length, size)
  assert.equal(lines[1], 'next')
  assert.equal(decoder.end(), 'trail')
  assert.ok(scanned < size * 2, `newline work ${scanned} must be linear`)
  assert.ok(counted < size * 2, `byte accounting work ${counted} must be linear`)
})

test('LfLineDecoder: exact UTF-8 limit, split surrogate strings, and incomplete byte flush', () => {
  const decoder = new LfLineDecoder(4)
  for (const byte of Buffer.from('🌍')) assert.deepEqual(decoder.push(Buffer.from([byte])), [])
  assert.deepEqual(decoder.push('\nx\n'), ['🌍', 'x'])
  decoder.push('\ud83c')
  decoder.push('\udf0d')
  assert.equal(decoder.end(), '🌍')
  decoder.push(Buffer.from([0xe2]))
  assert.equal(decoder.end(), '\ufffd')
  const over = new LfLineDecoder(3)
  assert.throws(() => over.push(Buffer.from('🌍\n')), LfLineTooLongError)
})
