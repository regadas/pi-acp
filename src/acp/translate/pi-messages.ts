export type TranslatedAssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; toolCallId: string; toolName: string; rawInput: unknown }

/**
 * Translate pi assistant message content blocks in source order.
 * Pi shapes (pi-ai types): `{type:'text', text}`, `{type:'thinking', thinking}`,
 * `{type:'toolCall', id, name, arguments}`.
 */
export function translateAssistantContent(content: unknown): TranslatedAssistantBlock[] {
  if (!Array.isArray(content)) return []

  const blocks: TranslatedAssistantBlock[] = []
  for (const raw of content) {
    const block = raw as {
      type?: unknown
      text?: unknown
      thinking?: unknown
      id?: unknown
      name?: unknown
      arguments?: unknown
    } | null
    if (!block || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      blocks.push({ kind: 'text', text: block.text })
      continue
    }

    if (block.type === 'thinking') {
      const text =
        typeof block.thinking === 'string' && block.thinking
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : ''
      if (text) blocks.push({ kind: 'thinking', text })
      continue
    }

    if (block.type === 'toolCall' && typeof block.id === 'string' && block.id) {
      blocks.push({
        kind: 'toolCall',
        toolCallId: block.id,
        toolName: typeof block.name === 'string' && block.name ? block.name : 'tool',
        rawInput: block.arguments ?? null
      })
    }
  }
  return blocks
}

export type TranslatedUserBlock = { kind: 'text'; text: string } | { kind: 'image'; data: string; mimeType: string }

/**
 * Pi custom-message content shares the user content shape (a plain string or
 * ordered text/image blocks). Normalize it into ordered blocks and merge
 * consecutive text pieces so live events and persisted `custom_message`
 * entries that carry the same message translate identically.
 */
export function translateCustomMessageContent(content: unknown): TranslatedUserBlock[] {
  const merged: TranslatedUserBlock[] = []
  for (const block of translateUserContent(content)) {
    const last = merged[merged.length - 1]
    if (block.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + block.text }
    } else {
      merged.push(block)
    }
  }
  return merged
}

/**
 * Translate pi user message content: a plain string or an array of
 * `{type:'text', text}` / `{type:'image', data, mimeType}` blocks.
 */
export function translateUserContent(content: unknown): TranslatedUserBlock[] {
  if (typeof content === 'string') {
    return content ? [{ kind: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: TranslatedUserBlock[] = []
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | null
    if (!block || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      blocks.push({ kind: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      blocks.push({ kind: 'image', data: block.data, mimeType: block.mimeType })
    }
  }
  return blocks
}
