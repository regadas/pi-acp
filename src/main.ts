import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { createPiAcpProtocolRouter } from './acp/app.js'
import type { PiAcpAgent } from './acp/agent.js'
import { createShutdownCoordinator } from './acp/shutdown.js'
import { buildPiInvocation, getPiCommand } from './pi-rpc/command.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
  const invocation = buildPiInvocation(cmd, [], {
    cwd: process.cwd(),
    defaultCommand: process.env.PI_ACP_PI_COMMAND === undefined
  })
  if (!invocation) {
    process.stderr.write(`pi-acp: could not start pi (command not found: ${cmd}).\n`)
    process.exit(1)
  }
  const res = spawnSync(invocation.executable, invocation.args, {
    stdio: 'inherit',
    env: process.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  })

  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if (process.stdout.destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

let detachStdinBridge: (() => void) | undefined

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    const detach = () => {
      detachStdinBridge = undefined
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
    }
    const onData = (chunk: Buffer) => {
      try {
        controller.enqueue(new Uint8Array(chunk))
      } catch {
        // The controller closed underneath the bridge (SDK-side cancellation):
        // stop enqueueing instead of crashing the adapter.
        detach()
      }
    }
    const onEnd = () => {
      detach()
      controller.close()
    }
    // Permanent: detach() stops forwarding data/end but never removes this
    // sink — it is the only stdin error listener, so removing it would leave
    // a late input error unhandled mid-teardown.
    const onError = (err: Error) => {
      detach()
      try {
        controller.error(err)
      } catch {
        // The controller already closed (SDK-side cancellation); only the
        // shutdown routing still matters.
      }
      shutdown()
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    detachStdinBridge = detach
  },
  cancel() {
    // The SDK cancelled its input: detach; teardown runs via connection.closed.
    detachStdinBridge?.()
    process.stdin.pause()
  }
})

const stream = ndJsonStream(input, output)

// Covers the shared 10s cancellation deadline plus the 2s SIGTERM -> SIGKILL
// grace, with 1s for shutdown bookkeeping.
const SHUTDOWN_TERMINATION_TIMEOUT_MS = 13_000

// Disposes session subprocesses, then gives them a bounded window to actually
// terminate: exiting immediately would preempt the SIGTERM -> SIGKILL
// escalation and orphan a pi child that ignores SIGTERM.
const coordinator = createShutdownCoordinator<PiAcpAgent>({
  timeoutMs: SHUTDOWN_TERMINATION_TIMEOUT_MS,
  exit: () => {
    try {
      process.exit(0)
    } catch {
      // ignore
    }
  }
})

const connection = createPiAcpProtocolRouter({ onAgent: agent => coordinator.trackAgent(agent) }).connect(stream)

const shutdown = () => coordinator.shutdown()

// The routed connection ends on every SDK-side teardown — a rejected
// initialize, a routing failure, the client leaving — even while stdin stays
// open, so final shutdown runs here too instead of idling on a dead
// connection (idempotent with the stdin/SIGINT/SIGTERM/stdout-error
// triggers below).
void connection.closed.then(shutdown)

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', shutdown)
