// Minimal pi RPC stand-in for PiRpcProcess integration tests.
// Usage: node fake-pi-rpc.mjs <behavior>

const behavior = process.argv[2] ?? 'respond'

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function respondOk(cmd) {
  send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: { isStreaming: false } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    idx = buffer.indexOf('\n')
    if (!line.trim()) continue
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      continue
    }
    handle(cmd)
  }
})

function handle(cmd) {
  switch (behavior) {
    case 'silent':
      return
    case 'late-response':
      setTimeout(() => respondOk(cmd), 400)
      return
    default:
      respondOk(cmd)
  }
}

switch (behavior) {
  case 'events-then-exit':
    send({ type: 'session_info_changed', text: 'line separator: \u2028 and paragraph separator: \u2029 survive' })
    send({ type: 'session_info_changed', text: 'second' })
    process.exit(3)
    break
  case 'split-writes': {
    const line = Buffer.from(JSON.stringify({ type: 'session_info_changed', text: 'héllo 🌍 world' }) + '\n', 'utf8')
    const mid = line.indexOf(Buffer.from('🌍', 'utf8')) + 2 // split inside the emoji
    process.stdout.write(line.subarray(0, mid))
    setTimeout(() => process.stdout.write(line.subarray(mid)), 30)
    break
  }
  case 'garbage-then-event':
    process.stdout.write('\u001b[1mstarting fake pi...\u001b[0m\n{not json\n')
    send({ type: 'session_info_changed', ok: true })
    break
  case 'stderr-flood':
    process.stderr.write('x'.repeat(64 * 1024) + 'TAIL-END\n')
    break
  case 'ignore-sigterm':
    process.on('SIGTERM', () => {})
    send({ type: 'session_info_changed', ready: true })
    setInterval(() => {}, 1_000)
    break
  default:
    break
}
