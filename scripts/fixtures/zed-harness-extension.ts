// Real Pi runtime with a deterministic local provider; no network or child agents.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default function (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) {
  let raceInjected = false
  let holdSettlementHook = false
  let holdAutonomous = false
  let active = false
  let runState = 'running'
  let launchMode = ''
  let stopAttempts = 0
  let unrelated = false
  let reportLaunching: ((id: string) => void) | undefined
  let reportRetry: ((code: string) => void) | undefined
  let completion: ReturnType<typeof setTimeout> | undefined
  let delivery: ReturnType<typeof setTimeout> | undefined
  let currentRun = ''
  let reportStop: ((id: string) => void) | undefined
  let reportTerminal: ((id: string) => void) | undefined
  let deliveryGate = ''
  pi.on('session_start', (_event, ctx) => {
    reportLaunching = id => ctx.ui.setStatus('eval-launching', id)
    reportRetry = code => ctx.ui.setStatus('eval-stop-retry', code)
    reportStop = id => ctx.ui.setStatus('eval-stopped', id)
    reportTerminal = id => ctx.ui.setStatus('eval-terminal', id)
    deliveryGate = join(ctx.cwd, 'deliver-async')
    const registry = (globalThis as Record<symbol, { register(provider: unknown): () => void }>)[
      Symbol.for('@agegr/pi-web/session-liveness/v1')
    ]
    registry.register({
      name: 'pi-subagents',
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      isActive: () => {
        if (active && !currentRun) {
          try {
            if (readFileSync(join(ctx.cwd, 'release-unrelated'), 'utf8') === 'release') active = false
          } catch {
            /* Gate not released. */
          }
        }
        return active || unrelated
      }
    })
  })
  pi.events.on('subagents:rpc:v1:request', raw => {
    const request = raw as { requestId: string; method: string; params: { id: string } }
    if (request.method === 'status') {
      pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            runs: [{ id: currentRun, state: runState }, ...(unrelated ? [{ id: 'unrelated', state: 'running' }] : [])]
          }
        }
      })
      return
    }
    if (request.method !== 'stop' || request.params.id !== currentRun) return
    if (launchMode === 'queued' && stopAttempts++ < 2) {
      const code = stopAttempts === 1 ? 'not_found' : 'invalid_state'
      if (stopAttempts === 2) runState = 'running'
      reportRetry?.(code)
      pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: false,
        error: {
          code,
          message:
            code === 'not_found'
              ? `Status file not found for async run '${currentRun}'.`
              : `Async run ${currentRun} is queued; stop only supports running async runs.`
        }
      })
      return
    }
    clearTimeout(completion)
    clearTimeout(delivery)
    runState = 'stopped'
    active = false
    reportStop?.(currentRun)
    pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: { runId: currentRun }
    })
  })
  pi.registerTool({
    name: 'subagent',
    label: 'Deterministic async contract',
    description: 'No child agents are launched',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _params, signal) {
      active = true
      currentRun = crypto.randomUUID()
      runState = launchMode === 'queued' ? 'queued' : 'running'
      stopAttempts = 0
      unrelated = launchMode === 'queued'
      if (launchMode === 'late') {
        reportLaunching?.(currentRun)
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (!launchMode)
        completion = setTimeout(() => {
          // A terminal child may still have a batched completion awaiting delivery.
          runState = 'complete'
          reportTerminal?.(currentRun)
          delivery = setInterval(() => {
            try {
              if (readFileSync(deliveryGate, 'utf8') !== currentRun) return
            } catch {
              return
            }
            clearInterval(delivery)
            pi.sendMessage(
              { customType: 'subagent-notify', content: 'ASYNC_COMPLETION', display: true },
              { triggerTurn: true }
            )
            active = false
          }, 10)
        }, 500)
      return {
        content: [{ type: 'text', text: 'Async work scheduled' }],
        details: { asyncId: currentRun, runId: currentRun }
      }
    }
  })
  pi.registerProvider('acp-eval', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'isolated-no-network',
    api: 'acp-eval',
    models: [
      {
        id: 'local',
        name: 'Local evaluation',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000
      }
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream()
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'HARNESS_RESPONSE' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop' as const,
        timestamp: Date.now()
      }
      const last = context.messages.at(-1)
      const launch = last?.role === 'user' && JSON.stringify(last.content).includes('launch async')
      if (launch) {
        message.content = [{ type: 'toolCall', id: crypto.randomUUID(), name: 'subagent', arguments: {} }]
        message.stopReason = 'toolUse'
      }
      const deferredSynthesis = JSON.stringify(last?.content).includes('DEFERRED_SYNTHESIS')
      const autonomous = holdAutonomous && JSON.stringify(last?.content).includes('ASYNC_COMPLETION')
      if (deferredSynthesis) {
        message.content = [{ type: 'text', text: 'DEFERRED_SYNTHESIS_PROGRESS' }]
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'DEFERRED_SYNTHESIS_PROGRESS', partial: message })
      }
      if (autonomous) {
        holdAutonomous = false
        message.content = [{ type: 'text', text: 'AUTONOMOUS_PROGRESS' }]
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'AUTONOMOUS_PROGRESS', partial: message })
      }
      const finish = () => {
        if (!autonomous && !deferredSynthesis) stream.push({ type: 'start', partial: message })
        if (options?.signal?.aborted) {
          stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } })
        } else {
          if (launch)
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message })
          else if (!autonomous && !deferredSynthesis)
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'HARNESS_RESPONSE', partial: message })
          stream.push({ type: 'done', reason: message.stopReason, message })
        }
        stream.end()
      }
      if (autonomous || deferredSynthesis) {
        const timer = setInterval(() => {
          if (!options?.signal?.aborted) {
            try {
              if (
                readFileSync(
                  join(deliveryGate, '..', deferredSynthesis ? 'finish-deferred-synthesis' : 'finish-autonomous'),
                  'utf8'
                ) !== 'release'
              )
                return
            } catch {
              return
            }
          }
          clearInterval(timer)
          finish()
        }, 10)
      } else setTimeout(finish, 100)
      return stream
    }
  })
  pi.registerCommand('eval-settlement-gate', {
    description: 'Start an isolated autonomous run with gated native settlement and deferred synthesis',
    handler: async () => {
      holdSettlementHook = true
      setTimeout(
        () =>
          pi.sendMessage(
            { customType: 'eval-hook-run', content: 'SETTLEMENT_HOOK_RUN', display: true },
            { triggerTurn: true }
          ),
        20
      )
    }
  })
  pi.on('agent_settled', async (_event, ctx) => {
    if (!holdSettlementHook) return
    holdSettlementHook = false
    const started = Date.now()
    ctx.ui.setStatus('eval-hook-entered', JSON.stringify({ started, pid: process.pid }))
    // Pi defers this full synthesis before later prompt/control actions.
    pi.sendMessage(
      { customType: 'eval-deferred-synthesis', content: 'DEFERRED_SYNTHESIS', display: true },
      { triggerTurn: true }
    )
    while (Date.now() - started < 60_000) {
      try {
        if (readFileSync(join(ctx.cwd, 'release-settlement-hook'), 'utf8') === 'release') break
      } catch {
        /* Explicit test gate remains held. */
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    ctx.ui.setStatus('eval-hook-released', JSON.stringify({ elapsedMs: Date.now() - started, pid: process.pid }))
  })
  pi.registerCommand('eval-hold-autonomous', {
    description: 'Hold the next deterministic autonomous model run',
    handler: async () => {
      holdAutonomous = true
    }
  })
  pi.registerCommand('eval-confirm', {
    description: 'Evaluation confirm',
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(
        'eval-session',
        JSON.stringify({
          id: ctx.sessionManager.getSessionId(),
          file: ctx.sessionManager.getSessionFile(),
          pid: process.pid
        })
      )
      const value = await ctx.ui.confirm('Harness confirm', 'Proceed?')
      ctx.ui.notify(`CONFIRMED:${value}`, 'info')
    }
  })
  pi.registerCommand('eval-timeout', {
    description: 'Evaluation native dialog expiry',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.confirm('Harness timeout', 'Do not answer', { timeout: 100 })
      ctx.ui.notify(`TIMEOUT_DEFAULT:${value}`, 'info')
    }
  })
  pi.registerCommand('eval-input', {
    description: 'Evaluation input',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input('Harness input')
      ctx.ui.notify(`INPUT:${value}`, 'info')
    }
  })
  pi.registerCommand('eval-display', {
    description: 'Evaluation display',
    handler: async (_args, ctx) => {
      ctx.ui.setStatus('eval', 'status')
      ctx.ui.setWidget('eval', ['widget'])
      ctx.ui.setTitle('title')
      ctx.ui.setEditorText('editor')
      ctx.ui.notify('DISPLAY_NOTICE', 'info')
    }
  })
  pi.registerCommand('eval-unrelated', {
    description: 'Evaluation unrelated liveness gate',
    handler: async () => {
      active = true
    }
  })
  pi.registerCommand('eval-exit', {
    description: 'Evaluation process exit',
    handler: async () => {
      process.exit(23)
    }
  })
  pi.on('input', event => {
    if (event.source === 'rpc' && event.text === 'native admission race' && !raceInjected) {
      raceInjected = true
      pi.sendMessage({ customType: 'eval-race', content: 'RACE_AUTONOMOUS', display: true }, { triggerTurn: true })
    }
  })
  pi.on('before_agent_start', event => {
    launchMode = event.prompt.includes('async late') ? 'late' : event.prompt.includes('async queued') ? 'queued' : ''
    if (event.prompt.includes('native queue'))
      setTimeout(() => pi.sendUserMessage('NATIVE_QUEUED', { deliverAs: 'followUp' }), 10)
  })
  pi.on('session_before_compact', async (_event, ctx) => {
    await ctx.ui.confirm('Compaction gate', 'Compact?')
    return { cancel: true }
  })
  pi.on('session_shutdown', () => {
    clearTimeout(completion)
    clearTimeout(delivery)
  })
}
