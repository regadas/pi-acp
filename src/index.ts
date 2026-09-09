import { ndJsonStream } from '@agentclientprotocol/sdk'
import { createPiAcpAgentApp } from './acp/app.js'
import type { PiAcpAgent } from './acp/agent.js'
import { createShutdownCoordinator } from './acp/shutdown.js'
import { buildPiInvocation, getPiCommand } from './pi-rpc/command.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
  const invocation = buildPiInvocation(cmd, [], { cwd: process.cwd() })
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

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

// Slightly above PiRpcProcess's 2s SIGTERM -> SIGKILL grace so a child that
// ignores SIGTERM is still killed before the adapter exits.
const SHUTDOWN_TERMINATION_TIMEOUT_MS = 3_000

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

createPiAcpAgentApp({ onAgent: agent => coordinator.trackAgent(agent) }).connect(stream)

const shutdown = () => coordinator.shutdown()

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', shutdown)
