import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

/** Manual probes use the built adapter; every response and shutdown must succeed. */
export async function withSmokeAgent(
  run,
  { command = process.execPath, args = ['dist/index.js'], timeoutMs = 30_000, env = process.env } = {}
) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env
  })
  const pending = new Map()
  const updates = []
  let nextId = 0
  let buffer = ''
  let timer
  let stopping = false
  let fail
  const failure = new Promise((_, reject) => {
    fail = reject
  })
  let close
  const closed = new Promise(resolve => {
    close = resolve
  })
  child.on('error', error => {
    fail(error)
    if (child.pid === undefined) close({ error })
  })
  child.stdin.on('error', fail)
  child.on('close', (code, signal) => {
    close({ code, signal })
    if (!stopping) fail(new Error(`adapter exited early: ${code ?? signal}`))
  })
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    if (buffer.length > 8 * 1024 * 1024) {
      fail(new Error('smoke output record too large'))
      return
    }
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (message.method === 'session/update') updates.push(message.params.update)
        const request = pending.get(message.id)
        if (!request) continue
        pending.delete(message.id)
        if (message.error || !message.result || typeof message.result !== 'object') {
          request.reject(new Error(`RPC ${request.method} failed: ${JSON.stringify(message)}`))
        } else request.resolve(message.result)
      } catch (error) {
        fail(error)
      }
    }
  })
  const client = {
    updates,
    request(method, params) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }
  }
  timer = setTimeout(() => fail(new Error(`ACP smoke timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([Promise.resolve().then(() => run(client)), failure])
  } finally {
    clearTimeout(timer)
    stopping = true
    child.stdin.end()
    const killTimer = setTimeout(() => child.kill('SIGTERM'), 1_000)
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 4_000)
    let deadline
    try {
      const exit = await Promise.race([
        closed,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('adapter shutdown timed out')), 5_000)
        })
      ])
      if (!exit.error) assert.equal(exit.code, 0, `adapter shutdown failed: ${exit.code ?? exit.signal}`)
    } finally {
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
      clearTimeout(deadline)
    }
  }
}

export async function newSmokeSession(client) {
  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {}
  })
  const session = await client.request('session/new', {
    cwd: process.cwd(),
    mcpServers: []
  })
  assert.equal(typeof session.sessionId, 'string')
  assert.ok(session.sessionId)
  return session
}

export async function smokePrompt(client, sessionId, text) {
  const result = await client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }]
  })
  assert.equal(result.stopReason, 'end_turn')
}

export function requireProviderOptIn() {
  if (process.env.PI_ACP_MANUAL_PROVIDER !== '1')
    throw new Error('Manual provider-generating probe: set PI_ACP_MANUAL_PROVIDER=1 to opt in')
}
