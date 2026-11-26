import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  collapseWhitespaceAndControl,
  compactPlainTitle,
  extractCompactionSummary,
  formatManualCompactionLegacyText,
  redactSensitiveTokens,
  sanitizeErrorDetail,
  sanitizeNoticeText,
  sanitizeNoticeTitle,
  splitNotifyText
} from '../../src/acp/translate/notices.js'

test('redactSensitiveTokens: immune to ReDoS on pathological escaped-quote and repeated-key inputs', () => {
  const escapedBackslashes = 'token=\\"' + '\\\\'.repeat(200)
  const t0 = performance.now()
  const redactedEscaped = redactSensitiveTokens(escapedBackslashes)
  const elapsedEscaped = performance.now() - t0
  assert.ok(elapsedEscaped < 50, `escaped-quote redaction took ${elapsedEscaped.toFixed(2)}ms (expected < 50ms)`)
  assert.equal(redactedEscaped, 'token=[redacted]')

  const repeatedKeys = 'token_'.repeat(5_000)
  const t1 = performance.now()
  const redactedKeys = redactSensitiveTokens(repeatedKeys)
  const elapsedKeys = performance.now() - t1
  assert.ok(elapsedKeys < 50, `repeated-key redaction took ${elapsedKeys.toFixed(2)}ms (expected < 50ms)`)
  assert.ok(redactedKeys.length <= 8_192, 'raw input is capped before redaction')

  // Unclosed secret truncated at the 8192-char cap still redacts without leaking tail.
  const truncatedSecret = `{"api_key":"${'s'.repeat(9_000)}"}`
  const redactedTruncated = redactSensitiveTokens(truncatedSecret)
  assert.equal(redactedTruncated, '{"api_key":"[redacted]"')
})

test('redactSensitiveTokens: blocks unicode quote/escape injection while still decoding obfuscated keys', () => {
  const injectedDouble = redactSensitiveTokens('{"password":"alpha\\u0022tailcredential"}')
  assert.equal(injectedDouble, '{"password":"[redacted]"}')
  assert.equal(injectedDouble.includes('tailcredential'), false)

  const injectedSingle = redactSensitiveTokens("{'password':'alpha\\u0027tailcredential'}")
  assert.equal(injectedSingle, "{'password':'[redacted]'}")
  assert.equal(injectedSingle.includes('tailcredential'), false)

  const injectedBackslash = redactSensitiveTokens('{"password":"alpha\\u005c\\"tailcredential"}')
  assert.equal(injectedBackslash, '{"password":"[redacted]"}')
  assert.equal(injectedBackslash.includes('tailcredential'), false)

  // Delimiter-forging unicode escapes (comma, backtick, space) must not decode.
  for (const [input, leaked] of [
    ['api_key=\\u002cprivatevalue', 'privatevalue'],
    ['token=`alpha\\u0060LEAKED`', 'LEAKED'],
    ['api_key=alpha\\u0020LEAKED', 'LEAKED']
  ] as const) {
    const out = redactSensitiveTokens(input)
    assert.equal(out.includes(leaked), false, `${input} leaked ${leaked}: ${out}`)
  }

  // Obfuscated identifier keys and standalone prefixes still decode and redact.
  assert.equal(redactSensitiveTokens('{"access_\\u0074oken":"secret"}'), '{"access_token":"[redacted]"}')
  assert.equal(redactSensitiveTokens('\\u0042earer abcdef123456'), 'Bearer [redacted]')
  assert.equal(redactSensitiveTokens('\\u0073k-secret123456'), '[redacted]')

  // Key/value redaction runs before standalone sk- redaction so suffixes cannot leak.
  const skSuffix = redactSensitiveTokens('token=sk-abcdefgh.privatevalue')
  assert.equal(skSuffix, 'token=[redacted]')
  assert.equal(skSuffix.includes('privatevalue'), false)

  // Double-encoded JSON with a trailing backslash in a value still closes before the next key.
  const doubleEncoded = JSON.stringify(JSON.stringify({ api_key: 'abc\\', password: 'LEAKED' }))
  const redactedDouble = redactSensitiveTokens(doubleEncoded)
  assert.equal(redactedDouble.includes('LEAKED'), false, `double-encoded leaked password: ${redactedDouble}`)
  assert.equal(redactedDouble.includes('abc'), false, `double-encoded leaked api_key: ${redactedDouble}`)

  // Prose-prefixed sensitive keys and Bearer tokens redact cleanly without breaking
  // non-sensitive values containing `=` or quoted keys followed by `:`.
  for (const [input, leaked] of [
    ['Invalid token: api_key="LEAKED"', 'LEAKED'],
    ['Invalid token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['Invalid token: api_key = supersecret123', 'supersecret123'],
    ['Auth secret: password: supersecret123', 'supersecret123'],
    ['Invalid token: "api_key": "supersecret123"', 'supersecret123'],
    ['password=hunter2="x"', 'hunter2'],
    ['password=greenSecret42=', 'greenSecret42'],
    ['password: greenSecret42=', 'greenSecret42'],
    ['password=hunter2secret=x', 'hunter2secret'],
    ['"password": "secret": connection refused', 'secret']
  ] as const) {
    const out = redactSensitiveTokens(input)
    assert.equal(out.includes(leaked), false, `${input} leaked ${leaked}: ${out}`)
  }

  assert.equal(
    redactSensitiveTokens('{\\"api_key\\":\\"inner\\\\\\"secret\\"} trailing'),
    '{\\"api_key\\":\\"[redacted]\\"} trailing'
  )
})

test('notice sanitizers: collapse control chars, redact secrets/paths, split multiline notify cleanly', () => {
  assert.equal(collapseWhitespaceAndControl('  a\r\n\tb\x00\x7fc  '), 'a b c')
  assert.equal(sanitizeNoticeText('Bearer sk-abc12345678\nnext', 40), 'Bearer [redacted] next')
  assert.equal(sanitizeNoticeTitle('\n\n  First line\nSecond line', 'Fallback'), 'First line')
  assert.equal(sanitizeNoticeTitle('   \n\t ', 'Fallback'), 'Fallback')

  const errDetail = sanitizeErrorDetail('Auth failed api_key=topsecret at /Users/alice/repo/secret.ts\nstack line 2')
  assert.equal(errDetail.includes('topsecret'), false)
  assert.equal(errDetail.includes('/Users/alice'), false)
  assert.equal(errDetail.includes('[path]'), true)
  assert.equal(errDetail.includes('stack line 2'), false)

  assert.deepEqual(splitNotifyText(null), { title: 'Pi notification' })
  assert.deepEqual(splitNotifyText('Short message'), { title: 'Short message' })
  assert.deepEqual(splitNotifyText('Header\nLine two\n  Line   three  '), {
    title: 'Header',
    description: 'Line two Line three'
  })

  const longSingleLine = 'x'.repeat(150)
  const splitLong = splitNotifyText(longSingleLine)
  assert.equal(Array.from(splitLong.title).length, 120)
  assert.equal(splitLong.description, longSingleLine)

  assert.equal(compactPlainTitle('  hello\tworld  '), 'hello world')
  assert.equal(compactPlainTitle('   '), null)
})

test('compaction helpers: extract summary and format legacy manual compaction text', () => {
  assert.equal(extractCompactionSummary({ summary: 'Kept key facts' }), 'Kept key facts')
  assert.equal(extractCompactionSummary({ summary: '   ' }), null)
  assert.equal(extractCompactionSummary(null), null)

  assert.equal(
    formatManualCompactionLegacyText('keep API notes', { tokensBefore: 1200, summary: 'Summary body' }),
    'Compaction completed. (custom instructions applied)\nTokens before: 1200\n\nSummary body'
  )
  assert.equal(formatManualCompactionLegacyText(undefined, {}), 'Compaction completed.')
})
