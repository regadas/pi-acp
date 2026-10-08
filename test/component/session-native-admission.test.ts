import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import acpExtension from '../../src/pi-rpc/acp-extension.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills: unknown[] = []
  kill(signal: unknown) {
    this.kills.push(signal)
    return true
  }
}
function harness(options: { restoredChild?: boolean; foreignQueueRace?: boolean; holdBegin?: boolean } = {}) {
  const child = new Child()
  const proc = PiRpcProcess.fromChild(child as unknown as ChildProcessWithoutNullStreams)
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({ sessionId: 's', cwd: '/tmp', proc, conn: asAgentConn(conn) })
  const commands: Array<{ type: string; message?: string; id: string; streamingBehavior?: string }> = []
  let busy = false
  let race = false
  let accepted = 0
  const heldBegins: Array<{ id: string; owner: string }> = []
  type Pi = Parameters<typeof acpExtension>[0]
  type Hook = Parameters<Pi['on']>[1]
  type Context = Parameters<Hook>[1]
  const hooks = new Map<string, Hook>()
  let companionCommand: Parameters<Pi['registerCommand']>[1]['handler'] | undefined
  const emit = (event: Parameters<Hook>[0] & { type: string; [key: string]: unknown }) => {
    hooks.get(event.type)?.(event, ctx)
    child.stdout.write(JSON.stringify(event) + '\n')
  }
  const ctx: Context = {
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => 's', getSessionFile: () => '/session' },
    ui: {
      setWidget: (key, lines) =>
        emit({
          type: 'extension_ui_request',
          id: 'widget',
          method: 'setWidget',
          widgetKey: key,
          widgetLines: lines
        })
    }
  }
  const hostRequests: unknown[] = []
  const registryKey = Symbol.for('@agegr/pi-web/session-liveness/v1')
  const globals = globalThis as Record<symbol, unknown>
  const previousRegistry = globals[registryKey]
  if (options.restoredChild) {
    const events = new EventEmitter()
    events.on('subagents:rpc:v1:request', request => hostRequests.push(request))
    acpExtension({
      events: {
        on: (name, handler) => {
          events.on(name, handler)
          return () => {
            events.off(name, handler)
          }
        },
        emit: (name, data) => {
          events.emit(name, data)
        }
      },
      on: (name, handler) => {
        hooks.set(name, handler)
      },
      registerCommand: (_name, command) => {
        companionCommand = command.handler
      }
    })
    const registry = globals[registryKey] as {
      register(provider: { name: string; sessionId: string; isActive(): boolean }): () => void
    }
    registry.register({ name: 'pi-subagents', sessionId: 's', isActive: () => true })
  }
  const widget = (owner: string, state: string) =>
    emit({
      type: 'extension_ui_request',
      id: 'widget',
      method: 'setWidget',
      widgetKey: 'pi-acp-lifecycle',
      widgetLines: [JSON.stringify({ version: 1, owner, state })]
    })
  child.stdin.on('data', async chunk => {
    const command = JSON.parse(String(chunk))
    commands.push(command)
    let success = true
    let error: string | undefined
    if (command.message?.startsWith('/pi-acp-control')) {
      const [, operation, owner] = command.message.split(' ')
      if (options.holdBegin && operation === 'begin') {
        heldBegins.push({ id: command.id, owner })
        return
      }
      if (companionCommand) await companionCommand(command.message.slice('/pi-acp-control '.length), ctx)
      else widget(owner, operation === 'withdraw' ? 'withdrawn' : busy ? 'waiting' : 'ready')
    } else if (command.type === 'prompt') {
      assert.equal(command.streamingBehavior, undefined, 'foreign native text queues cannot be withdrawn exactly')
      if (race) {
        race = false
        busy = true
        emit({ type: 'agent_start' })
        if (options.foreignQueueRace)
          emit({ type: 'queue_update', steering: [], followUp: ['foreign question', 'foreign question'] })
        success = false
        error = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
      } else {
        accepted++
      }
    }
    if (command.type === 'abort') {
      busy = false
      emit({ type: 'agent_settled' })
    }
    emit({
      type: 'response',
      id: command.id,
      command: command.type,
      success,
      error,
      data:
        command.type === 'get_commands'
          ? { commands: [{ name: 'pi-acp-control' }] }
          : command.type === 'clear_queue'
            ? { steering: [], followUp: [] }
            : { isStreaming: busy }
    })
    if (success && command.type === 'prompt' && !command.message.startsWith('/pi-acp-control')) {
      busy = true
      emit({ type: 'input', source: 'rpc', text: command.message })
      emit({ type: 'before_agent_start', prompt: command.message })
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: { role: 'user', content: command.message } })
    }
  })
  return {
    child,
    session,
    conn,
    commands,
    hostRequests,
    widget,
    releaseBegins(batchedWithdrawal = false) {
      const batch: unknown[] = []
      for (const begin of heldBegins.splice(0)) {
        batch.push({
          type: 'extension_ui_request',
          id: 'widget',
          method: 'setWidget',
          widgetKey: 'pi-acp-lifecycle',
          widgetLines: [JSON.stringify({ version: 1, owner: begin.owner, state: busy ? 'waiting' : 'ready' })]
        })
        if (batchedWithdrawal)
          batch.push({
            type: 'extension_ui_request',
            id: 'widget',
            method: 'setWidget',
            widgetKey: 'pi-acp-lifecycle',
            widgetLines: [JSON.stringify({ version: 1, owner: begin.owner, state: 'withdrawn' })]
          })
        batch.push({
          type: 'response',
          id: begin.id,
          command: 'prompt',
          success: true,
          data: { disposition: 'handled' }
        })
      }
      child.stdout.write(batch.map(record => JSON.stringify(record)).join('\n') + '\n')
    },
    cleanup() {
      hooks.get('session_shutdown')?.({}, ctx)
      assert.equal(globals[registryKey], previousRegistry)
    },
    emit,
    get accepted() {
      return accepted
    },
    start() {
      busy = true
      emit({ type: 'agent_start' })
    },
    settle() {
      busy = false
      emit({ type: 'agent_settled' })
    },
    race() {
      race = true
    }
  }
}

test('native admission: staged input is acknowledged, exact cancellation survives late readiness and keeps autonomous channel alive', async () => {
  const h = harness()
  h.start()
  const prompt = h.session.prompt('ordinary question')
  await tick()
  const begin = h.commands.find(command => command.message?.includes('begin'))!
  assert.ok(begin)
  const owner = begin.message!.split(' ')[2]!
  assert.ok(
    h.conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text.includes('Input queued')
    )
  )
  assert.equal(h.accepted, 0)
  await h.session.cancel()
  assert.equal(await prompt, 'cancelled')
  assert.ok(h.commands.some(command => command.message === `/pi-acp-control withdraw ${owner}`))
  h.widget(owner, 'ready')
  h.settle()
  await tick()
  assert.equal(h.accepted, 0)
  assert.deepEqual(h.child.kills, [])
  assert.ok(!h.commands.some(command => command.type === 'abort' || command.type === 'clear_queue'))
})

test('native admission: ready-to-prompt race re-admits without inserting native text or killing the foreign run', async () => {
  const h = harness()
  h.race()
  const prompt = h.session.prompt('ordinary question')
  await tick()
  assert.equal(h.accepted, 0)
  assert.deepEqual(h.child.kills, [])
  assert.ok(
    h.conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text.includes('Input queued')
    )
  )
  // Readiness cannot substitute for the RPC boundary after awaited settle hooks.
  const owner = h.commands.find(command => command.message?.includes('begin'))!.message!.split(' ')[2]!
  h.widget(owner, 'ready')
  await tick()
  assert.equal(h.commands.filter(command => command.message === 'ordinary question').length, 1)
  h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'autonomous progress' } })
  h.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length' } })
  h.settle()
  await tick()
  assert.equal(h.accepted, 1, 'only one prompt enters a model run')
  h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned answer' } })
  h.settle()
  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(h.child.kills, [])
  assert.ok(!h.commands.some(command => command.type === 'abort' || command.type === 'clear_queue'))
})

test('native admission: staged shutdown withdraws only its token and cannot dispatch on late callbacks', async () => {
  const h = harness()
  h.start()
  const prompt = h.session.prompt('ordinary question')
  await tick()
  const owner = h.commands.find(command => command.message?.includes('begin'))!.message!.split(' ')[2]!
  await h.session.shutdown()
  assert.equal(await prompt, 'cancelled')
  h.widget(owner, 'ready')
  h.settle()
  await tick()
  assert.equal(h.accepted, 0)
  assert.ok(!h.commands.some(command => command.type === 'abort' || command.type === 'clear_queue'))
})

test('native admission: executing foreground cancellation survives continuously live unrelated children', async t => {
  const h = harness({ restoredChild: true })
  t.after(() => {
    h.cleanup()
    h.child.emit('exit', 0, null)
  })
  const prompt = h.session.prompt('ordinary question')
  await tick()
  assert.equal(h.accepted, 1)
  await h.session.cancel()
  assert.equal(await prompt, 'cancelled')
  assert.equal(h.session.isUnavailable(), false, 'foreign liveness cannot quarantine an empty child ownership scope')
  assert.deepEqual(h.child.kills, [])
  assert.deepEqual(h.hostRequests, [], 'restored children never acquire foreground stop authority')
  const next = h.session.prompt('next ordinary question')
  await tick()
  assert.equal(h.accepted, 2, 'same subprocess remains usable after cancellation')
  h.settle()
  assert.equal(await next, 'end_turn')
})

test('native admission: foreign queue updates from a rejected attempt cannot claim or block re-admitted input', async t => {
  const h = harness({ foreignQueueRace: true })
  t.after(() => h.child.emit('exit', 0, null))
  h.race()
  const prompt = h.session.prompt('ordinary question').then(
    value => value,
    error => error
  )
  await tick()
  assert.equal(h.accepted, 0)
  h.emit({ type: 'message_start', message: { role: 'user', content: 'foreign question' } })
  h.emit({ type: 'message_start', message: { role: 'user', content: 'foreign question' } })
  h.emit({ type: 'queue_update', steering: [], followUp: [] })
  h.emit({ type: 'message_update', assistantMessageEvent: { type: 'done', reason: 'length' } })
  h.settle()
  await tick()
  assert.equal(h.accepted, 1, 'exactly one raw prompt is accepted despite the rejected preflight')
  h.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'owned answer' } })
  h.settle()
  assert.equal(await prompt, 'end_turn')
  assert.equal(h.session.isUnavailable(), false)
  assert.deepEqual(h.child.kills, [])
  assert.ok(!h.commands.some(command => command.type === 'abort' || command.type === 'clear_queue'))
  assert.equal(
    h.commands.filter(command => command.message === 'ordinary question').length,
    2,
    'one rejection and one acceptance'
  )
})

test('native admission: batched waiting and withdrawn ACKs before begin response cannot quarantine autonomous work', async t => {
  const h = harness({ holdBegin: true })
  t.after(() => h.child.emit('close', 0, null))
  h.start()
  const prompt = h.session.prompt('withdraw batched input')
  await tick()
  const cancellation = h.session.cancel()
  await tick()
  h.releaseBegins(true)
  await cancellation
  assert.equal(await prompt, 'cancelled')
  await tick()
  assert.deepEqual(h.child.kills, [], 'withdrawn ACK cannot replace begin waiting ACK')
  assert.equal(h.session.isUnavailable(), false)
  h.settle()
  await tick()
  assert.equal(h.accepted, 0)
  assert.ok(!h.commands.some(command => command.type === 'abort' || command.type === 'clear_queue'))
})

test('native admission: long native hook deferral permits local cancellation and a new token before old ACK', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const h = harness({ holdBegin: true })
  t.after(() => h.child.emit('close', 0, null))
  h.start()
  const prompt = h.session.prompt('withdraw long-hook input').then(
    value => value,
    error => error
  )
  await tick()
  t.mock.timers.tick(600_001)
  await tick()
  assert.deepEqual(h.child.kills, [], 'healthy native hook time is not admission response timeout')
  let cancelled = false
  void h.session.cancel().then(() => {
    cancelled = true
  })
  await tick()
  assert.equal(cancelled, true, 'local withdrawal cannot await native settlement or deferred controls')
  assert.equal(await prompt, 'cancelled')
  const next = h.session.prompt('new-token input').then(
    value => value,
    error => error
  )
  await tick()
  h.releaseBegins(true)
  await tick()
  h.settle()
  await tick()
  h.releaseBegins()
  await tick()
  assert.equal(h.accepted, 1)
  assert.equal(h.commands.filter(command => command.message === 'withdraw long-hook input').length, 0)
  h.settle()
  assert.equal(await next, 'end_turn')
  assert.deepEqual(h.child.kills, [])
})
