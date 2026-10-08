import { randomUUID } from 'node:crypto'

// Public Pi extension surface only; Pi is supplied by the user's installation.
type Context = {
  mode?: string
  isIdle(): boolean
  hasPendingMessages(): boolean
  waitForIdle(): Promise<void>
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined }
  ui: { setWidget(key: string, lines: string[] | undefined): void }
}
type Provider = { name: string; sessionId: string; sessionFile?: string; isActive(): boolean }
type Pi = {
  events: { on(name: string, handler: (data: unknown) => void): () => void; emit(name: string, data: unknown): void }
  on(
    name: string,
    handler: (
      event: {
        toolName?: string
        details?: unknown
        source?: string
        text?: string
        prompt?: string
        images?: unknown[]
        message?: { role?: string; content?: unknown }
      },
      ctx: Context
    ) => void
  ): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: Context): Promise<void> }
  ): void
}

export const ACP_LIFECYCLE_WIDGET = 'pi-acp-lifecycle'
const REGISTRY = Symbol.for('@agegr/pi-web/session-liveness/v1')
// ponytail: normal delivery polls at 50ms; host lifecycle events can replace polling.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const canonicalUuid = new RegExp(`^${UUID}$`)
type SnapshotNode = { id?: unknown; kind?: unknown; state?: unknown; children?: SnapshotNode[] }

// Stock 0.67.0 targeted status headers, not model prose. The bounded display
// snapshot supplies candidates only; raw canonical Parent/Root prove ancestry.
function nestedStatus(text: unknown, id: string): { parent: string; root: string; state: string } | undefined {
  if (typeof text !== 'string' || /[\p{Cc}\p{Cf}]/u.test(text.replaceAll('\n', ''))) return
  if (
    (text.match(/^[ ]*(?:Status target|Spawn budget|Active async capacity|Nested run|Root|Parent|State):/gm) ?? [])
      .length !== 7
  )
    return
  const headers = new RegExp(
    `^Status target: run ${id}\\n` +
      'Spawn budget: (?:unlimited|\\d+/\\d+ used, \\d+ remaining \\(configured \\d+; granted \\d+; grant allowance \\d+\\))\\n' +
      'Active async capacity: \\d+/(?:unlimited|\\d+) used\\n' +
      `Nested run: ${id}\\nRoot: (${UUID})\\nParent: (${UUID})(?: step [1-9]\\d*)?\\n` +
      'State: (queued|running|complete|failed|partial|paused|stopped|rejected)(?:\\n|$)'
  ).exec(text)
  if (headers) return { root: headers[1]!, parent: headers[2]!, state: headers[3]! }
}

/** Adapter-owned bridge to pi-subagents' optional v1 host liveness/stop contracts. */
export default function acpExtension(pi: Pi): void {
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[REGISTRY] as { version?: unknown; register?: (provider: Provider) => () => void } | undefined
  if (previous !== undefined && (previous.version !== 1 || typeof previous.register !== 'function'))
    throw new Error('Incompatible session-liveness host')
  const providers = new Set<Provider>()
  const registry = {
    version: 1,
    register(provider: Provider) {
      if (typeof provider.sessionId !== 'string' || typeof provider.isActive !== 'function') {
        throw new Error('Unsupported session-liveness provider')
      }
      const release = previous?.register?.(provider)
      if (provider.name === 'pi-subagents') providers.add(provider)
      return () => {
        providers.delete(provider)
        release?.()
      }
    }
  }
  globals[REGISTRY] = registry
  let owner: string | null = null
  let context: Context | null = null
  let active = false
  let cancelling = false
  let admission: { id: string } | undefined
  let expectedInput: { text: string; hasImages: boolean } | undefined
  let foregroundRun = false
  let modelActive = false
  let timer: ReturnType<typeof setInterval> | undefined
  const runs = new Set<string>()
  let runGeneration = 0
  const interrupted = new Set<string>()
  let observationError: string | undefined
  let cancellationDiagnostic: string | undefined
  const emit = (
    state:
      | 'active'
      | 'idle'
      | 'error'
      | 'ready'
      | 'waiting'
      | 'withdrawn'
      | 'rejected'
      | 'stopping'
      | 'pending'
      | 'cancelled',
    error?: string,
    token = owner
  ) => {
    context?.ui.setWidget(ACP_LIFECYCLE_WIDGET, [
      JSON.stringify({ version: 1, owner: token, state, ...(error ? { error } : {}) })
    ])
  }
  const currentProviders = () =>
    [...providers].filter(
      p =>
        p.sessionId === context?.sessionManager.getSessionId() &&
        (!p.sessionFile || p.sessionFile === context?.sessionManager.getSessionFile())
    )
  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const observe = () => {
    if (!owner || !context || !runs.size) return
    try {
      const live = currentProviders()
      if (!live.length) throw new Error('pi-subagents did not register v1 host liveness; update the optional extension')
      const busy = live.some(p => p.isActive())
      observationError = undefined
      if (busy && !active) {
        active = true
        emit('active')
      }
      if (active && !busy && context.isIdle() && !context.hasPendingMessages() && !cancelling) {
        active = false
        runs.clear()
        stopTimer()
        emit('idle')
      }
    } catch (error) {
      // Keep exact owned IDs and keep observing: a temporarily missing provider
      // may return. Never treat lost liveness as proof that work has drained.
      const message = error instanceof Error ? error.message : String(error)
      if (observationError !== message) emit('error', message)
      observationError = message
    }
  }
  const rpc = (method: 'stop' | 'status' | 'interrupt', deadline: number, id?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = randomUUID()
      const event = `subagents:rpc:v1:reply:${requestId}`
      const timeout = setTimeout(
        () => {
          unsubscribe()
          reject(new Error(`pi-subagents ${method} timed out${id ? ` for ${id}` : ''}`))
        },
        Math.max(1, Math.min(5_000, deadline - Date.now()))
      )
      const unsubscribe = pi.events.on(event, raw => {
        const reply = raw as {
          version?: unknown
          requestId?: unknown
          success?: unknown
          data?: { runId?: unknown; [key: string]: unknown }
          error?: { code?: unknown; message?: unknown }
        }
        if (reply?.version !== 1 || reply.requestId !== requestId) return
        clearTimeout(timeout)
        unsubscribe()
        if (reply.success === true && reply.data && (method !== 'stop' || reply.data.runId === id)) resolve(reply.data)
        else
          reject(
            Object.assign(
              new Error(
                `pi-subagents ${method} failed${id ? ` for ${id}` : ''}: ${String(reply.error?.message ?? 'invalid reply')}`
              ),
              { code: reply.success === false ? reply.error?.code : undefined }
            )
          )
      })
      pi.events.emit('subagents:rpc:v1:request', {
        version: 1,
        requestId,
        method,
        params: id ? { id } : {},
        source: { extension: 'pi-acp' }
      })
    })
  pi.registerCommand('pi-acp-control', {
    description: 'Internal ACP lifecycle bridge',
    async handler(args, ctx) {
      context = ctx
      const [operation, id, deadlineText] = args.split(' ')
      if (operation === 'withdraw' && id) {
        if (admission?.id === id) {
          admission = undefined
          expectedInput = undefined
        }
        emit('withdrawn', undefined, id)
        return
      }
      if (operation === 'begin' && id && /^[a-f0-9-]{36}$/.test(id)) {
        observe()
        if (owner === id && (active || runs.size)) {
          emit('rejected', 'Previous ACP background work has not drained', id)
          return
        }
        // A completed foreground's children remain autonomous. A new token
        // gets no stop authority over them, including restored live children.
        if (owner !== id) {
          stopTimer()
          runs.clear()
          active = false
          foregroundRun = false
          expectedInput = undefined
        }
        expectedInput = undefined
        owner = id
        cancelling = false
        interrupted.clear()
        cancellationDiagnostic = undefined
        const staged = admission ?? { id }
        admission = staged.id === id ? staged : { id }
        if (!modelActive && ctx.isIdle()) {
          foregroundRun = true
          emit('ready', undefined, id)
        } else {
          emit('waiting', undefined, id)
          const pending = admission
          void ctx.waitForIdle().then(
            () => {
              if (admission === pending && !modelActive && ctx.isIdle()) emit('ready', undefined, id)
            },
            error => {
              if (admission === pending) emit('error', String(error), id)
            }
          )
        }
        return
      }
      const deadline = Number(deadlineText)
      if (
        !['cancel', 'check'].includes(operation) ||
        id !== owner ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now()
      )
        throw new Error('Invalid ACP lifecycle owner or cancellation deadline')
      cancelling = true
      try {
        const generation = runGeneration
        let terminal = true
        if (runs.size) {
          const status = await rpc('status', deadline)
          const snapshot = status.asyncSnapshot as
            | { kind?: unknown; version?: unknown; caps?: { maxStringLength?: unknown }; runs?: SnapshotNode[] }
            | undefined
          if (
            snapshot?.kind !== 'pi-subagents.async-status-snapshot' ||
            snapshot.version !== 1 ||
            !Array.isArray(snapshot.runs)
          )
            throw new Error('Missing v1 async status snapshot during cancellation')
          if (operation === 'cancel') {
            for (const root of runs) {
              if (!canonicalUuid.test(root)) continue
              const node = snapshot.runs.find(node => node.id === root)
              if (!node) continue
              const candidates = new Set<string>()
              const queue = [...(Array.isArray(node.children) ? node.children : [])]
              // ponytail: 256 display nodes per root; an exhaustive typed host DTO can replace this ceiling.
              for (let count = 0; queue.length && count < 256; count++) {
                const child = queue.shift()!
                if (!child || typeof child !== 'object') continue
                if (
                  (child.kind === 'subagent' || child.kind === 'workflow') &&
                  typeof child.id === 'string' &&
                  canonicalUuid.test(child.id) &&
                  typeof snapshot.caps?.maxStringLength === 'number' &&
                  child.id.length < snapshot.caps.maxStringLength
                )
                  candidates.add(child.id)
                if (Array.isArray(child.children)) queue.push(...child.children)
              }
              if (queue.length) continue
              const statuses = new Map<string, { parent: string; root: string; state: string }>()
              await Promise.all(
                [...candidates].map(async id => {
                  try {
                    const status = await rpc('status', deadline, id)
                    const headers = nestedStatus(status.text, id)
                    if (headers && id !== root && headers.parent !== id) statuses.set(id, headers)
                  } catch (error) {
                    if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'execution_failed')
                      throw error
                    cancellationDiagnostic = error.message
                  }
                })
              )
              const verified = new Map<string, string>()
              for (let changed = true; changed; ) {
                changed = false
                for (const [id, status] of statuses) {
                  if (verified.has(id) || (status.parent !== root && verified.get(status.parent) !== status.root))
                    continue
                  verified.set(id, status.root)
                  changed = true
                }
              }
              await Promise.all(
                [...verified.keys()].map(async id => {
                  const state = statuses.get(id)!.state
                  if (interrupted.has(id) || (state !== 'running' && state !== 'queued')) return
                  try {
                    await rpc('interrupt', deadline, id)
                    interrupted.add(id)
                  } catch (error) {
                    if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'execution_failed')
                      throw error
                    cancellationDiagnostic = error.message
                  }
                })
              )
            }
          }
          // Snapshots are bounded: omission is unknown, never proof of termination.
          await Promise.all(
            [...runs].map(async id => {
              const run = snapshot.runs!.find(run => run.id === id)
              if (!run) {
                terminal = false
                return
              }
              if (['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'].includes(String(run.state))) return
              terminal = false
              if (run.state !== 'queued' && run.state !== 'running')
                throw new Error(`Invalid pi-subagents state for ${id}`)
              if (operation === 'check') return
              try {
                await rpc('stop', deadline, id)
              } catch (error) {
                const code = (error as { code?: unknown }).code
                // The host also uses not_found for a session mismatch; never retry that rejection.
                if (
                  !(error instanceof Error) ||
                  /not found in the active session/.test(error.message) ||
                  (code !== 'not_found' && code !== 'invalid_state')
                )
                  throw error
              }
            })
          )
        }
        if (operation === 'cancel') {
          emit('stopping', cancellationDiagnostic)
          return
        }
        const live = currentProviders()
        if (runs.size && !live.length) throw new Error('Missing pi-subagents liveness during cancellation')
        // Aggregate liveness is conservative proof for owned descendants only.
        // With no owned IDs, foreign children cannot hold native cancellation.
        if (
          generation !== runGeneration ||
          !terminal ||
          (runs.size > 0 && live.some(provider => provider.isActive())) ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages()
        ) {
          emit('pending', cancellationDiagnostic)
          return
        }
        runs.clear()
        active = false
        cancelling = false
        cancellationDiagnostic = undefined
        stopTimer()
        emit('cancelled')
      } catch (error) {
        stopTimer()
        emit('error', error instanceof Error ? error.message : String(error))
        throw error
      }
    }
  })
  pi.on('input', event => {
    expectedInput =
      event.source === 'rpc' && admission && typeof event.text === 'string'
        ? { text: event.text, hasImages: false }
        : undefined
  })
  pi.on('before_agent_start', event => {
    if (expectedInput !== undefined) {
      expectedInput =
        typeof event.prompt === 'string'
          ? { text: event.prompt, hasImages: Array.isArray(event.images) && event.images.length > 0 }
          : undefined
    }
  })
  pi.on('message_start', event => {
    const message = event.message
    if (!admission || expectedInput === undefined || message?.role !== 'user') return
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(part => part?.type === 'text')
              .map(part => part.text)
              .join('\n')
          : undefined
    // Native Pi appends normalization hints after before_agent_start, even
    // when all attached images fail processing. Text-only prefixes are foreign.
    if (text === expectedInput.text || (expectedInput.hasImages && text?.startsWith(`${expectedInput.text}\n\n`))) {
      foregroundRun = true
      expectedInput = undefined
      admission = undefined
    }
  })
  pi.on('agent_start', () => {
    if (!modelActive) foregroundRun = false
    modelActive = true
  })
  pi.on('agent_settled', () => {
    modelActive = false
  })
  pi.on('tool_result', (event, ctx) => {
    if (!owner || !foregroundRun || event.toolName !== 'subagent') return
    const details = event.details as { asyncId?: unknown } | undefined
    const id = details?.asyncId
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return
    context = ctx
    runs.add(id)
    runGeneration++
    if (!active) {
      active = true
      emit('active')
    }
    observe()
    // State polling samples the authoritative liveness callback, not a grace-period heuristic.
    timer ??= setInterval(observe, 50)
  })
  pi.on('agent_end', () => observe())
  // Keep the token through native abort settlement; its final tool_result may arrive during abort.
  pi.on('session_shutdown', () => {
    stopTimer()
    if (globals[REGISTRY] === registry) {
      if (previous === undefined) delete globals[REGISTRY]
      else globals[REGISTRY] = previous
    }
  })
}
