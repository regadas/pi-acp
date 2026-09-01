import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { builtinAvailableCommands, runBuiltinCommand } from '../../src/acp/builtin-commands.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession forwards non-adapter slash commands unchanged for pi trust-aware expansion', async () => {
  const proc = new FakePiRpcProcess()
  proc.state = { isStreaming: false }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: '/tmp',
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: [{ name: 'hello', content: 'unsafe adapter expansion' }]
  })
  const prompt = session.prompt('/hello world')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.prompts[0]?.message, '/hello world')
})

test('adapter command inventory does not claim an installed pi changelog', () => {
  assert.equal(
    builtinAvailableCommands().some(command => command.name === 'changelog'),
    false
  )
})

test('adapter export rejects a missing or empty session file before calling pi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-export-preflight-'))
  const sessionFile = join(root, 'session.jsonl')
  const updates: any[] = []
  let exportCalls = 0
  const session = {
    sessionId: 'export-session',
    cwd: root,
    proc: {
      getState: async () => ({ sessionFile, messageCount: 1 }),
      exportHtml: async () => {
        exportCalls += 1
        return { path: join(root, 'out.html') }
      }
    }
  }
  const ctx = {
    cancelled: () => false,
    sendSessionUpdate: async (update: unknown) => updates.push(update)
  }

  await runBuiltinCommand(session as any, 'export', [], ctx as any)
  writeFileSync(sessionFile, '   \n')
  await runBuiltinCommand(session as any, 'export', [], ctx as any)

  assert.equal(exportCalls, 0)
  assert.equal(updates.length, 2)
  assert.ok(updates.every(update => update.update.content.text.includes('Nothing to export')))
})
