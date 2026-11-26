import { truncateCodePoints } from '../session-title.js'

/** Cap raw input before regex redaction; all emitted notice/error text is <= 400 chars. */
const MAX_REDACT_INPUT_CHARS = 8_192

const KEY_QUOTE = String.raw`(?:\\"|\\'|["'` + '`' + String.raw`])`
const SENSITIVE_KEY_WORD = String.raw`[A-Za-z0-9_-]{0,64}(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]{0,64}`
const NEXT_SENSITIVE_KEY_PREFIX = String.raw`(?:${KEY_QUOTE}?${SENSITIVE_KEY_WORD}${KEY_QUOTE}?\s*[:=]\s*[^\s,;}])`
const ESCAPED_DOUBLE_QUOTED_VALUE = String.raw`\\"(?:\\\\\\\\|\\\\\\"|\\(?!")|[^\\])*(?:\\"|$)`
const ESCAPED_SINGLE_QUOTED_VALUE = String.raw`\\'(?:\\\\\\\\|\\\\\\'|\\(?!')|[^\\])*(?:\\'|$)`
const DOUBLE_QUOTED_VALUE = String.raw`"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)`
const SINGLE_QUOTED_VALUE = String.raw`'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)`
const BACKTICK_VALUE = '`[^`]*(?:`|$)'
const UNQUOTED_VALUE = String.raw`(?:Bearer\s+)?[^\s,;'"` + '`' + String.raw`{}[\]]+`
const ANY_VALUE = String.raw`(?:${ESCAPED_DOUBLE_QUOTED_VALUE}|${ESCAPED_SINGLE_QUOTED_VALUE}|${DOUBLE_QUOTED_VALUE}|${SINGLE_QUOTED_VALUE}|${BACKTICK_VALUE}|${UNQUOTED_VALUE})`

const QUOTED_SENSITIVE_KEY_VALUE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(${KEY_QUOTE})(${SENSITIVE_KEY_WORD})(?![A-Za-z0-9_-])\1(\s*[:=]\s*)${ANY_VALUE}`,
  'gi'
)

const UNQUOTED_SENSITIVE_KEY_VALUE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(${SENSITIVE_KEY_WORD})(?![A-Za-z0-9_-])(\s*[:=](?:\s+(?!${NEXT_SENSITIVE_KEY_PREFIX})|(?!\s)))${ANY_VALUE}`,
  'gi'
)

export function collapseWhitespaceAndControl(value: string): string {
  let out = ''
  let inSpace = false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) {
      if (!inSpace) {
        out += ' '
        inSpace = true
      }
    } else {
      out += value[i]
      inSpace = false
    }
  }
  return out.trim()
}

function decodePrintableAsciiUnicodeEscapes(value: string): string {
  return value.replace(/\\u00([2-7][0-9a-fA-F])/gi, (match, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16))
    // Decode only safe identifier characters so unicode escapes can never forge
    // delimiters (`,`, `;`, space, quotes, backticks, backslashes, or brackets)
    // while obfuscated keys/prefixes (e.g. access_\u0074oken, \u0042earer) still decode.
    return /^[A-Za-z0-9_-]$/.test(ch) ? ch : match
  })
}

export function redactSensitiveTokens(value: string): string {
  const bounded = value.length > MAX_REDACT_INPUT_CHARS ? value.slice(0, MAX_REDACT_INPUT_CHARS) : value
  return decodePrintableAsciiUnicodeEscapes(bounded)
    .replace(
      QUOTED_SENSITIVE_KEY_VALUE_RE,
      (_match, keyQuote: string, key: string, sep: string) =>
        `${keyQuote}${key}${keyQuote}${sep}${keyQuote}[redacted]${keyQuote}`
    )
    .replace(UNQUOTED_SENSITIVE_KEY_VALUE_RE, (_match, key: string, sep: string) => `${key}${sep}[redacted]`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

export function sanitizeNoticeText(value: string, maxChars: number): string {
  const cleaned = collapseWhitespaceAndControl(redactSensitiveTokens(value))
  return cleaned ? truncateCodePoints(cleaned, maxChars) : ''
}

export function sanitizeNoticeTitle(value: string | null, fallback: string): string {
  if (!value) return fallback
  const redacted = redactSensitiveTokens(value)
  const firstLine = redacted.split(/\r?\n/).find(line => line.trim().length > 0) ?? ''
  const cleaned = collapseWhitespaceAndControl(firstLine)
  return cleaned ? truncateCodePoints(cleaned, 120) : fallback
}

export function sanitizeErrorDetail(value: string, maxChars = 240): string {
  const redactedFull = redactSensitiveTokens(value)
  const firstLine = redactedFull.split(/\r?\n/).find(line => line.trim().length > 0) ?? redactedFull
  const redacted = firstLine.replace(/(?:\/[A-Za-z0-9._-]+){3,}|[A-Za-z]:\\[^\s'"]+/g, '[path]')
  const cleaned = collapseWhitespaceAndControl(redacted)
  return cleaned ? truncateCodePoints(cleaned, maxChars) : 'Operation failed.'
}

export function splitNotifyText(raw: string | null): { title: string; description?: string } {
  if (!raw) return { title: 'Pi notification' }
  const redactedFull = redactSensitiveTokens(raw)
  const lines = redactedFull
    .split(/\r?\n/)
    .map(line => collapseWhitespaceAndControl(line))
    .filter(Boolean)
  if (!lines.length) return { title: 'Pi notification' }
  const first = lines[0]!
  if (lines.length === 1 && Array.from(first).length <= 120) {
    return { title: first }
  }
  const title = truncateCodePoints(first, 120)
  const rest = lines.length > 1 ? lines.slice(1).join(' ') : first
  const description = truncateCodePoints(rest, 400)
  return description && description !== title ? { title, description } : { title }
}

export function compactPlainTitle(raw: string | null, maxChars = 120): string | null {
  if (!raw) return null
  const cleaned = collapseWhitespaceAndControl(raw)
  return cleaned ? truncateCodePoints(cleaned, maxChars) : null
}

export function extractCompactionSummary(result: unknown): string | null {
  const r = result && typeof result === 'object' ? (result as { summary?: unknown }) : null
  return typeof r?.summary === 'string' && r.summary.trim() ? r.summary : null
}

export function formatManualCompactionLegacyText(customInstructions: string | undefined, result: unknown): string {
  const r = result && typeof result === 'object' ? (result as { tokensBefore?: unknown; summary?: unknown }) : null
  const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
  const summary = typeof r?.summary === 'string' ? r.summary : null
  const headerLines = [
    `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
    tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
  ].filter(Boolean)
  return headerLines.join('\n') + (summary ? `\n\n${summary}` : '')
}
