import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { encodeTitleWidget, TITLE_WIDGET } from '../../src/acp/session-title.js'
import acpExtension from '../../src/pi-rpc/acp-extension.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'pi-acp-session-title-cwd-'))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: TEST_CWD,
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}

/** The pi-side extension publishes every title through this widget. */
function emitTitle(proc: FakePiRpcProcess, title: string, widgetKey = TITLE_WIDGET, provisional = false) {
  proc.emit({
    type: 'extension_ui_request',
    id: 'title-1',
    method: 'setWidget',
    widgetKey,
    widgetLines: encodeTitleWidget(title, provisional)
  })
}

function titles(conn: FakeAgentSideConnection): Array<string | null> {
  return conn.updates
    .map(notification => notification.update)
    .filter(update => update.sessionUpdate === 'session_info_update' && 'title' in update)
    .map(update => (update as { title?: string | null }).title ?? null)
}

test('PiAcpSession: publishes a generated title through both layers', async () => {
  const { conn, proc, session } = makeSession()

  emitTitle(proc, 'Derive ACP Session Titles')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['Derive ACP Session Titles'])
  // Both layers: the ACP notification and pi's own session name.
  assert.deepEqual(proc.sessionNames, ['Derive ACP Session Titles'])
  session.dispose()
})

test('PiAcpSession: a provisional title is display-only, then replaced by the generated one', async () => {
  const { conn, proc, session } = makeSession()

  emitTitle(proc, 'Fix the thread title', TITLE_WIDGET, true)
  await tick()
  // The placeholder must never rename the persisted session: its echo would
  // also outrank the real title.
  assert.deepEqual(proc.sessionNames, [])

  emitTitle(proc, 'Fix ACP Session Titles')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['Fix the thread title', 'Fix ACP Session Titles'])
  assert.deepEqual(proc.sessionNames, ['Fix ACP Session Titles'])
  session.dispose()
})

test('PiAcpSession: an explicit or pi-side name is never replaced by a generated title', async () => {
  const { conn, proc, session } = makeSession()

  proc.emit({ type: 'session_info_changed', name: 'User chosen name' })
  emitTitle(proc, 'Should not appear')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['User chosen name'])
  assert.deepEqual(proc.sessionNames, [])

  const named = makeSession()
  named.session.markUserSessionName()
  emitTitle(named.proc, 'Also should not appear')
  await tick()

  assert.deepEqual(titles(named.conn), [])
  assert.deepEqual(named.proc.sessionNames, [])
  session.dispose()
  named.session.dispose()
})

test('PiAcpSession: ignores unknown, malformed and foreign title payloads', async () => {
  const { conn, proc, session } = makeSession()

  proc.emit({
    type: 'extension_ui_request',
    id: 'x',
    method: 'setWidget',
    widgetKey: TITLE_WIDGET,
    widgetLines: ['not json']
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'y',
    method: 'setWidget',
    widgetKey: TITLE_WIDGET,
    widgetLines: ['{"version":9,"title":"nope"}']
  })
  emitTitle(proc, 'Not A Title Source', 'someone-elses-widget')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), [])
  assert.deepEqual(proc.sessionNames, [])
  session.dispose()
})

test('PiAcpSession: a name that lands while the title is being applied wins', async () => {
  const { conn, proc, session } = makeSession()

  // Both emits are synchronous: the generated title is enqueued first, then the
  // foreign name. Delivery re-checks precedence, so the name must win both the
  // client and pi's stored session name.
  emitTitle(proc, 'Generated Title')
  proc.emit({ type: 'session_info_changed', name: 'User chosen name' })
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['User chosen name'])
  assert.deepEqual(proc.sessionNames, [])
  session.dispose()
})

test('PiAcpSession: a read-only pi still gets the title through ACP', async () => {
  const { conn, proc, session } = makeSession()
  proc.sessionNameError = new Error('unknown command: set_session_name')

  emitTitle(proc, 'Titles Still Work')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['Titles Still Work'])
  session.dispose()
})

test('PiAcpSession: an identical title is published once', async () => {
  const { conn, proc, session } = makeSession()

  emitTitle(proc, 'Same Title')
  emitTitle(proc, 'Same Title')
  await tick()
  await tick()

  assert.deepEqual(titles(conn), ['Same Title'])
  session.dispose()
})

test('PiAcpSession: a title queued at disposal is never published or persisted', async () => {
  const { conn, proc, session } = makeSession()

  emitTitle(proc, 'Too Late')
  session.dispose()
  await flush()

  assert.deepEqual(titles(conn), [])
  assert.deepEqual(proc.sessionNames, [], 'a disposed session must not rename pi')
})

test('PiAcpSession: the extension output drives the adapter end to end', async () => {
  const { conn, proc, session } = makeSession()
  // Real pi echoes its own rename; that echo once blocked the settled title.
  proc.echoSessionName = true

  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>()
  const extensionCtx = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    model: { provider: 'test', id: 'session-model' },
    modelRegistry: {
      complete: async () => ({ content: [{ type: 'text', text: '{"title":"Settled Title"}' }], stopReason: 'stop' }),
      getAvailable: () => [{ provider: 'test', id: 'cheap', cost: { input: 0.1, output: 0.2 } }],
      hasConfiguredAuth: () => true
    },
    sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined, getEntries: () => [] },
    ui: {
      setWidget: (key: string, lines: string[]) => {
        if (key !== TITLE_WIDGET) return
        proc.emit({
          type: 'extension_ui_request',
          id: 'title',
          method: 'setWidget',
          widgetKey: key,
          widgetLines: lines
        })
      }
    }
  }
  acpExtension({
    events: { on: () => () => {}, emit: () => {} },
    on: (name: string, handler: any) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerCommand: () => {},
    registerTool: () => {}
  } as any)
  const fire = (name: string, event: any = {}) => {
    for (const handler of hooks.get(name) ?? []) handler(event, extensionCtx)
  }

  fire('session_start')
  fire('input', { source: 'rpc', text: 'derive a thread title from context' })
  await flush()

  assert.deepEqual(titles(conn), ['derive a thread title from context', 'Settled Title'])
  assert.deepEqual(proc.sessionNames, ['Settled Title'])
  session.dispose()
})
