import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { builtinAvailableCommands } from '../../src/acp/builtin-commands.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: production command merge advertises builtin precedence and preserves project dispatch', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = Object.assign(new FakePiRpcProcess(), {
    getCommands: async () => ({
      commands: [
        {
          name: 'session',
          description: 'Project template: summarize deployment',
          source: 'prompt',
          sourceInfo: { source: 'local', scope: 'project', origin: 'top-level' }
        },
        { name: 'project-summary', description: 'Project summary', source: 'prompt' }
      ]
    }),
    getSessionStats: async () => ({ sessionId: 's1', totalMessages: 2 })
  })
  proc.state = { isStreaming: false }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: mkdtempSync(join(tmpdir(), 'pi-acp-merge-')),
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as unknown as { sessions: unknown }).sessions = { maybeGet: () => session, get: () => session }
  await (agent as unknown as { advertiseCommands(session: PiAcpSession): Promise<void> }).advertiseCommands(session)
  const update = conn.updates.find(({ update }) => update.sessionUpdate === 'available_commands_update')?.update
  assert.ok(update?.sessionUpdate === 'available_commands_update')
  const commands = update.availableCommands
  assert.deepEqual(
    commands.filter(command => command.name === 'session'),
    builtinAvailableCommands().filter(command => command.name === 'session')
  )
  assert.equal(commands.find(command => command.name === 'project-summary')?.description, 'Project summary')
  assert.equal(
    await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/session' }] }).then(r => r.stopReason),
    'end_turn'
  )
  assert.equal(proc.prompts.length, 0)
  assert.match(JSON.stringify(conn.updates), /Session: s1/)
  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/project-summary' }] })
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['/project-summary']
  )
  session.dispose()
})
