import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {
    // noop
  }
}

test('PiAcpAgent: does not emit startup info on loadSession', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      onTermination: () => () => {},
      getTree: async () => ({ tree: [], leafId: null }),
      getAvailableModels: async () => ({ models: [] }),
      // Restore validation requires pi to report the requested session.
      getState: async () => ({ thinkingLevel: 'medium', sessionId: 's1', sessionFile: '/tmp/s.jsonl' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Local seam: capture deferred notifications instead of patching timers.
    const deferred: Array<() => void> = []
    ;(agent as any).scheduleDeferred = (task: () => void) => {
      deferred.push(task)
    }

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore()

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    // Only available_commands_update should be scheduled.
    assert.equal(deferred.length, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
