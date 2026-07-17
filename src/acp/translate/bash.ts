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

export function bashOutputDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next
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
 * Zed `_meta.terminal_output` convention. One ordered pass over the result's
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
  // Zed renders ACP `execute` tools as display-only terminals when paired with
  // terminal content plus terminal metadata. See ACP execute tool schema:
  // https://agentclientprotocol.com/protocol/schema#param-execute
  return { terminal_info: { terminal_id: toolCallId, cwd } }
}

export function bashTerminalOutputMeta(toolCallId: string, data: string) {
  return { terminal_output: { terminal_id: toolCallId, data } }
}

export function bashTerminalExitMeta(toolCallId: string, exitCode: number) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } }
}
