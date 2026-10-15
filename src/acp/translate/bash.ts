import type { ToolCallContent } from '@agentclientprotocol/sdk'

type BashCommandRecord = {
  command?: unknown
  cmd?: unknown
  args?: BashCommandRecord
  input?: BashCommandRecord
  rawInput?: BashCommandRecord
  toolInput?: BashCommandRecord
  details?: BashCommandRecord
}

type BashResultRecord = {
  content?: unknown
  details?: unknown
  stdout?: unknown
  stderr?: unknown
  output?: unknown
  exitCode?: unknown
  code?: unknown
}

export function isBashTool(toolName: string): boolean {
  return toolName.toLowerCase() === 'bash'
}

export function bashCommand(value: unknown): string | undefined {
  const record = value as BashCommandRecord | null | undefined
  const command =
    record?.command ??
    record?.cmd ??
    record?.args?.command ??
    record?.args?.cmd ??
    record?.input?.command ??
    record?.input?.cmd ??
    record?.rawInput?.command ??
    record?.rawInput?.cmd ??
    record?.toolInput?.command ??
    record?.toolInput?.cmd ??
    record?.details?.command ??
    record?.details?.cmd

  return typeof command === 'string' && command.trim() ? command : undefined
}

/** stdout/stderr from `details`/top-level fields only (never content blocks). */
export function bashDetailsText(result: unknown): string {
  const record = result as BashResultRecord | null | undefined
  const details = record?.details as BashResultRecord | null | undefined
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof record?.stdout === 'string' ? record.stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof record?.output === 'string' ? record.output : undefined)
  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof record?.stderr === 'string' ? record.stderr : undefined)

  return [stdout, stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
}

export function bashResultText(result: unknown): string {
  const record = result as BashResultRecord | null | undefined
  const content = record?.content
  if (Array.isArray(content)) {
    const texts = content
      .map(c => {
        const block = c as { type?: unknown; text?: unknown }
        return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  return bashDetailsText(result)
}

export function bashExitCode(result: unknown, isError: boolean): number {
  const record = result as BashResultRecord | null | undefined
  const details = record?.details as BashResultRecord | null | undefined
  const exitCode = details?.exitCode ?? record?.exitCode ?? details?.code ?? record?.code
  return typeof exitCode === 'number' ? exitCode : isError ? 1 : 0
}

/**
 * Longest prefix of `next` that is a suffix of `previous`, via the KMP
 * failure function: linear in the window size, no quadratic rescans.
 */
function longestSuffixPrefixOverlap(previous: string, next: string): number {
  if (!next) return 0
  const failure = new Int32Array(next.length)
  for (let i = 1, k = 0; i < next.length; i++) {
    while (k > 0 && next[i] !== next[k]) k = failure[k - 1]!
    if (next[i] === next[k]) k++
    failure[i] = k
  }
  let matched = 0
  for (let i = 0; i < previous.length; i++) {
    while (matched > 0 && previous[i] !== next[matched]) matched = failure[matched - 1]!
    if (previous[i] === next[matched]) matched++
    if (matched === next.length) {
      if (i === previous.length - 1) return next.length
      matched = failure[matched - 1]!
    }
  }
  return matched
}

/** Cumulative output coordinates pi reports alongside a truncated tail window. */
export type BashOutputCoordinates = {
  totalLines: number
  totalBytes: number
  outputLines: number
  /** Native flag: the window is a byte-partial tail of one line past the cap. */
  lastLinePartial?: boolean
}

/** One observed pi bash snapshot: the text plus its native window coordinates. */
export type BashOutputSnapshot = {
  /** Everything the snapshot shows: window text plus any final-result annotation. */
  text: string
  /** The rolling tail-window text when truncated; absent for complete output. */
  window?: string
  /** Present only when `window` is a truncated rolling window. */
  coords?: BashOutputCoordinates
  /**
   * Whether everything emitted so far ends at a line boundary (a complete
   * line's terminator). Recorded by `bashOutputDelta` on each snapshot it
   * processes: a joined rolling window never includes its last line's
   * terminator — an empty tail line shows up only as a trailing separator —
   * while a native short tail kept verbatim carries its real terminator,
   * so this state is tracked logically per snapshot, never derived from
   * the rendered delta text.
   */
  endsAtLineBoundary?: boolean
}

function truncationRecord(value: unknown): { coords: BashOutputCoordinates; window: string } | undefined {
  const record = value as
    | {
        truncated?: unknown
        totalLines?: unknown
        totalBytes?: unknown
        outputLines?: unknown
        content?: unknown
        lastLinePartial?: unknown
      }
    | null
    | undefined
  if (!record || record.truncated !== true) return undefined
  const { totalLines, totalBytes, outputLines, content, lastLinePartial } = record
  if (
    typeof totalLines !== 'number' ||
    !Number.isSafeInteger(totalLines) ||
    totalLines < 0 ||
    typeof totalBytes !== 'number' ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    typeof outputLines !== 'number' ||
    !Number.isSafeInteger(outputLines) ||
    outputLines < 0 ||
    typeof content !== 'string' ||
    content === ''
  ) {
    return undefined
  }
  return {
    coords: {
      totalLines,
      totalBytes,
      outputLines,
      ...(typeof lastLinePartial === 'boolean' ? { lastLinePartial } : {})
    },
    window: content
  }
}

/**
 * The streaming snapshot for a pi bash result or update. The final result
 * appends the native truncation annotation (and exit status) after the
 * window; `window` carries the rolling window itself so deltas can use the
 * native coordinates. Records whose truncation metadata disagrees with the
 * observed text are treated as plain text.
 */
export function bashOutputSnapshot(result: unknown): BashOutputSnapshot {
  const text = bashResultText(result)
  const record = result as { truncation?: unknown; details?: { truncation?: unknown } | null } | null | undefined
  const truncation = truncationRecord(record?.truncation) ?? truncationRecord(record?.details?.truncation)
  if (!truncation || !text.startsWith(truncation.window)) return { text }
  return { text, window: truncation.window, coords: truncation.coords }
}

/** Line count with pi's counting semantics: a trailing newline ends a line. */
function countOutputLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines.length
}

/** Coordinates a complete (non-truncated) snapshot implies about the stream. */
function completeSnapshotCoords(text: string): BashOutputCoordinates {
  const lines = countOutputLines(text)
  return { totalLines: lines, totalBytes: Buffer.byteLength(text), outputLines: lines }
}

/** Text-only delta for snapshots without usable coordinates (custom bash tools). */
function textDelta(previous: string, next: string): string {
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next.slice(longestSuffixPrefixOverlap(previous, next))
}

/**
 * Boundary state inferred from a snapshot's own shape, when none was
 * carried: complete text is the stream itself, and a rolling window ends
 * at a line boundary only when native truncation kept a short tail
 * verbatim — real trailing terminator included, its line count matching
 * `outputLines`. A joined window's trailing newline is only the separator
 * before a blank tail line, whose own terminator stays owed and whose
 * line count falls one short.
 */
function inferredAtLineEnd(snapshot: BashOutputSnapshot, window: string): boolean {
  if (snapshot.window === undefined) return window.endsWith('\n')
  if (!snapshot.coords) return false
  if (!window.endsWith('\n')) return false
  return countOutputLines(window) === snapshot.coords.outputLines
}

/** The boundary state a previous snapshot carries, inferred from its shape when unset. */
function carriedAtLineEnd(previous: BashOutputSnapshot, prevWindow: string): boolean {
  if (previous.endsAtLineBoundary !== undefined) return previous.endsAtLineBoundary
  return inferredAtLineEnd(previous, prevWindow)
}

/** Text-overlap fallback for snapshots whose metadata cannot be trusted. */
function textFallback(previous: BashOutputSnapshot, prevWindow: string, next: BashOutputSnapshot): string {
  const delta = textDelta(prevWindow, next.text)
  next.endsAtLineBoundary = delta ? delta.endsWith('\n') : carriedAtLineEnd(previous, prevWindow)
  return delta
}

/**
 * A byte-partial window (native `lastLinePartial`, or a foreign record that
 * slid past the shown content): it is a byte slice of one huge line ending
 * at the stream end, so the fresh bytes are the window's tail. The slice
 * offset can land inside a multi-byte character whose earlier bytes were
 * already emitted, so it advances to the next character boundary instead of
 * synthesizing a replacement character.
 */
function bytePartialTail(next: BashOutputSnapshot, newBytes: number, suffix: string): string {
  next.endsAtLineBoundary = false
  const windowBytes = Buffer.byteLength(next.window!)
  if (newBytes >= windowBytes) return next.text
  const window = Buffer.from(next.window!, 'utf8')
  let start = windowBytes - newBytes
  while (start < window.length && (window[start] & 0xc0) === 0x80) start++
  // shortcut: a terminator arriving inside a byte-partial window is
  // indistinguishable from one more content byte; the slice then repeats one
  // already-shown byte. Whole-line windows do disambiguate; pi's byte-partial
  // snapshots cannot.
  return window.subarray(start).toString('utf8') + suffix
}

export function bashOutputDelta(previous: BashOutputSnapshot | undefined, next: BashOutputSnapshot): string {
  // The final result's truncation annotation and exit status follow the window.
  const nextWindow = next.window ?? next.text
  const suffix = next.text.slice(nextWindow.length)
  if (!previous) {
    next.endsAtLineBoundary = inferredAtLineEnd(next, nextWindow)
    return next.text
  }
  const prevWindow = previous.window ?? previous.text
  if (!prevWindow) {
    next.endsAtLineBoundary = inferredAtLineEnd(next, nextWindow)
    return next.text
  }

  if (!next.window || !next.coords) return textFallback(previous, prevWindow, next)

  const prevCoords = previous.coords ?? completeSnapshotCoords(prevWindow)
  const progressed = next.coords.totalBytes > prevCoords.totalBytes || next.coords.totalLines > prevCoords.totalLines
  if (!progressed) {
    next.endsAtLineBoundary = carriedAtLineEnd(previous, prevWindow)
    return suffix
  }

  const newLines = next.coords.totalLines - prevCoords.totalLines
  const newBytes = next.coords.totalBytes - prevCoords.totalBytes
  if (newLines < 0 || newBytes < 0) return textFallback(previous, prevWindow, next)

  if (newLines === 0) {
    // No new line began: the last line grew and/or its terminator arrived.
    // A native byte-partial window is a byte slice of one huge line and has
    // no whole-line prefix to extend.
    if (next.coords.lastLinePartial) return bytePartialTail(next, newBytes, suffix)
    const atLineEnd = carriedAtLineEnd(previous, prevWindow)
    const shownLine = prevWindow.slice(prevWindow.lastIndexOf('\n') + 1)
    const lastLine = next.window.slice(next.window.lastIndexOf('\n') + 1)
    if (!atLineEnd && lastLine.startsWith(shownLine)) {
      const growth = lastLine.slice(shownLine.length)
      const remaining = newBytes - Buffer.byteLength(growth)
      if (remaining === 0) {
        next.endsAtLineBoundary = false
        return growth + suffix
      }
      if (remaining === 1) {
        // A single remaining byte is the terminator, which the native window
        // never includes in its text.
        next.endsAtLineBoundary = true
        return `${growth}\n` + suffix
      }
      return textFallback(previous, prevWindow, next) // inconsistent coordinates
    }
    if (next.coords.lastLinePartial === false) return textFallback(previous, prevWindow, next)
    // Foreign metadata without the native partial flag: the single shown
    // line may have byte-rolled past the previous window.
    return bytePartialTail(next, newBytes, suffix)
  }

  const windowLines = next.window.split('\n')
  if (windowLines.length !== next.coords.outputLines) return textFallback(previous, prevWindow, next)
  // Lines of the window that were already shown: the window starts at
  // totalLines - outputLines + 1 and everything up to the previous total was
  // visible before. A window that begins past the previous total is entirely
  // new (the burst of lines between updates was never in any window).
  const windowFirstLine = next.coords.totalLines - next.coords.outputLines + 1
  const alreadyShown = Math.max(0, prevCoords.totalLines - windowFirstLine + 1)
  const fresh = windowLines.slice(alreadyShown)
  if (fresh.length === 0) {
    next.endsAtLineBoundary = carriedAtLineEnd(previous, prevWindow)
    return suffix
  }

  // The separator state comes from the logical tail: a joined window never
  // shows its last line's terminator, and that terminator counts as emitted
  // only when the tracked state says so — a rendered delta ending in a
  // newline may just be the separator before an empty tail line.
  const atLineEnd = carriedAtLineEnd(previous, prevWindow)
  let prefix = atLineEnd ? '' : '\n'
  if (!atLineEnd && alreadyShown >= 1) {
    // The previously shown window never ends with a newline. When its open
    // trailing line grew before the new lines arrived, the window's copy of
    // that line extends what was shown: continue the line instead of
    // starting a new one (its terminator follows the extension).
    const shownLastLine = prevWindow.slice(prevWindow.lastIndexOf('\n') + 1)
    const grown = windowLines[alreadyShown - 1] ?? ''
    if (grown.startsWith(shownLastLine)) prefix = `${grown.slice(shownLastLine.length)}\n`
  }
  // The last fresh line's terminator stays owed even when that line is
  // empty and the delta carries no visible text: it lands as the separator
  // of the next update, never as a duplicate.
  next.endsAtLineBoundary = false
  return prefix + fresh.join('\n') + suffix
}

export function bashTerminalContent(toolCallId: string): ToolCallContent[] {
  return [{ type: 'terminal', terminalId: toolCallId }] satisfies ToolCallContent[]
}

function fencedConsoleContent(text: string): ToolCallContent {
  let longestBacktickRun = 0
  for (const match of text.matchAll(/`+/g)) longestBacktickRun = Math.max(longestBacktickRun, match[0].length)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  const closingSeparator = text.endsWith('\n') ? '' : '\n'

  return {
    type: 'content',
    content: { type: 'text', text: `${fence}console\n${text}${closingSeparator}${fence}` }
  } satisfies ToolCallContent
}

/**
 * Standard ACP content for bash output when the client did not negotiate the
 * `_meta.terminal_output` extension. One ordered pass over the result's
 * content blocks: text is fenced in place and images stay standard image
 * content, so a `[image, text, image]` result keeps its source order. Text is
 * preserved verbatim inside a fence longer than every backtick run it contains.
 * Details stdout/stderr are used only when the content array supplied no text
 * at all (e.g. pi `!command` bashExecution records).
 */
export function bashOrderedContent(result: unknown): ToolCallContent[] {
  const record = result as { content?: unknown } | null | undefined
  const out: ToolCallContent[] = []
  let textRun = ''
  let sawContentText = false

  const flushTextRun = () => {
    if (textRun.length > 0) out.push(fencedConsoleContent(textRun))
    textRun = ''
  }

  if (Array.isArray(record?.content)) {
    for (const raw of record.content) {
      const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | null
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        sawContentText = true
        textRun += block.text
      } else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        flushTextRun()
        out.push({
          type: 'content',
          content: { type: 'image', data: block.data, mimeType: block.mimeType }
        } satisfies ToolCallContent)
      }
    }
    flushTextRun()
  }

  if (!sawContentText) {
    const fallback = bashDetailsText(result)
    if (fallback.length > 0) out.unshift(fencedConsoleContent(fallback))
  }

  return out
}

export function bashTerminalInfoMeta(toolCallId: string, cwd: string) {
  // Negotiating clients can render ACP `execute` tools as display-only
  // terminals using terminal content plus metadata. See ACP execute tool schema:
  // https://agentclientprotocol.com/protocol/schema#param-execute
  return { terminal_info: { terminal_id: toolCallId, cwd } }
}

export function bashTerminalOutputMeta(toolCallId: string, data: string) {
  return { terminal_output: { terminal_id: toolCallId, data } }
}

export function bashTerminalExitMeta(toolCallId: string, exitCode: number) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } }
}
