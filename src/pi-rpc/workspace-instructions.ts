import { readFileSync, statSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Workspace-root context for the pi child. The adapter passes the validated
 * additional roots to its child through this env var as a JSON string array;
 * roots are process-start configuration and never change for one child.
 */
export const WORKSPACE_ROOTS_ENV = 'PI_ACP_WORKSPACE_ROOTS'

/** System prompt section the adapter extension owns for root-scoped instructions. */
export const WORKSPACE_INSTRUCTIONS_SECTION = 'acp_workspace_instructions'

// Pi's native per-directory context precedence (core/resource-loader.js):
// only the first existing regular file in the directory itself is loaded.
// Ancestors of additional roots are never walked — pi already loads the
// cwd's own ancestor chain natively.
const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const

/**
 * Append a candidate file name without lexical normalization. A lexical
 * `join` collapses a trailing `..` before the OS resolves symlinks, so a root
 * like `/work/link/..` (which validation accepted as the physical directory
 * it resolves to) would read instructions from the wrong directory; keeping
 * the raw segments lets stat/read resolve the same physical file. The
 * separator itself is the native one so supported Windows paths spell like a
 * plain `join`.
 */
function rootEntryPath(root: string, name: string): string {
  const trailing = process.platform === 'win32' ? /[\\/]$/ : /\/$/
  return trailing.test(root) ? root + name : root + sep + name
}

export type WorkspaceInstructionEntry = {
  root: string
  file: string | null
  content: string | null
  error: string | null
}

function readError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

/**
 * Select and read the instruction file of each additional root. A root may
 * have no instruction file; a file that exists but cannot be read is returned
 * as an error entry so requested context is never dropped silently.
 */
export function readWorkspaceInstructions(roots: readonly string[]): WorkspaceInstructionEntry[] {
  return roots.map(root => {
    for (const name of INSTRUCTION_FILE_CANDIDATES) {
      const file = rootEntryPath(root, name)
      let isFile: boolean
      try {
        isFile = statSync(file).isFile()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') continue
        return { root, file, content: null, error: readError(error) }
      }
      if (!isFile) continue
      try {
        return { root, file, content: readFileSync(file, 'utf8'), error: null }
      } catch (error) {
        return { root, file, content: null, error: readError(error) }
      }
    }
    return { root, file: null, content: null, error: null }
  })
}

/** Render the root-scoped instructions section; null when there are no roots. */
export function buildWorkspaceInstructionsSection(entries: readonly WorkspaceInstructionEntry[]): string | null {
  if (!entries.length) return null
  const parts = [
    'Additional workspace roots for this session. The instructions below apply only within their own root, not globally.'
  ]
  for (const entry of entries) {
    if (entry.content != null) {
      parts.push(
        `<workspace_instructions root="${entry.root}" file="${entry.file}">\n${entry.content}\n</workspace_instructions>`
      )
    } else if (entry.error != null) {
      parts.push(
        `${entry.root}: the instruction file ${entry.file} exists but could not be read (${entry.error}); ` +
          'its instructions are missing from this context.'
      )
    } else {
      parts.push(`${entry.root}: no instruction file (AGENTS.md or CLAUDE.md) at this root.`)
    }
  }
  return parts.join('\n\n')
}

/** Parse the child env config; anything malformed means no roots. */
export function parseWorkspaceRootsEnv(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(root => typeof root === 'string') ? parsed : []
  } catch {
    return []
  }
}
