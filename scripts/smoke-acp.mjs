import { spawn } from 'node:child_process'

const cwd = process.cwd()
const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  // The built-in prompt never calls a provider; placeholders only let a clean
  // pi install enumerate models during session/new.
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'pi-acp-smoke-no-call',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'pi-acp-smoke-no-call'
  }
})
const responses = new Map()
let buffer = ''
let sessionId

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ACP smoke timed out')), 30_000)
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.id != null) responses.set(message.id, message)
      if (message.id === 2 && message.result?.sessionId && !sessionId) {
        sessionId = message.result.sessionId
        send({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: '/name pi-acp-smoke' }] }
        })
      }
      if (message.id === 3) {
        send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
        child.stdin.end()
      }
    }
  })
  child.once('error', reject)
  child.once('exit', code => {
    clearTimeout(timer)
    if (code !== 0) return reject(new Error(`adapter exited ${code}`))
    for (const id of [1, 2, 3]) {
      if (!responses.get(id)?.result) return reject(new Error(`missing successful response ${id}`))
    }
    resolve()
  })
})

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })
await done
console.log('ACP smoke passed: initialize/new/builtin prompt/idle cancel/shutdown')
