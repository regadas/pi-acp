import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import { lstatSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

export function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

type EditFields = { oldText?: unknown; newText?: unknown }
type NormalizedEditInput = { record: EditFields; edits: readonly EditFields[] }

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function normalizeEditInput(args: unknown): NormalizedEditInput {
  const record = (args ?? {}) as EditFields & { edits?: unknown }

  let edits = record.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  return { record, edits: Array.isArray(edits) ? (edits as EditFields[]) : [] }
}

/** Complete `{ oldText, newText }` pairs, legacy top-level pair first. */
function completeEdits({ record, edits }: NormalizedEditInput): Array<{ oldText: string; newText: string }> {
  const pairs: Array<{ oldText: string; newText: string }> = []

  if (typeof record.oldText === 'string' && typeof record.newText === 'string') {
    pairs.push({ oldText: record.oldText, newText: record.newText })
  }

  for (const edit of edits) {
    if (typeof edit?.oldText === 'string' && typeof edit?.newText === 'string') {
      pairs.push({ oldText: edit.oldText, newText: edit.newText })
    }
  }

  return pairs
}

/**
 * Every `oldText` that can anchor a location hint, complete pairs first. An
 * entry whose `newText` is missing or malformed still contributes: the hint is
 * best-effort and only needs the text being replaced.
 */
export function getEditOldTexts(args: unknown): string[] {
  const input = normalizeEditInput(args)
  const oldTexts = new Set(completeEdits(input).map(edit => edit.oldText))

  if (typeof input.record.oldText === 'string') oldTexts.add(input.record.oldText)
  for (const edit of input.edits) {
    if (typeof edit?.oldText === 'string') oldTexts.add(edit.oldText)
  }

  return [...oldTexts]
}

export function toToolCallLocations(
  toolName: string,
  args: unknown,
  cwd: string,
  line?: number
): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  let entry: ReturnType<typeof lstatSync>
  try {
    entry = lstatSync(resolvedPath)
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isMissing || toolName.toLowerCase() !== 'write') return undefined
    return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
  }

  if (entry.isSymbolicLink()) {
    try {
      entry = statSync(resolvedPath)
    } catch {
      return undefined
    }
  }

  if (!entry.isFile()) return undefined
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
