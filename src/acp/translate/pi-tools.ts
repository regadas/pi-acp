import type { ToolCallContent } from '@agentclientprotocol/sdk'

export type ToolResultImageBlock = { data: string; mimeType: string }

export type ToolResultContentBlock = { type: 'text'; text: string } | ({ type: 'image' } & ToolResultImageBlock)

/** Image blocks from a pi tool result's content array, in source order. */
export function toolResultImageBlocks(result: unknown): ToolResultImageBlock[] {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return []

  const images: ToolResultImageBlock[] = []
  for (const raw of content) {
    const block = raw as { type?: unknown; data?: unknown; mimeType?: unknown } | null
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      images.push({ data: block.data, mimeType: block.mimeType })
    }
  }
  return images
}

/**
 * Translate a pi tool result into ordered ACP content blocks in one pass:
 * text and image blocks keep their source order (consecutive text pieces are
 * merged). pi's edit tool returns a terse success message in content and the
 * full unified diff in details.diff, so the diff replaces the text blocks
 * while images stay. The JSON fallback only applies when the content array
 * yielded no recognized blocks at all — an image-only result must never grow
 * a base64-filled JSON text block.
 */
export function toolResultContentBlocks(result: unknown): ToolResultContentBlock[] {
  if (!result) return []

  const record = result as { content?: unknown; details?: unknown }
  const details = record.details as Record<string, unknown> | null | undefined

  const ordered: ToolResultContentBlock[] = []
  if (Array.isArray(record.content)) {
    for (const raw of record.content) {
      const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | null
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        const last = ordered[ordered.length - 1]
        if (last?.type === 'text') last.text += block.text
        else ordered.push({ type: 'text', text: block.text })
      } else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        ordered.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      }
    }
  }

  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return [{ type: 'text', text: diff }, ...ordered.filter(block => block.type === 'image')]
  }

  if (ordered.length) return ordered

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const anyResult = result as Record<string, unknown>
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof anyResult.stdout === 'string' ? anyResult.stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof anyResult.output === 'string' ? anyResult.output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof anyResult.stderr === 'string' ? anyResult.stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof anyResult.exitCode === 'number' ? anyResult.exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof anyResult.code === 'number' ? anyResult.code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return [{ type: 'text', text: parts.join('\n\n').trimEnd() }]
  }

  try {
    return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(result) }]
  }
}

/** Ordered ACP ToolCallContent for a pi tool result (see toolResultContentBlocks). */
export function toolResultToolCallContent(result: unknown): ToolCallContent[] {
  return toolResultContentBlocks(result).map(
    block =>
      ({
        type: 'content',
        content: block.type === 'text' ? { type: 'text', text: block.text } : block
      }) satisfies ToolCallContent
  )
}
