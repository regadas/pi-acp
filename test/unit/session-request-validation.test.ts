import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NewSessionRequest } from '@agentclientprotocol/sdk/unstable'
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

test('PiAcpAgent validates additional directories before new/load/resume startup work', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-additional-directories-'))
  const valid = mkdtempSync(join(tmpdir(), 'pi-acp-valid-extra-directory-'))
  const missing = join(cwd, 'missing')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const createParams: unknown[] = []
  replaceSessionManager(agent, {
    maybeGet() {
      return undefined
    },
    async create(params) {
      createParams.push((params as { additionalDirectories?: string[] }).additionalDirectories)
      throw new Error('validation passed')
    }
  })

  await assert.rejects(
    agent.newSession({ cwd, mcpServers: [], additionalDirectories: [missing] }),
    expectInvalidParamsReason('ADDITIONAL_DIRECTORY_NOT_FOUND')
  )
  await assert.rejects(
    agent.loadSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [missing] }),
    expectInvalidParamsReason('ADDITIONAL_DIRECTORY_NOT_FOUND')
  )
  await assert.rejects(
    agent.resumeSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [missing] }),
    expectInvalidParamsReason('ADDITIONAL_DIRECTORY_NOT_FOUND')
  )
  assert.deepEqual(createParams, [], 'invalid roots must not reach session creation')

  await assert.rejects(
    agent.newSession({ cwd, mcpServers: [], additionalDirectories: [valid] }),
    error => (error as Error).message === 'validation passed'
  )
  assert.deepEqual(createParams, [[valid]], 'normalized roots reach session creation in order')
})

test('PiAcpAgent accepts empty or omitted additionalDirectories', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-empty-additional-directories-'))
  const sentinel = new Error('validation passed')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const createParams: unknown[][] = []
  replaceSessionManager(agent, {
    maybeGet() {
      return undefined
    },
    async create(params) {
      createParams.push((params as { additionalDirectories?: string[] }).additionalDirectories ?? [])
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
  assert.deepEqual(createParams, [[], []], 'omitted and empty roots both mean none')

  await assert.rejects(
    agent.loadSession({ sessionId: randomUUID(), cwd, mcpServers: [], additionalDirectories: [] }),
    expectResourceNotFound
  )
  await assert.rejects(agent.resumeSession({ sessionId: randomUUID(), cwd, mcpServers: [] }), expectResourceNotFound)
})
