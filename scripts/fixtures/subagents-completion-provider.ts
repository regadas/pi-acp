// Product-test fixture only: real Pi + unmodified stock pi-subagents 0.77.0, deterministic local provider, no network.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FOREIGN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const WAITING = 'ACP is keeping this request open'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Part = { type: string; text?: string; name?: string; id?: string }
type Message = { role: string; content: string | Part[]; isError?: boolean; toolName?: string }

const textOf = (message: Message | undefined) =>
  !message
    ? ''
    : typeof message.content === 'string'
      ? message.content
      : message.content.map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')

export default function (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) {
  const root = process.env.PI_ACP_STOCK_ROOT
  if (!root) throw new Error('PI_ACP_STOCK_ROOT is required')
  const log = (data: Record<string, unknown>) =>
    appendFileSync(join(root, 'stock.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n')
  let sessionId = ''
  let scenario = ''
  let snapshotTimer: ReturnType<typeof setInterval> | undefined

  // Observe the adapter's public v1 requests and stock replies; never answer them here.
  pi.events.on('subagents:rpc:v1:request', raw => {
    const request = raw as { method: string; requestId: string; params?: unknown; source?: { extension?: string } }
    if (request.source?.extension !== 'pi-acp' || request.method === 'status') return
    const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${request.requestId}`, reply => {
      unsubscribe()
      log({ event: `${request.method}-reply`, sessionId, request, reply })
    })
  })
  // The stock native supervisor channel's public wake signal; the adapter attributes episodes from it.
  pi.events.on('pi-intercom:detach-request', raw => log({ event: 'supervisor-wake', sessionId, scenario, data: raw }))
  pi.events.on('subagent:async-complete', raw => {
    const data = raw as { id?: unknown; runId?: unknown; state?: unknown }
    log({ event: 'async-complete', sessionId, id: data.runId ?? data.id })
  })
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId()
    log({
      event: 'session',
      sessionId,
      file: ctx.sessionManager.getSessionFile(),
      cliAppend: process.argv.some(arg => arg.startsWith('--append-system-prompt'))
    })
    // Compact public snapshot trace for nested/terminal evidence; no stop/control authority.
    snapshotTimer = setInterval(() => {
      const requestId = crypto.randomUUID()
      const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, raw => {
        unsubscribe()
        const snapshot = (raw as { data?: { asyncSnapshot?: { runs?: unknown[]; omitted?: unknown } } }).data
          ?.asyncSnapshot
        if (snapshot?.runs?.length)
          log({ event: 'snapshot', sessionId, runs: snapshot.runs, omitted: snapshot.omitted })
      })
      pi.events.emit('subagents:rpc:v1:request', {
        version: 1,
        requestId,
        method: 'status',
        source: { extension: 'eval-observer' }
      })
    }, 200)
  })
  pi.on('input', event => {
    const match = /\bS_[A-Z_]+\b/.exec(event.text)
    if (match) scenario = match[0]
    if (event.source === 'rpc' && event.text.startsWith('/pi-acp-control'))
      log({ event: 'control', sessionId, text: event.text })
  })
  pi.on('agent_start', () => log({ event: 'agent_start', sessionId, scenario }))
  pi.on('agent_settled', event => log({ event: 'agent_settled', sessionId, scenario, aborted: event.aborted }))
  pi.on('tool_result', event => {
    if (
      !['subagent', 'acp_detach', 'subagent_supervisor', 'contact_supervisor', 'read', 'bg_wait'].includes(
        event.toolName
      )
    )
      return
    log({
      event: 'tool_result',
      sessionId,
      scenario,
      toolName: event.toolName,
      input: event.input,
      details: event.details,
      content: event.content,
      isError: event.isError
    })
    // Synthetic negative metadata (public sendMessage): a notice without structured run IDs.
    if (scenario === 'S_UNSTRUCTURED' && event.toolName === 'subagent' && !event.isError)
      pi.sendMessage(
        { customType: 'subagent-notify', content: 'SYNTHETIC_UNSTRUCTURED_NOTICE', display: true },
        { triggerTurn: true }
      )
  })
  pi.on('message_start', event => {
    const message = event.message as { role: string; customType?: string; details?: unknown; content?: unknown }
    if (message.role === 'custom')
      log({
        event: 'custom',
        sessionId,
        scenario,
        customType: message.customType,
        details: message.details,
        content: typeof message.content === 'string' ? message.content.slice(0, 400) : undefined
      })
  })
  // Another extension's awaited settlement handler lets a native notice queue before the adapter runs.
  // Another extension's awaited settlement handler: with a queued notice it holds the
  // boundary open, proving consumption waits for every handler to return.
  pi.on('agent_before_settle', async event => {
    log({
      event: 'boundary',
      sessionId,
      scenario,
      pending: event.context.pendingMessages.length,
      canContinue: event.context.canContinue,
      continue: event.continue,
      entries: event.entries.map(entry => ('customType' in entry ? entry.customType : entry.type))
    })
    if (scenario !== 'S_ENTRY' || !event.context.pendingMessages.length) return
    const started = Date.now()
    while (Date.now() - started < 2_500) await sleep(20)
    scenario = 'S_ENTRY_DONE'
  })
  pi.registerCommand('eval-foreign', {
    description: 'Launch a foreign async run through the public v1 spawn RPC (never a tool_result)',
    handler: async () => {
      const requestId = crypto.randomUUID()
      const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, reply => {
        unsubscribe()
        log({ event: 'foreign-spawn', sessionId, reply })
      })
      pi.events.emit('subagents:rpc:v1:request', {
        version: 1,
        requestId,
        method: 'spawn',
        params: { agent: 'eval-leaf', task: 'LEAF_GATED:foreign', async: true, context: 'fresh' },
        source: { extension: 'eval-foreign' }
      })
    }
  })
  pi.registerProvider('stock-eval', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'no-network',
    api: 'stock-eval',
    models: [
      {
        id: 'local',
        name: 'Deterministic local',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000
      }
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream()
      const messages = context.messages as unknown as Message[]
      const first = textOf(messages.find(message => message.role === 'user'))
      const last = messages.at(-1)
      const lastText = textOf(last)
      const marker = /\b(S_[A-Z_]+|LEAF_[A-Z]+(?::[a-z0-9]+)?|ROOT_NESTED)\b/.exec(first)?.[1] ?? 'PLAIN'
      const question = messages.findLastIndex(message => textOf(message).includes('SUPERVISOR_QUESTION'))
      const unanswered =
        question >= 0 &&
        !messages
          .slice(question + 1)
          .some(
            message =>
              message.role === 'assistant' &&
              Array.isArray(message.content) &&
              message.content.some(part => part.type === 'toolCall' && part.name === 'subagent_supervisor')
          )
      const launches = messages.flatMap(message =>
        message.role === 'assistant' && Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'toolCall' && part.name === 'subagent')
          : []
      )
      const ids = [
        ...new Set(
          messages
            .filter(message => message.role === 'toolResult')
            .flatMap(message => [...textOf(message).matchAll(/Async: [\w-]+ \[([0-9a-f-]{36})\]/g)].map(m => m[1]!))
        )
      ]
      const probe = last?.role === 'user' && lastText.includes(WAITING)
      const notice = last?.role === 'user' && !probe && /Parent action:/.test(lastText)
      // normalizeContext folds the rendered system prompt into a leading system message.
      const systemText = textOf(messages.find(message => message.role === 'system'))
      const launch = (task: string, agent = 'eval-leaf') => ({
        type: 'toolCall',
        id: crypto.randomUUID(),
        name: 'subagent',
        arguments: { agent, task, async: true, context: 'fresh', mission: false }
      })
      const call = (name: string, args: object) => ({
        type: 'toolCall',
        id: crypto.randomUUID(),
        name,
        arguments: args
      })
      let content: object[] = [{ type: 'text', text: 'PLAIN_RESPONSE' }]
      let gate: string | undefined
      let delay = 10
      if (marker.startsWith('LEAF_ASK')) {
        // A real child asks its parent through the stock contact_supervisor tool, then keeps running.
        const [, name] = marker.split(':')
        if (last?.role !== 'toolResult')
          content = [call('contact_supervisor', { reason: 'need_decision', message: `SUPERVISOR_QUESTION:${name}` })]
        else {
          log({ event: 'leaf-answered', marker, reply: lastText.slice(0, 200) })
          gate = join(root, `release-${name}`)
          content = [{ type: 'text', text: `LEAF_DONE:${name}` }]
        }
      } else if (marker.startsWith('LEAF_')) {
        const [, name] = marker.split(':')
        if (marker.startsWith('LEAF_GATED')) gate = join(root, `release-${name}`)
        content = [{ type: 'text', text: `LEAF_DONE:${name}` }]
      } else if (marker === 'ROOT_NESTED')
        content = last?.role === 'toolResult' ? [{ type: 'text', text: 'ROOT_DONE' }] : [launch('LEAF_GATED:nested')]
      else if (marker === 'S_SUPERVISOR' && unanswered)
        content = [call('subagent_supervisor', { action: 'reply', message: 'SUPERVISOR_ANSWER' })]
      else if (marker === 'S_SUPERVISOR' && last?.role === 'toolResult' && launches.length)
        content = [
          {
            type: 'text',
            text: textOf(last).includes('Replied to supervisor') ? 'SUPERVISOR_REPLIED' : 'EARLY_YIELD:supervisor'
          }
        ]
      else if (probe && marker !== 'S_WORKFLOW') content = [{ type: 'text', text: 'WAITING_PROBE' }]
      else if (
        marker === 'S_EARLY' ||
        marker === 'S_LATE' ||
        marker === 'S_CANCEL' ||
        marker === 'S_ENTRY' ||
        marker === 'S_DEADLINE'
      ) {
        const name = marker.slice(2).toLowerCase()
        const synthesisDone = messages.some(
          message => message.role === 'assistant' && textOf(message).includes(`FINAL_SYNTHESIS:${name}`)
        )
        const resumeIssued = messages.some(
          message =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              part =>
                part.type === 'toolCall' && part.name === 'subagent' && part.arguments?.action?.trim() === 'resume'
            )
        )
        if (last?.role === 'user' && !notice && !probe && !launches.length)
          content = [
            launch(marker === 'S_EARLY' || marker === 'S_CANCEL' ? `LEAF_GATED:${name}` : `LEAF_QUICK:${name}`)
          ]
        else if (marker === 'S_EARLY' && last?.role === 'user' && !notice && !probe && synthesisDone && !resumeIssued)
          // The runner trims actions; a padded resume must still be captured.
          content = [call('subagent', { action: ' resume ', id: ids[0], message: 'Continue and finish the task.' })]
        else if (last?.role === 'user' && lastText.includes('Inspect subagent updates above'))
          // The stock's idle-parent wake prompt: the notice was appended without message_start
          // and the wake steers this text as the runnable input.
          content = [{ type: 'text', text: `WAKE_SYNTHESIS:${name}` }]
        else if (notice) content = [{ type: 'text', text: `FINAL_SYNTHESIS:${name}` }]
        else content = [{ type: 'text', text: `EARLY_YIELD:${name}` }]
      } else if (marker === 'S_SUPERVISOR') {
        content =
          last?.role === 'user' && !notice && !probe && !launches.length
            ? [launch('LEAF_ASK:supervisor')]
            : [{ type: 'text', text: notice ? 'FINAL_SYNTHESIS:supervisor' : 'EARLY_YIELD:supervisor' }]
      } else if (marker === 'S_PRECONSUMED') {
        const read = messages.some(
          message =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(part => part.type === 'toolCall' && part.name === 'read')
        )
        if (last?.role === 'user' && !notice && !probe && !launches.length) content = [launch('LEAF_QUICK:pre')]
        else if (notice) content = [{ type: 'text', text: 'FINAL_SYNTHESIS:pre' }]
        else if (!read) {
          // A slow in-run tool turn: the notice queues and is consumed before any boundary.
          content = [call('read', { path: join(root, 'agent', 'settings.json') })]
          delay = 8_000
        } else content = [{ type: 'text', text: 'PRE_YIELD' }]
      } else if (marker === 'S_WFEARLY') {
        if (last?.role === 'user' && !notice && !probe && !launches.length)
          content = [call('subagent', { workflow: './wfearly.js', async: true }), launch('LEAF_QUICK:companion')]
        else if (notice && lastText.includes('**workflow**'))
          content = [{ type: 'text', text: 'FINAL_SYNTHESIS:wfearly' }]
        else if (notice) content = [{ type: 'text', text: 'NOTICE_ACK:wfearly' }]
        else content = [{ type: 'text', text: 'EARLY_YIELD:wfearly' }]
      } else if (marker === 'S_WORKFLOW' || marker === 'S_WFCANCEL') {
        const name = marker.slice(2).toLowerCase()
        const waits = messages.filter(
          message =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(part => part.type === 'toolCall' && part.name === 'bg_wait')
        ).length
        const required = /required async runs ([0-9a-f-]{36})/.exec(lastText)?.[1]
        if (last?.role === 'user' && !notice && !probe && !launches.length)
          content = [call('subagent', { workflow: `./${name}.js`, async: true })]
        else if (notice && lastText.includes(`LEAF_DONE:${name}`))
          content = [{ type: 'text', text: `FINAL_SYNTHESIS:${name}` }]
        // Collection-only negatives: an early blocking bg_wait, then a post-terminal one; neither is a notice.
        else if (notice && name === 'workflow' && !waits)
          content = [call('bg_wait', { id: /child=([0-9a-f-]{36})/.exec(lastText)?.[1] })]
        else if (notice) content = [{ type: 'text', text: `WORKFLOW_ACK:${name}` }]
        else if (probe && name === 'workflow' && waits === 1 && required) content = [call('bg_wait', { id: required })]
        else if (probe) content = [{ type: 'text', text: 'WAITING_PROBE' }]
        else if (last?.role === 'toolResult' && waits) content = [{ type: 'text', text: `COLLECTED:${waits}` }]
        else content = [{ type: 'text', text: `EARLY_YIELD:${name}` }]
      } else if (marker === 'S_NESTED') {
        content =
          last?.role === 'user' && !notice && !probe && !launches.length
            ? [launch('ROOT_NESTED', 'eval-root')]
            : [{ type: 'text', text: notice ? 'FINAL_SYNTHESIS:nested' : 'NESTED_YIELD' }]
      } else if (marker === 'S_TWO') {
        if (last?.role === 'user' && !notice && !probe && !launches.length)
          content = [launch('LEAF_QUICK:twoa'), launch('LEAF_GATED:twob')]
        else
          content = [
            {
              type: 'text',
              text: notice ? `NOTICE_ACK:${(lastText.match(/LEAF_DONE:(\w+)/g) ?? []).join(',')}` : 'TWO_YIELD'
            }
          ]
      } else if (marker === 'S_CHAIN') {
        if (last?.role === 'user' && !notice && !probe && !launches.length) content = [launch('LEAF_QUICK:chaina')]
        else if (notice && launches.length === 1) content = [launch('LEAF_QUICK:chainb')]
        else if (notice) content = [{ type: 'text', text: 'FINAL_SYNTHESIS:chain' }]
        else content = [{ type: 'text', text: 'CHAIN_YIELD' }]
      } else if (marker === 'S_DETACH') {
        const detachCalls = messages.flatMap(message =>
          message.role === 'assistant' && Array.isArray(message.content)
            ? message.content.filter(part => part.type === 'toolCall' && part.name === 'acp_detach')
            : []
        )
        if (last?.role === 'user' && !notice && !probe && !launches.length) content = [launch('LEAF_GATED:detached')]
        // Pi's JSON-schema validation rejects the empty batch before execution, so that
        // attempt produces no extension tool_result event; sequence on issued calls.
        else if (last?.role === 'toolResult' && detachCalls.length === 0) content = [call('acp_detach', { runIds: [] })]
        else if (last?.role === 'toolResult' && detachCalls.length === 1)
          content = [call('acp_detach', { runIds: [ids[0], FOREIGN_ID] })]
        else if (last?.role === 'toolResult' && detachCalls.length === 2)
          content = [call('acp_detach', { runIds: [ids[0]] })]
        else content = [{ type: 'text', text: last?.role === 'toolResult' ? 'DETACHED_OK' : 'RESUMED_PLAIN' }]
      } else if (marker === 'S_UNSTRUCTURED') {
        content =
          last?.role === 'user' && !lastText.includes('SYNTHETIC') && !launches.length
            ? [launch('LEAF_GATED:unstructured')]
            : [{ type: 'text', text: 'UNSTRUCTURED_YIELD' }]
      }
      const toolUse = content.some(part => (part as Part).type === 'toolCall')
      log({
        event: 'provider',
        sessionId,
        marker,
        lastRole: last?.role,
        probe,
        notice,
        supervisorDraft: messages.some(
          message => textOf(message).includes(WAITING) && textOf(message).includes('pending supervisor request')
        ),
        unanswered,
        noticeText: notice ? lastText.slice(0, 600) : undefined,
        systemSentinel: systemText.includes('GLOBAL_APPEND_SENTINEL') ?? false,
        systemPolicy: systemText.includes('ACP completion policy (pi-acp)') ?? false,
        response: content.map(
          part =>
            (part as Part).text ??
            `${(part as Part).name}(${JSON.stringify((part as { arguments?: unknown }).arguments)})`
        )
      })
      const message = {
        role: 'assistant',
        content,
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
        stopReason: toolUse ? 'toolUse' : 'stop',
        timestamp: Date.now()
      }
      if (gate) log({ event: 'leaf-live', marker })
      const finish = () => {
        const aborted = options?.signal?.aborted
        if (gate) log({ event: 'leaf-settled', marker, aborted, gateReleased: existsSync(gate) })
        stream.push({ type: 'start', partial: message as never })
        if (aborted)
          stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } as never })
        else {
          content.forEach((part, contentIndex) => {
            if ((part as Part).type === 'toolCall')
              stream.push({ type: 'toolcall_end', contentIndex, toolCall: part as never, partial: message as never })
            else
              stream.push({ type: 'text_delta', contentIndex, delta: (part as Part).text!, partial: message as never })
          })
          stream.push({ type: 'done', reason: message.stopReason as never, message: message as never })
        }
        stream.end()
      }
      if (gate) {
        const started = Date.now()
        const timer = setInterval(() => {
          if (!options?.signal?.aborted && !existsSync(gate!) && Date.now() - started < 90_000) return
          clearInterval(timer)
          finish()
        }, 10)
      } else setTimeout(finish, delay)
      return stream
    }
  })
  pi.on('session_shutdown', () => {
    clearInterval(snapshotTimer)
    log({ event: 'session-shutdown', sessionId })
  })
}
