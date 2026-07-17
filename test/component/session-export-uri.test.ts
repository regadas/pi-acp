import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: /export emits a percent-encoded file URI for paths with special characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp export ü-'))
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 's1' }) + '\n', 'utf8')
  const exportedPath = join(dir, 'pi session export.html')

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false, sessionFile, messageCount: 3 }
  ;(proc as any).exportHtml = async (outputPath?: string) => {
    assert.ok(outputPath?.endsWith('.html'))
    return { path: exportedPath }
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === 's1' ? session : undefined),
    close: () => {}
  }

  const result = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/export' }] } as any)
  assert.equal(result.stopReason, 'end_turn')

  const link = conn.updates
    .map(u => (u as any).update)
    .find(u => u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'resource_link')
  assert.ok(link, 'expected a resource_link chunk')
  assert.equal(link.content.uri, pathToFileURL(exportedPath).href)
  assert.match(link.content.uri, /^file:\/\/\//)
  assert.ok(link.content.uri.includes('pi%20session%20export.html'), 'spaces must be percent-encoded')
})
