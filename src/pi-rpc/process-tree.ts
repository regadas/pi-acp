import { spawn, type ChildProcess } from 'node:child_process'

export type TreeKillResult = { confirmed: true } | { confirmed: false; reason: string }

/** Signals a process group by its pgid; a positive pgid targets one process. */
export type GroupSignal = (pgid: number, signal: NodeJS.Signals | 0) => void

function signalProcessGroup(pgid: number, signal: NodeJS.Signals | 0): void {
  process.kill(-pgid, signal)
}

function spawnTaskkill(pid: number): ChildProcess {
  // stdout is not inspected; leaving it piped-but-unread could block taskkill
  // on a full pipe. stderr is captured for the failure reason.
  return spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
}

/**
 * Terminate a POSIX process group and confirm no member survives. The RPC
 * child owns a dedicated group (spawned detached), so a wrapper's pi
 * descendant — which a root-only signal never reaches — dies with it instead
 * of surviving disposal and later double-opening the session file. SIGTERM
 * first, then SIGKILL once `graceMs` passes (`graceMs` 0 force-kills like the
 * Windows wrapper path); the group is probed — zombies count until reaped —
 * until it empties or `confirmTimeoutMs` runs out past the escalation. An
 * ESRCH from any signal or probe means the group is already gone, which is
 * the kill's success condition (an empty group cannot reappear); anything
 * else unconfirmed resolves so callers fail closed, like
 * {@link killProcessTree}.
 */
export function killPosixProcessGroup(
  pgid: number,
  graceMs: number,
  confirmTimeoutMs: number,
  opts?: { signalGroup?: GroupSignal; pollMs?: number }
): Promise<TreeKillResult> {
  const signalGroup = opts?.signalGroup ?? signalProcessGroup
  const pollMs = opts?.pollMs ?? 10
  return new Promise<TreeKillResult>(resolve => {
    const escalateAt = Date.now() + graceMs
    const deadline = escalateAt + confirmTimeoutMs
    let settled = false
    // A zero grace force-killed up front; the escalation already happened.
    let escalated = graceMs === 0
    // The interval ticks on a later macrotask, after the synchronous initial
    // signal below, so the stop/send closures it calls are initialized.
    const timer = setInterval(() => {
      if (!escalated && Date.now() >= escalateAt) {
        escalated = true
        if (!send('SIGKILL')) return
      }
      try {
        signalGroup(pgid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          stop({ confirmed: true })
          return
        }
        // EPERM: members exist outside our reach; keep probing, fail closed.
      }
      if (Date.now() >= deadline) {
        stop({ confirmed: false, reason: `process group survived the kill for ${graceMs + confirmTimeoutMs}ms` })
      }
    }, pollMs)
    const stop = (result: TreeKillResult) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve(result)
    }
    const send = (signal: NodeJS.Signals): boolean => {
      try {
        signalGroup(pgid, signal)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          // The group vanished before this signal — before the first one or
          // between a poll and the escalation — so it is already dead, which
          // is the success condition, not a failure.
          stop({ confirmed: true })
        } else {
          stop({ confirmed: false, reason: `group ${signal} failed: ${String(error)}` })
        }
        return false
      }
    }
    if (!send(graceMs > 0 ? 'SIGTERM' : 'SIGKILL')) return
  })
}

/**
 * Terminate a process and all its descendants via `taskkill /T /F`: a
 * Windows .cmd launcher's real pi is a grandchild holding the session file
 * and pipes, so killing only the root would strand it. Any failure or run
 * beyond `timeoutMs` resolves unconfirmed so callers fail closed.
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
