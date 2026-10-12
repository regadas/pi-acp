import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findExecutableOnPath } from './pi-rpc/command.js'

function isEntryModule(): boolean {
  const entryArg = process.argv[1]
  if (!entryArg) return false
  try {
    // Node resolves the ESM entry through symlinks while argv[1] keeps the
    // invoked path (e.g. the npm bin link), so accept either form.
    return (
      import.meta.url === pathToFileURL(entryArg).href || import.meta.url === pathToFileURL(realpathSync(entryArg)).href
    )
  } catch {
    return false
  }
}

// The npm executable prefers Bun when available and otherwise stays on Node.
// The re-exec replaces this process in place with execve, so the client keeps
// its PID, stdio and signal handling: the Bun adapter receives SIGTERM/SIGINT
// directly instead of the Node process dying under it. An execve(2) failure
// (e.g. an unusable `bun` binary) aborts this process and cannot be caught, so
// such a launch fails outright rather than falling back to Node. The
// once-guard env marker stops a second pass through this entry (a `bun` that
// is really a Node shim) from looping.
// shortcut: Windows stays on Node (the Bun re-exec is unverified there); revisit once tested.
const runningUnderBun = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun !== undefined
if (!runningUnderBun && process.platform !== 'win32' && isEntryModule() && !process.env.PI_ACP_REEXEC) {
  const bun = findExecutableOnPath('bun')
  if (bun) {
    try {
      process.execve?.(bun, [bun, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        ...process.env,
        PI_ACP_REEXEC: '1'
      })
    } catch {
      // Only JS-side throws (argument validation) land here; an execve(2)
      // failure aborts the process instead of returning to this entry.
    }
  }
}

// Consume the once-marker before main loads so pi children and nested
// adapters never inherit it (the shim's second pass above already used it).
delete process.env.PI_ACP_REEXEC

await import('./main.js')
