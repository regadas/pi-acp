import { randomUUID } from 'node:crypto'

// Public Pi extension surface only; Pi is supplied by the user's installation.
type Context = {
  mode?: string
  isIdle(): boolean
  hasPendingMessages(): boolean
  waitForIdle(): Promise<void>
  sessionManager: {
    getSessionId(): string
    getSessionFile(): string | undefined
    getBranch?(): Array<{ type?: string; customType?: string; details?: unknown }>
  }
  ui: { setWidget(key: string, lines: string[] | undefined): void }
}
type Provider = { name: string; sessionId: string; sessionFile?: string; isActive(): boolean }
type Draft = { type: string; [key: string]: unknown }
type HookEvent = {
  toolName?: string
  input?: Record<string, unknown>
  isError?: boolean
  details?: unknown
  source?: string
  text?: string
  prompt?: string
  images?: unknown[]
  systemPrompt?: string
  message?: { role?: string; content?: unknown; customType?: string; details?: unknown }
  outcome?: string
  entries?: Draft[]
  context?: { pendingMessages?: unknown[]; canContinue?: boolean }
}
type HookResult = { systemPrompt?: string; entries?: Draft[]; continue?: boolean } | undefined
type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown }
type Pi = {
  events: { on(name: string, handler: (data: unknown) => void): () => void; emit(name: string, data: unknown): void }
  on(name: string, handler: (event: HookEvent, ctx: Context) => HookResult | void | Promise<HookResult>): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: Context): Promise<void> }
  ): void
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: object
    execute(
      id: string,
      params: { runIds?: unknown },
      signal: unknown,
      onUpdate: unknown,
      ctx: Context
    ): Promise<ToolResult>
  }): void
}

export const ACP_LIFECYCLE_WIDGET = 'pi-acp-lifecycle'
const REGISTRY = Symbol.for('@agegr/pi-web/session-liveness/v1')
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const canonicalUuid = new RegExp(`^${UUID}$`)
type SnapshotNode = { id?: unknown; kind?: unknown; state?: unknown; children?: SnapshotNode[] }
type Snapshot = {
  kind?: unknown
  version?: unknown
  caps?: { maxStringLength?: unknown }
  omitted?: { runs?: unknown; children?: unknown; byteLimitExceeded?: unknown }
  runs?: SnapshotNode[]
}
type Obligation = {
  id: string
  observed: boolean
  terminalAt?: number
  // ACP waiting clock reading when terminal proof latched; the delivery window is metered from here.
  terminalHeld?: number
  delivered: boolean
  probes: number
  // git-main explicit async workflow child: its finished row folds back under the root as this keyed step.
  workflowKey?: string
}
// One supervisor request episode from owned work; the (requestId, runId) pair is its identity.
type Attention = { id: string; runId: string; openedHeld: number; delivered: boolean; probes: number }
type NoticeRun = { runId?: unknown; workflowRunId?: unknown; childRuns?: unknown }
type Capture = Obligation & {
  unsupported?: string
  attention: Map<string, Attention>
  // Live runs reported by completion notices under this root (stock promotes them to separate rows);
  // they owe their own delivery but are detached and cancelled only through the root.
  descendants: Map<string, Obligation>
}

const TERMINAL = new Set(['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'])
const STATES = new Set([...TERMINAL, 'queued', 'running'])
const CHILD_STATUSES = new Set(['running', 'completed', 'failed', 'paused', 'stopped', 'detached'])
const STATUS_POLL_MS = 1_000
const PROBE_INTERVAL_MS = 1_000
const MAX_PROBES = 30
const DELIVERY_DEADLINE_MS = 30_000
const STOP_INBOX_CLOSED = 'Runner stop inbox is closed. Retry stop after runner shutdown is observed.'
const NOTICE = 'subagent-notify'
// Stock native supervisor channel: a queued triggerTurn message, then this shared-bus event.
const SUPERVISOR_REQUEST = 'subagent_supervisor_request'
const SUPERVISOR_WAKE_EVENT = 'pi-intercom:detach-request'
const WAITING_TYPE = 'pi-acp-completion-wait'

function readSnapshot(status: Record<string, unknown>): Snapshot & { runs: SnapshotNode[] } {
  const snapshot = status.asyncSnapshot as Snapshot | undefined
  if (
    snapshot?.kind !== 'pi-subagents.async-status-snapshot' ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.runs)
  )
    throw new Error('Missing v1 async status snapshot')
  return snapshot as Snapshot & { runs: SnapshotNode[] }
}

// Every display row counts: a terminal root with any live or malformed row is not drained.
function subtreeState(node: SnapshotNode): 'terminal' | 'live' | string {
  const queue: unknown[] = [node]
  let live = false
  for (let count = 0; queue.length; count++) {
    if (count >= 256) return 'status subtree exceeds 256 rows'
    const item = queue.shift() as SnapshotNode | null
    if (!item || typeof item !== 'object' || !STATES.has(String(item.state))) return 'malformed status lineage'
    if (!TERMINAL.has(String(item.state))) live = true
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) return 'malformed status lineage'
      queue.push(...item.children)
    }
  }
  return live ? 'live' : 'terminal'
}

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
  let cancelling = false
  let admission: { id: string } | undefined
  let expectedInput: { text: string; hasImages: boolean } | undefined
  let foregroundRun = false
  let modelActive = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let scope: { sessionId: string; file: string | undefined } | undefined
  const required = new Map<string, Capture>()
  // Process-wide: whether each ID ever captured here has had a completion notice consumed.
  const history = new Map<string, boolean>()
  // Process-wide supervisor request IDs already opened or consumed; duplicates never reopen a budget.
  const supervisorRequests = new Set<string>()
  // Owner-scoped completion notices consumed before any exact captured lineage named their run: evidence only,
  // never ownership, polling, waiting, stop or detach authority. Cleared on every release.
  const candidates = new Map<string, { run: NoticeRun; seq: number }>()
  const supervisorKey = (requestId: string, runId: string) => JSON.stringify([requestId, runId])
  let failure: string | undefined
  let seq = 0
  let deliverySeq = 0
  let providerSeq = 0
  let lastProbeAt = -Infinity
  // Owner-scoped ACP waiting clock: advances only inside this owner's before-settle wait, because Pi
  // cannot drain queued native messages during provider, tool or other awaited-hook work.
  let clock: { spent: number; since?: number } = { spent: 0 }
  const held = () => clock.spent + (clock.since === undefined ? 0 : Date.now() - clock.since)
  let wakers: Array<() => void> = []
  let runGeneration = 0
  const interrupted = new Set<string>()
  let cancellationDiagnostic: string | undefined
  const emit = (
    state:
      | 'active'
      | 'idle'
      | 'error'
      | 'failed'
      | 'ready'
      | 'waiting'
      | 'withdrawn'
      | 'rejected'
      | 'stopping'
      | 'pending'
      | 'continuing'
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
  const inScope = (ctx: Context) =>
    scope !== undefined &&
    ctx.sessionManager.getSessionId() === scope.sessionId &&
    ctx.sessionManager.getSessionFile() === scope.file
  const wake = () => {
    const waiting = wakers
    wakers = []
    for (const resolve of waiting) resolve()
  }
  // Cancellation, owner replacement, detach and shutdown wake every barrier wait.
  const nap = (ms: number) =>
    new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        wakers = wakers.filter(waker => waker !== done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(1, ms))
      wakers.push(done)
    })
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }
  const settledCapture = (capture: Capture) =>
    capture.terminalAt !== undefined &&
    [...capture.descendants.values()].every(descendant => descendant.terminalAt !== undefined)
  const obligations = () => [...required.values()].flatMap(capture => [capture, ...capture.descendants.values()])
  const controlledIds = () => [...required.values()].flatMap(capture => [capture.id, ...capture.descendants.keys()])
  const lateDelivery = (obligation: Obligation) =>
    `completion notice for required run ${obligation.id} was not consumed within 30s of ACP waiting after terminal status`
  const lateAttention = (item: Attention) =>
    `supervisor request ${item.id} from required run ${item.runId} was not consumed within 30s of ACP waiting`
  const openAttention = () =>
    [...required.values()].flatMap(capture => [...capture.attention.values()]).filter(item => !item.delivered)
  const overdue = (spent: number) => {
    const expired = obligations().find(
      obligation =>
        obligation.terminalHeld !== undefined &&
        !obligation.delivered &&
        spent - obligation.terminalHeld >= DELIVERY_DEADLINE_MS
    )
    if (expired) return lateDelivery(expired)
    const asking = openAttention().find(item => spent - item.openedHeld >= DELIVERY_DEADLINE_MS)
    if (asking) return lateAttention(asking)
  }
  const assess = (capture: Capture, snapshot: Snapshot & { runs: SnapshotNode[] }, now: number) => {
    const omitted = snapshot.omitted
    // Stock v1 accounting: nonnegative safe-integer counters and Boolean byte-limit; anything else is not exhaustive.
    const counter = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
    const lossy =
      !counter(omitted?.runs) ||
      !counter(omitted?.children) ||
      typeof omitted?.byteLimitExceeded !== 'boolean' ||
      omitted.byteLimitExceeded
    const maxLength = snapshot.caps?.maxStringLength
    const find = (id: string) =>
      typeof maxLength === 'number' && id.length >= maxLength ? undefined : snapshot.runs.find(run => run?.id === id)
    const latch = (obligation: Obligation, row: SnapshotNode, label: string) => {
      obligation.observed = true
      const tree = subtreeState(row)
      if (tree !== 'terminal' && tree !== 'live') capture.unsupported ??= `${tree} for ${label} ${obligation.id}`
      else if (tree === 'terminal' && obligation.terminalAt === undefined) {
        if (lossy || (omitted.children as number) > 0)
          capture.unsupported ??= `bounded status cannot prove descendants of ${obligation.id} drained`
        else {
          obligation.terminalAt = now
          obligation.terminalHeld = held()
        }
      }
    }
    const node = find(capture.id)
    // A latched root may leave status by retention; its descendants are still assessed.
    if (node) latch(capture, node, 'required run')
    else if (capture.terminalAt === undefined) {
      if (lossy || (omitted.runs as number) > 0)
        capture.unsupported ??= `bounded status omitted required run ${capture.id}`
      else if (capture.observed || capture.delivered)
        capture.unsupported ??= `required run ${capture.id} left status before terminal proof`
      return
    }
    for (const [id, descendant] of capture.descendants) {
      if (descendant.terminalAt !== undefined) continue
      const row = find(id)
      // A finished workflow child folds back under its root as the uniquely keyed real step.
      const steps =
        !row && descendant.workflowKey !== undefined && node && Array.isArray(node.children)
          ? node.children.filter(child => child?.kind === 'step' && child.id === descendant.workflowKey)
          : []
      const step = steps[0] as (SnapshotNode & { startedAt?: unknown; endedAt?: unknown }) | undefined
      if (row) latch(descendant, row, 'descendant')
      else if (steps.length > 1) capture.unsupported ??= `workflow child key ${descendant.workflowKey} is ambiguous`
      else if (step && typeof step.startedAt === 'number' && typeof step.endedAt === 'number')
        latch(descendant, step, 'workflow child')
      else capture.unsupported ??= `descendant ${id} of required run ${capture.id} is not visible in status`
    }
  }
  // One shared poll per owner: a stale owner's reply, rejection or malformed data has no authority.
  let polling: { token: string | null; promise: Promise<void> } | undefined
  const poll = (): Promise<void> => {
    if (polling?.token === owner) return polling.promise
    const token = owner
    const captures = [...required.values()]
    const current = { token, promise: Promise.resolve() }
    polling = current
    current.promise = (async () => {
      try {
        const status = await rpc('status', Date.now() + 5_000)
        if (owner !== token) return
        const snapshot = readSnapshot(status)
        const now = Date.now()
        for (const capture of captures) if (required.get(capture.id) === capture) assess(capture, snapshot, now)
      } catch (error) {
        if (owner === token) throw error
      } finally {
        if (polling === current) polling = undefined
      }
    })()
    return current.promise
  }
  // Stock status drops completed records after 10 seconds; keep latching terminal proof between barriers.
  const startPolling = () => {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      if (![...required.values()].some(capture => !settledCapture(capture))) stopPolling()
      else void poll().catch(() => {})
    }, STATUS_POLL_MS)
    // Advisory latching only; Pi's own lifecycle keeps the process alive.
    pollTimer.unref?.()
  }
  const release = () => {
    required.clear()
    candidates.clear()
    failure = undefined
    stopPolling()
    wake()
  }
  const fail = (message: string): undefined => {
    release()
    emit('failed', message)
    return undefined
  }
  const waitingDraft = (runs: Obligation[], asking: Attention[]): Draft => ({
    type: 'custom_message',
    customType: WAITING_TYPE,
    display: false,
    content:
      `ACP is keeping this request open for required async runs ${[...new Set([...runs.map(c => c.id), ...asking.map(a => a.runId)])].join(', ')}` +
      (asking.length ? ` (pending supervisor request ${asking.map(a => a.id).join(', ')})` : '') +
      '. Completion notices and supervisor requests from these runs may appear before or after this message, or may already have been delivered; ' +
      'if one you have not yet acted on is present anywhere in the conversation, act on it now: answer supervisor requests within your existing authority and respond to completion results. ' +
      'Otherwise reply only with a brief waiting status; do not claim results or finish the task.'
  })
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
              {
                code: reply.success === false ? reply.error?.code : undefined,
                hostMessage: reply.success === false ? reply.error?.message : undefined
              }
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
        if (owner === id && required.size) {
          emit('rejected', 'Previous ACP background work has not drained', id)
          return
        }
        // A completed foreground's children remain autonomous. A new token
        // gets no stop authority over them, including restored live children.
        if (owner !== id) {
          release()
          foregroundRun = false
          expectedInput = undefined
          deliverySeq = providerSeq = 0
          lastProbeAt = -Infinity
          clock = { spent: 0 }
        }
        expectedInput = undefined
        owner = id
        scope = { sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }
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
      wake()
      try {
        const generation = runGeneration
        let terminal = true
        let exact = true
        if (required.size) {
          const status = await rpc('status', deadline)
          let snapshot: Snapshot & { runs: SnapshotNode[] }
          try {
            snapshot = readSnapshot(status)
          } catch {
            throw new Error('Missing v1 async status snapshot during cancellation')
          }
          if (operation === 'cancel') {
            // Proven promoted descendants are control roots too; ancestry below each is still verified.
            for (const root of controlledIds()) {
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
          const now = Date.now()
          for (const capture of required.values()) {
            assess(capture, snapshot, now)
            exact &&= !capture.unsupported && settledCapture(capture)
          }
          await Promise.all(
            controlledIds().map(async id => {
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
                const { code, hostMessage } = error as { code?: unknown; hostMessage?: unknown }
                // git-main 29284cd's generic-coded stop racing runner shutdown; any other execution_failed is fatal.
                const shutdownRace = code === 'execution_failed' && hostMessage === STOP_INBOX_CLOSED
                // The host also uses not_found for a session mismatch; never retry that rejection.
                if (
                  !(error instanceof Error) ||
                  /not found in the active session/.test(error.message) ||
                  (code !== 'not_found' && code !== 'invalid_state' && !shutdownRace)
                )
                  throw error
                if (shutdownRace) cancellationDiagnostic = error.message
              }
            })
          )
        }
        if (operation === 'cancel') {
          emit('stopping', cancellationDiagnostic)
          return
        }
        // Exact snapshot proof covers owned subtrees; idle aggregate liveness is a sound
        // fallback, while foreign or detached activity can never hold an exact proof.
        const live = currentProviders()
        const quiescent = exact || (terminal && live.length > 0 && !live.some(provider => provider.isActive()))
        if (generation !== runGeneration || !quiescent || !ctx.isIdle() || ctx.hasPendingMessages()) {
          emit('pending', cancellationDiagnostic)
          return
        }
        release()
        cancelling = false
        cancellationDiagnostic = undefined
        emit('cancelled')
      } catch (error) {
        stopPolling()
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
  const unsubscribeWake = pi.events.on(SUPERVISOR_WAKE_EVENT, raw => {
    const wakeEvent = raw as { requestId?: unknown; runId?: unknown } | undefined
    const requestId = wakeEvent?.requestId
    const runId = wakeEvent?.runId
    if (typeof requestId !== 'string' || !requestId || typeof runId !== 'string') return
    if (supervisorRequests.has(supervisorKey(requestId, runId))) return
    if (!owner || !foregroundRun || cancelling || !context || !inScope(context)) return
    const capture = required.get(runId) ?? [...required.values()].find(capture => capture.descendants.has(runId))
    if (!capture) return
    supervisorRequests.add(supervisorKey(requestId, runId))
    capture.attention.set(supervisorKey(requestId, runId), {
      id: requestId,
      runId,
      openedHeld: held(),
      delivered: false,
      probes: 0
    })
    wake()
  })
  // Applies one structured notice run to its exact owned obligation; `at` orders it against provider cycles.
  const consumeNotice = (run: NoticeRun, capture: Capture, at: number) => {
    const id = run.runId as string
    const obligation = capture.id === id ? capture : capture.descendants.get(id)!
    const workflow = capture.id === id && run.workflowRunId === id
    // Only the first consumption is checked or fenced; duplicates reopen nothing.
    if (!obligation.delivered) {
      if (obligation.terminalHeld !== undefined && held() - obligation.terminalHeld >= DELIVERY_DEADLINE_MS)
        capture.unsupported ??= lateDelivery(obligation)
      else {
        obligation.delivered = true
        deliverySeq = Math.max(deliverySeq, at)
      }
    }
    // Stock notify childStatus emits only these; absent is a no-child notice, anything malformed fails closed.
    const children = run.childRuns === undefined ? [] : run.childRuns
    if (
      !Array.isArray(children) ||
      children.some(child => !child || typeof child !== 'object' || !CHILD_STATUSES.has(child.status))
    ) {
      capture.unsupported ??= `required run ${id} reported malformed child run metadata`
      return
    }
    const live = (children as Array<Record<string, unknown>>).filter(
      child => child.status === 'running' || child.status === 'detached'
    )
    const keys = live.map(child => child.workflowKey)
    for (const child of live) {
      const childId = child.runId
      const key = child.workflowKey
      if (typeof childId !== 'string' || childId === 'unavailable')
        capture.unsupported ??= `required run ${id} reported an unidentified live descendant`
      else if (
        workflow &&
        (typeof key !== 'string' ||
          !key ||
          keys.filter(other => other === key).length > 1 ||
          live.filter(other => other.runId === childId).length > 1 ||
          [...required.values()].some(
            other => other.id === childId || (other !== capture && other.descendants.has(childId))
          ) ||
          (capture.descendants.has(childId) && capture.descendants.get(childId)!.workflowKey !== key) ||
          [...capture.descendants.values()].some(other => other.id !== childId && other.workflowKey === key))
      )
        capture.unsupported ??= `workflow child ${childId} of required run ${id} has no unique run/key mapping`
      else if (childId !== capture.id && !capture.descendants.has(childId)) {
        capture.descendants.set(childId, {
          id: childId,
          observed: false,
          delivered: false,
          probes: 0,
          ...(workflow ? { workflowKey: key as string } : {})
        })
        // Exact lineage now validates a notice this owner already consumed for that child.
        const early = candidates.get(childId)
        if (early) {
          candidates.delete(childId)
          consumeNotice(early.run, capture, early.seq)
        }
      }
    }
    if (capture.descendants.size) startPolling()
  }
  pi.on('message_start', (event, ctx) => {
    const message = event.message
    if (message?.role === 'custom' && message.customType === SUPERVISOR_REQUEST) {
      const details = message.details as { requestId?: unknown; runId?: unknown } | undefined
      const requestId = details?.requestId
      const runId = details?.runId
      // Only exactly attributed, in-scope consumption counts; anything else cannot close or suppress an episode.
      if (typeof requestId !== 'string' || typeof runId !== 'string' || !inScope(ctx)) return
      supervisorRequests.add(supervisorKey(requestId, runId))
      for (const capture of required.values()) {
        const item = capture.attention.get(supervisorKey(requestId, runId))
        if (!item || item.delivered) continue
        if (held() - item.openedHeld >= DELIVERY_DEADLINE_MS) capture.unsupported ??= lateAttention(item)
        else item.delivered = true
      }
      wake()
      return
    }
    if (message?.role === 'custom' && message.customType === NOTICE) {
      const runs = (message.details as { runs?: unknown } | undefined)?.runs
      const notices = Array.isArray(runs) ? (runs as NoticeRun[]) : undefined
      if (!notices || notices.some(run => typeof run?.runId !== 'string')) {
        if (required.size && owner && inScope(ctx))
          failure ??=
            'pi-subagents completion notice lacks structured run IDs; pi-subagents 0.77.0 or newer is required'
        return
      }
      for (const run of notices) {
        const id = run.runId as string
        if (history.has(id)) history.set(id, true)
        if (!inScope(ctx)) continue
        // Descendants match only under a root already captured here; unknown IDs are never adopted.
        const capture = required.get(id) ?? [...required.values()].find(capture => capture.descendants.has(id))
        if (capture) consumeNotice(run, capture, ++seq)
        else if (owner && foregroundRun && !candidates.has(id)) candidates.set(id, { run, seq: ++seq })
      }
      wake()
      return
    }
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
  pi.on('message_end', event => {
    if (foregroundRun && event.message?.role === 'assistant') providerSeq = ++seq
  })
  pi.on('agent_settled', () => {
    modelActive = false
    // A settlement the barrier did not release (rejected continuation, hard exit) is never success.
    if (owner && foregroundRun && !cancelling && required.size)
      fail('Pi settled before required ACP async work and its delivery completed')
  })
  pi.on('tool_result', (event, ctx) => {
    if (!owner || !foregroundRun || event.toolName !== 'subagent' || event.isError || !inScope(ctx)) return
    const details = event.details as
      | {
          asyncId?: unknown
          mode?: unknown
          steering?: { state?: unknown; sourceRunId?: unknown; replacementRunId?: unknown }
        }
      | undefined
    const rawAction = event.input?.action
    // The runner trims actions before dispatch.
    const action = typeof rawAction === 'string' ? rawAction.trim() : rawAction
    // Only launches and revivals create newly owned work; status/control results merely name IDs.
    // The stock's resume revives under a fresh run ID, so ambiguity proof is only owed when
    // this exact ID was already captured here and its notice has not been consumed.
    // Steering recovery revives a paused source as a fresh replacement; only that replacement is new work.
    const steering = details?.steering
    let id: unknown
    if (details?.mode === 'management') {
      if (action !== 'steer' || steering?.state !== 'recovered' || steering.replacementRunId === steering.sourceRunId)
        return
      id = steering.replacementRunId
    } else if (action !== undefined && action !== 'resume') return
    else id = details?.asyncId
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return
    context = ctx
    const capture: Capture = {
      id,
      observed: false,
      delivered: false,
      probes: 0,
      descendants: new Map(),
      attention: new Map()
    }
    if (history.has(id)) {
      const notified =
        history.get(id) === true ||
        (ctx.sessionManager.getBranch?.() ?? []).some(
          entry =>
            entry.type === 'custom_message' &&
            entry.customType === NOTICE &&
            JSON.stringify((entry.details as { runs?: unknown } | undefined)?.runs ?? []).includes(JSON.stringify(id))
        )
      if (!notified)
        capture.unsupported = `run ${id} was reused before its previous completion notice was consumed; delivery attribution is ambiguous`
    }
    history.set(id, false)
    required.set(id, capture)
    runGeneration++
    emit('active')
    startPolling()
    void poll().catch(() => {})
  })
  // Awaited before native settlement: hold while exact required work or its delivery is outstanding.
  pi.on('agent_before_settle', async (event, ctx) => {
    const token = owner
    if (!token || !foregroundRun || cancelling || event.outcome !== 'completed') return
    const stale = () => owner !== token || cancelling || !foregroundRun
    if (!inScope(ctx)) {
      release()
      return
    }
    const resume = (pending: Obligation[], asking: Attention[] = []): HookResult => {
      // Custom steers emit no queue_update, so the session layer correlates the
      // continuation's agent_start through this widget instead.
      emit('continuing')
      return event.context?.canContinue
        ? { continue: true }
        : { entries: [...(event.entries ?? []), waitingDraft(pending, asking)], continue: true }
    }
    // Finalizers touch only this owner's clock, so a stale wait cannot move a replacement owner's budget.
    const ownClock = clock
    ownClock.since = Date.now()
    try {
      // Entry-time preview only: queued notices remain invisible while this handler awaits.
      if (event.context?.pendingMessages?.length && required.size) {
        const expired = overdue(held())
        if (expired) return fail(expired)
        emit('continuing')
        return { continue: true }
      }
      for (;;) {
        if (stale()) return
        if (failure) return fail(failure)
        if (!required.size) return
        if ([...required.values()].some(capture => !settledCapture(capture))) {
          let error: unknown
          await Promise.race([poll().catch(e => (error = e)), nap(6_000)])
          if (stale()) return
          if (error) return fail(error instanceof Error ? error.message : String(error))
        }
        const captures = [...required.values()]
        const unsupported = captures.find(capture => capture.unsupported)
        if (unsupported) return fail(unsupported.unsupported!)
        const now = Date.now()
        const spent = held()
        const pending = obligations()
        const awaiting = pending.filter(obligation => obligation.terminalHeld !== undefined && !obligation.delivered)
        const asking = openAttention()
        const expired = overdue(spent)
        if (expired) return fail(expired)
        if (captures.every(settledCapture) && pending.every(obligation => obligation.delivered) && !asking.length) {
          // Ordering evidence only: a provider cycle after the last consumed notice, not proof of synthesis.
          if (deliverySeq > providerSeq) return resume(pending)
          release()
          emit('idle')
          return
        }
        const probeable = awaiting.filter(capture => capture.probes < MAX_PROBES)
        const probeableAsks = asking.filter(item => item.probes < MAX_PROBES)
        if ((probeable.length || probeableAsks.length) && now - lastProbeAt >= PROBE_INTERVAL_MS) {
          // shortcut: each probe may cost a provider call; a public queued-message signal can replace probing.
          lastProbeAt = now
          for (const item of [...probeable, ...probeableAsks]) item.probes++
          return resume(probeable, probeableAsks)
        }
        const deadlines = [
          ...awaiting.map(capture => capture.terminalHeld! + DELIVERY_DEADLINE_MS - spent),
          ...asking.map(item => item.openedHeld + DELIVERY_DEADLINE_MS - spent)
        ]
        if (probeable.length || probeableAsks.length) deadlines.push(lastProbeAt + PROBE_INTERVAL_MS - now)
        await nap(Math.min(STATUS_POLL_MS, ...deadlines))
      }
    } finally {
      ownClock.spent += Date.now() - ownClock.since!
      ownClock.since = undefined
    }
  })
  pi.registerTool({
    name: 'acp_detach',
    label: 'Detach ACP background runs',
    description:
      'Release exact async run IDs launched or revived for the current ACP request so it can finish while they continue in the background. ' +
      'Use only when the user explicitly asked for background or fire-and-forget work. Detached runs are not stopped, waited for, or cancelled by this request.',
    parameters: {
      type: 'object',
      properties: {
        runIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }
      },
      required: ['runIds'],
      additionalProperties: false
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ids = params?.runIds
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id))
        throw new Error('acp_detach requires a nonempty list of run IDs')
      if (new Set(ids).size !== ids.length) throw new Error('acp_detach run IDs must be unique')
      if (!owner || !foregroundRun || !inScope(ctx))
        throw new Error('acp_detach is only available to the active ACP request')
      // Validate the whole batch first: one foreign or stale ID detaches nothing.
      const rejected = (ids as string[]).filter(id => !required.has(id))
      if (rejected.length)
        throw new Error(`Not runs owned by the current ACP request: ${rejected.join(', ')}; nothing was detached`)
      for (const id of ids as string[]) required.delete(id)
      wake()
      return {
        content: [
          {
            type: 'text',
            text: `Detached ${ids.join(', ')}: they keep running in the background; this request no longer waits for or cancels them.`
          }
        ],
        details: { runIds: ids }
      }
    }
  })
  // Keep the token through native abort settlement; its final tool_result may arrive during abort.
  pi.on('session_shutdown', () => {
    release()
    unsubscribeWake()
    if (globals[REGISTRY] === registry) {
      if (previous === undefined) delete globals[REGISTRY]
      else globals[REGISTRY] = previous
    }
  })
}
