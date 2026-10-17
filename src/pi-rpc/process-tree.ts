import { spawn, type ChildProcess } from 'node:child_process'

export type TreeKillResult = { confirmed: true } | { confirmed: false; reason: string }

function spawnTaskkill(pid: number): ChildProcess {
  // stdout is not inspected; leaving it piped-but-unread could block taskkill
  // on a full pipe. stderr is captured for the failure reason.
  return spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
}

/**
 * Terminate a process and every descendant it started via `taskkill /T /F`.
 * The tree must be killed as a unit: on Windows the default `pi` launcher is
 * a .cmd script, so the child is cmd.exe and the real pi is a grandchild that
 * still holds the session file and the stdio pipes. Killing only the root
 * strands that grandchild beyond `/T`'s reach. Resolves `confirmed` only when
 * taskkill reports the whole tree terminated; any failure, or a run longer
 * than `timeoutMs`, resolves unconfirmed so callers can fail closed.
 */
export function killProcessTree(
  pid: number,
  timeoutMs: number,
  spawnKiller: (pid: number) => ChildProcess = spawnTaskkill
): Promise<TreeKillResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawnKiller(pid)
    } catch (error) {
      resolve({ confirmed: false, reason: `taskkill spawn failed: ${String(error)}` })
      return
    }

    let stderr = ''
    let settled = false
    const finish = (result: TreeKillResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ confirmed: false, reason: `taskkill timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-500)
    })
    child.once('error', error => finish({ confirmed: false, reason: `taskkill failed: ${String(error)}` }))
    child.once('close', (code, signal) =>
      finish(
        code === 0 && signal === null
          ? { confirmed: true }
          : {
              confirmed: false,
              reason: `taskkill exited with code ${code}${signal ? ` (${signal})` : ''}${
                stderr ? `: ${stderr.trim()}` : ''
              }`
            }
      )
    )
  })
}
