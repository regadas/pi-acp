import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk/unstable'
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

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Resolve a tool-supplied path against `cwd`, rejecting blank strings, NUL or
 * control characters, and anything that fails to resolve to an absolute path.
 */
export function resolveValidToolPath(rawPath: string | undefined, cwd: string): string | undefined {
  if (!rawPath || !rawPath.trim() || hasControlChars(rawPath)) return undefined
  if (hasControlChars(cwd)) return undefined
  try {
    const resolvedPath = isAbsolute(rawPath) ? rawPath : resolvePath(cwd, rawPath)
    return resolvedPath && isAbsolute(resolvedPath) && !hasControlChars(resolvedPath) ? resolvedPath : undefined
  } catch {
    return undefined
  }
}

/** Valid ACP 1-based line number (safe positive integer), else undefined. */
export function validLocationLine(line: unknown): number | undefined {
  return typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 ? line : undefined
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
  const resolvedPath = resolveValidToolPath(getToolPath(args), cwd)
  if (!resolvedPath) return undefined

  const validLine = validLocationLine(line)
  let entry: ReturnType<typeof lstatSync>
  try {
    entry = lstatSync(resolvedPath)
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isMissing || toolName.toLowerCase() !== 'write') return undefined
    return [{ path: resolvedPath, ...(validLine !== undefined ? { line: validLine } : {}) }]
  }

  if (entry.isSymbolicLink()) {
    try {
      entry = statSync(resolvedPath)
    } catch {
      return undefined
    }
  }

  if (!entry.isFile()) return undefined
  return [{ path: resolvedPath, ...(validLine !== undefined ? { line: validLine } : {}) }]
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
