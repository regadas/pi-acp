import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NewSessionRequest } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

type CreateOnlySessionManager = {
  create(params: unknown): Promise<never>
  maybeGet?(): undefined
}

function replaceSessionManager(agent: PiAcpAgent, manager: CreateOnlySessionManager): void {
  ;(agent as unknown as { sessions: CreateOnlySessionManager }).sessions = manager
}

function expectInvalidParamsReason(reason: string): (error: unknown) => boolean {
  return error => {
    const requestError = error as { code?: number; data?: { reason?: string } }
    assert.equal(requestError.code, -32602)
    assert.equal(requestError.data?.reason, reason)
    return true
  }
}

function expectResourceNotFound(error: unknown): boolean {
  assert.equal((error as { code?: number }).code, -32002)
  return true
}

test('PiAcpAgent validates cwd before new/load/resume startup work', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-request-cwd-'))
  const missing = join(cwd, 'missing')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let createCalls = 0
  replaceSessionManager(agent, {
    async create() {
      createCalls += 1
      throw new Error('unreachable')
    }
  })

  await assert.rejects(agent.newSession({ cwd: missing, mcpServers: [] }), expectInvalidParamsReason('CWD_NOT_FOUND'))
  await assert.rejects(
    agent.loadSession({ sessionId: randomUUID(), cwd: missing, mcpServers: [] }),
    expectInvalidParamsReason('CWD_NOT_FOUND')
  )
  await assert.rejects(
    agent.resumeSession({ sessionId: randomUUID(), cwd: missing, mcpServers: [] }),
    expectInvalidParamsReason('CWD_NOT_FOUND')
  )
  assert.equal(createCalls, 0)
})

test('PiAcpAgent rejects non-empty additionalDirectories on new/load/resume', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-additional-directories-'))
  const extra = mkdtempSync(join(tmpdir(), 'pi-acp-extra-directory-'))
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let createCalls = 0
  replaceSessionManager(agent, {
    async create() {
      createCalls += 1
      throw new Error('unreachable')
    }
  })

  const rejection = expectInvalidParamsReason('ADDITIONAL_DIRECTORIES_UNSUPPORTED')
  await assert.rejects(agent.newSession({ cwd, mcpServers: [], additionalDirectories: [extra] }), rejection)
  await assert.rejects(
    agent.loadSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [extra] }),
    rejection
  )
  await assert.rejects(
    agent.resumeSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [extra] }),
    rejection
  )
  assert.equal(createCalls, 0)
})

test('PiAcpAgent accepts empty or omitted additionalDirectories', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-empty-additional-directories-'))
  const sentinel = new Error('validation passed')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let createCalls = 0
  replaceSessionManager(agent, {
    maybeGet() {
      return undefined
    },
    async create() {
      createCalls += 1
      throw sentinel
    }
  })

  const requests: NewSessionRequest[] = [
    { cwd, mcpServers: [], additionalDirectories: [] },
    { cwd, mcpServers: [] }
  ]
  for (const request of requests) {
    await assert.rejects(agent.newSession(request), error => error === sentinel)
  }
  assert.equal(createCalls, 2)

  await assert.rejects(
    agent.loadSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [] }),
    expectResourceNotFound
  )
  await assert.rejects(agent.resumeSession({ sessionId: randomUUID(), cwd, mcpServers: [] }), expectResourceNotFound)
})
