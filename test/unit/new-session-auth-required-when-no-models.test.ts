import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create(_params: any) {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: newSession throws AUTH_REQUIRED when pi reports no usable models payload', async () => {
  // Empty and malformed payloads are equally unauthenticated: only the
  // models array is consumed at this boundary.
  const payloads: unknown[] = [{ models: [] }, null, 'not-an-object', {}, { models: 'not-a-list' }]

  for (const payload of payloads) {
    const conn = new FakeAgentSideConnection()

    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return payload
        },
        async getState() {
          return { thinkingLevel: 'medium', model: null }
        }
      }
    }

    const sessions = new FakeSessions(session)
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = sessions as any

    let threw = false
    try {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    } catch (e: any) {
      threw = true
      assert.equal(e?.code, -32000, `payload: ${JSON.stringify(payload)}`)
      assert.match(String(e?.message), /Configure an API key or log in with an OAuth provider/i)
    }

    assert.equal(threw, true, `payload: ${JSON.stringify(payload)}`)
    assert.deepEqual(sessions.closeCalls, ['s1'], `payload: ${JSON.stringify(payload)}`)
  }
})
