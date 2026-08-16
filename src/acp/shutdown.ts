/** The final-shutdown surface of {@link import('./agent.js').PiAcpAgent}. */
type ShutdownTarget = {
  disposeAndWait(timeoutMs: number): Promise<void>
}

export type ShutdownCoordinator<T extends ShutdownTarget> = {
  /** Record the connection's current agent; `null` teardowns are ignored. */
  trackAgent(agent: T | null): void
  /** Run the final shutdown at most once, then exit. */
  shutdown(): void
}

/**
 * Coordinates the stdio entrypoint's final shutdown.
 *
 * The last connected agent is retained even after the ACP connection reports
 * its teardown: that teardown only *starts* disposal, so the pi children it
 * disposed are still being escalated from SIGTERM to SIGKILL. Dropping the
 * agent there would let the adapter exit immediately and orphan them.
 * `disposeAndWait` is idempotent, so re-disposing an already torn-down agent
 * is safe and just waits out the remaining escalation.
 */
export function createShutdownCoordinator<T extends ShutdownTarget>(opts: {
  timeoutMs: number
  exit: () => void
}): ShutdownCoordinator<T> {
  let agent: T | null = null
  let shuttingDown = false

  return {
    trackAgent(next: T | null): void {
      if (next) agent = next
    },

    shutdown(): void {
      if (shuttingDown) return
      shuttingDown = true

      if (!agent) {
        opts.exit()
        return
      }

      agent.disposeAndWait(opts.timeoutMs).then(opts.exit, opts.exit)
    }
  }
}
