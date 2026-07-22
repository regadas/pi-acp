import type {
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation
} from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcRequestTimeoutError, type PiRpcEvent, type PiRpcTermination } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { terminationError, toRequestError } from './session-errors.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOrderedContent,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { translateCustomMessageContent, type TranslatedUserBlock } from './translate/pi-messages.js'
import { toolResultImageBlocks, toolResultToolCallContent } from './translate/pi-tools.js'
import {
  findUniqueLineNumber,
  getEditOldTexts,
  getToolPath,
  toToolCallLocations,
  toToolKind
} from './translate/tool-calls.js'

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  completionStarted: boolean
  // Transport and lifecycle ownership are separate: a written prompt can be
  // queued behind an unobserved autonomous run. Only the synchronous success
  // response boundary can move dispatched -> accepted, and queued prompts do
  // not own turn-bound events until their user message enters pi's run.
  promptDispatched: boolean
  promptAccepted: boolean
  piRunOwned: boolean
  promptQueued: boolean
  expectedPromptText: string
  matchingPromptMessagesToSkip: number
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PendingCustomMessage = {
  blocks: TranslatedUserBlock[]
  identity: string
  sequence: number
}

type PermissionResponse = Awaited<ReturnType<AcpClient['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const PI_TURN_BOUND_EVENT_TYPES = new Set([
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'auto_retry_start',
  'auto_retry_end',
  'auto_compaction_start',
  'auto_compaction_end',
  'compaction_start',
  'compaction_end'
])
// An observed out-of-band run should always emit agent_settled. Keep the wait
// finite so a lost event cannot hang ACP forever, but fail closed rather than
// dispatching into a run whose lifecycle this turn does not own.
const DEFERRED_ADMISSION_TIMEOUT_MS = 10 * 60_000
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

/**
 * Stable counted identity for a custom message across live events and
 * persisted `custom_message` tree entries. Timestamps are deliberately
 * excluded: pi stamps live `CustomMessage`s with a numeric epoch but persists
 * an ISO string, so any timestamp-based identity would never reconcile.
 * Repeated identical messages stay distinguishable by count, not identity.
 */
function customMessageIdentity(message: unknown, blocks: TranslatedUserBlock[]): string {
  const record = message as { customType?: unknown; details?: unknown } | null | undefined

  let detailsIdentity: string
  try {
    detailsIdentity = JSON.stringify(record?.details ?? null)
  } catch {
    detailsIdentity = 'unserializable'
  }

  return JSON.stringify([
    typeof record?.customType === 'string' ? record.customType : null,
    blocks.map(block => (block.kind === 'text' ? ['text', block.text] : ['image', block.mimeType, block.data])),
    detailsIdentity
  ])
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false
  private activeAdapterPromptTurns = 0
  private customMessageSequence = 0
  private readonly pendingCustomMessages: PendingCustomMessage[] = []

  readonly proc: PiRpcProcess
  private readonly conn: AcpClient
  private readonly fileCommands: FileSlashCommand[]
  // Fabricated terminal references and terminal_* metadata are a negotiated
  // Zed convention; never expose them to a client that did not opt in.
  private readonly supportsTerminalOutputMeta: boolean
  // Auth methods the owning agent advertised at initialize; auth-required
  // errors raised from this session must advertise exactly these.
  private readonly authMethods: AuthMethod[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user
  // prompt: `turn_end` closes one assistant/tool exchange, and `agent_end`
  // closes one low-level agent run, after which pi (>= 0.80.4) may continue
  // with automatic retries, compaction retries, and queued continuations.
  // Only `agent_settled` marks the fully settled prompt. This flag tracks
  // whether the current ACP turn claimed execution via its `agent_start` or,
  // for a queued follow-up inside an existing run, its user `message_start`.
  // Prompts handled without either boundary (e.g. extension commands or input
  // hooks) can then complete without hanging.
  private agentRunObserved = false

  // Stop-reason tracking for the current turn. `lastDoneReason` records the
  // most recent assistantMessageEvent `done` reason ('length' maps to ACP
  // max_tokens); `turnFailure` records a run failure that must fail the ACP
  // turn once pi settles (agent_settled stays the sole settlement boundary).
  private lastDoneReason: string | null = null
  private turnFailure: Error | null = null

  // Set once when the pi child terminates; used to fail (or cancel) any
  // accepted turn deterministically instead of waiting for agent_settled.
  private procTermination: PiRpcTermination | null = null

  // pi can run autonomously with no ACP-owned turn (e.g. an extension calling
  // sendMessage with triggerTurn). `agent_start` with no owned ACP turn raises
  // this gate; only an unambiguous `agent_settled` clears it (a get_state
  // isStreaming=false snapshot is not authoritative: pi flips the flag before
  // emitting agent_settled). While raised, an admitted turn defers its raw
  // prompt dispatch instead of racing pi's busy check.
  private piBusyOutOfBand = false
  // Pi's low-level agent can restart inside one AgentSession run for retries,
  // compaction, or messages queued by agent_end hooks. A restart without one
  // of those observable precursors is an uncorrelatable nested top-level run;
  // fail closed rather than consuming its settlement as the current boundary.
  private lowLevelAgentEnded = false
  private piQueueHasMessages = false
  private continuationExpected = false
  private lifecycleAmbiguity: Error | null = null
  private deferredDispatch: { turn: PendingTurn; message: string; images: unknown[] } | null = null
  private deferredAdmissionTimer: NodeJS.Timeout | null = null
  private readonly deferredAdmissionTimeoutMs: number

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private subagentToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  // Settlement trackers for every turn-based `session/prompt` (in-flight and
  // queued). Agent-level tracking also covers adapter-handled prompt paths.
  private readonly outstandingTurns = new Set<Promise<void>>()
  private closing = false
  private shutdownPromise: Promise<void> | null = null
  private readonly unsubscribe: () => void
  private disposed = false
  private disposalExpected = false

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AcpClient
    fileCommands?: FileSlashCommand[]
    supportsTerminalOutputMeta?: boolean
    authMethods?: AuthMethod[]
    /** Test seam: maximum wait for an observed out-of-band run to settle. */
    deferredAdmissionTimeoutMs?: number
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.supportsTerminalOutputMeta = opts.supportsTerminalOutputMeta ?? false
    this.authMethods = opts.authMethods ?? []
    this.deferredAdmissionTimeoutMs = opts.deferredAdmissionTimeoutMs ?? DEFERRED_ADMISSION_TIMEOUT_MS

    this.unsubscribe = this.proc.onEvent(ev => this.handlePiEvent(ev))
    // Intentionally never unsubscribed: onTermination fires at most once and
    // is the only path that settles an accepted turn when the child dies
    // mid-run (including a teardown that races an in-flight prompt).
    this.proc.onTermination(termination => this.handleProcessTermination(termination))
  }

  private handleProcessTermination(termination: PiRpcTermination): void {
    this.procTermination = termination
    const turn = this.pendingTurn
    if (!turn || turn.completionStarted) return

    // Adapter-driven teardown (dispose/close) settles as a cancellation, not
    // as an internal error surfaced to the client. Fault quarantine explicitly
    // opts out so disposal cannot reclassify the fault as cancellation.
    if (termination.expected || this.closing || this.disposalExpected) this.cancelRequested = true
    this.failTurn(turn, terminationError(termination))
  }

  dispose(options?: { expected?: boolean }): void {
    if (this.disposed) return
    this.disposed = true
    this.disposalExpected = options?.expected ?? true
    // A held dispatch must never fire into a disposed channel.
    this.clearDeferredDispatch()
    try {
      this.unsubscribe()
    } finally {
      this.proc.dispose({ expected: this.disposalExpected })
    }
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Emit the deferred startup info as an `agent_message_chunk`, if not yet
   * sent. Must be called while a `session/prompt` turn is active (i.e. from
   * `startTurn`): ACP forbids turn-bound updates outside an active prompt
   * (https://github.com/svkozak/pi-acp/issues/59).
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  beginAdapterPromptTurn(): () => Promise<void> {
    this.activeAdapterPromptTurns += 1
    this.sendStartupInfoIfPending()
    this.sendPendingCustomMessages()

    let active = true
    return async () => {
      if (!active) return
      active = false

      // Close the scope synchronously before capturing the update chain so
      // later custom messages are deferred instead of escaping after response.
      this.activeAdapterPromptTurns -= 1
      await this.flushEmits()
    }
  }

  currentCustomMessageSequence(): number {
    return this.customMessageSequence
  }

  reconcileLoadedCustomMessages(messages: unknown[], throughSequence: number): void {
    const replayedByIdentity = new Map<string, number>()
    for (const message of messages) {
      const record = message as { role?: unknown; display?: unknown; content?: unknown } | null | undefined
      if (record?.role !== 'custom' || record.display !== true) continue

      const blocks = translateCustomMessageContent(record.content)
      if (!blocks.length) continue

      const identity = customMessageIdentity(message, blocks)
      replayedByIdentity.set(identity, (replayedByIdentity.get(identity) ?? 0) + 1)
    }

    const reconciledSequences = new Set<number>()
    const reconcile = (pendingMessages: PendingCustomMessage[]) => {
      for (const message of pendingMessages) {
        const remaining = replayedByIdentity.get(message.identity) ?? 0
        if (remaining === 0) continue

        replayedByIdentity.set(message.identity, remaining - 1)
        reconciledSequences.add(message.sequence)
      }
    }

    // Only events observed up to the get_tree response boundary may be
    // reconciled. An identical event arriving after the boundary is a
    // genuinely new message (the snapshot cannot contain it), and counted
    // identity cannot tell it apart from an older snapshot occurrence, so it
    // must stay queued. Tradeoff: an event pi persisted just before the
    // boundary but delivered just after it is replayed once and shown once
    // more on the next prompt (rare duplicate) instead of ever being dropped.
    reconcile(this.pendingCustomMessages.filter(message => message.sequence <= throughSequence))

    const retained = this.pendingCustomMessages.filter(message => !reconciledSequences.has(message.sequence))
    this.pendingCustomMessages.splice(0, this.pendingCustomMessages.length, ...retained)
  }

  private sendPendingCustomMessages(): void {
    const messages = this.pendingCustomMessages.splice(0)
    for (const message of messages) {
      this.emitCustomMessageBlocks(message.blocks)
    }
  }

  private emitCustomMessageBlocks(blocks: TranslatedUserBlock[]): void {
    for (const block of blocks) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: (block.kind === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'image', data: block.data, mimeType: block.mimeType }) satisfies ContentBlock
      })
    }
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // Once shutdown starts, no new work may be admitted to this subprocess.
    if (this.isClosing()) return 'cancelled'

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    const tracked = turnPromise.then(
      () => undefined,
      () => undefined
    )
    this.outstandingTurns.add(tracked)
    void tracked.then(() => this.outstandingTurns.delete(tracked))

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    const queued = this.turnQueue.splice(0, this.turnQueue.length)
    if (queued.length) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    const activeTurn = this.pendingTurn
    if (activeTurn && !activeTurn.promptDispatched) {
      // Nothing of this turn ever reached pi: the active run (if any) is
      // out-of-band work this session does not own, so aborting pi would
      // interrupt unrelated work. Settle locally with zero sends.
      this.clearDeferredDispatch()
      this.completeTurn(activeTurn)
      await this.flushEmits()
      for (const queuedTurn of queued) queuedTurn.resolve('cancelled')
      return
    }

    if (!activeTurn || activeTurn.completionStarted) {
      // There is no live ACP-owned turn to abort. In particular, a completing
      // turn remains installed only while updates flush; autonomous work that
      // starts in that window must not be interrupted by a late cancellation.
      if (queued.length) {
        await this.flushEmits()
        for (const queuedTurn of queued) queuedTurn.resolve('cancelled')
      }
      return
    }

    try {
      await this.proc.abort()
    } catch {
      // If abort cannot be acknowledged, pi may still be generating output.
      // Quarantine and terminate the channel, then settle locally rather than
      // leaving session/prompt pending indefinitely.
      this.dispose()
      const turn = this.pendingTurn
      if (turn) this.completeTurn(turn)
    } finally {
      // A queued prompt response must not overtake the updates that explain
      // why the queue was cleared, even when abort itself fails.
      if (queued.length) {
        await this.flushEmits()
        for (const turn of queued) turn.resolve('cancelled')
      }
    }
  }

  /**
   * Cancel all in-flight and queued turn work and wait for it to settle with
   * `cancelled` after final updates flush. Agent-level lifecycle tracking waits
   * adapter-handled prompts after this turn shutdown and process disposal.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      // Close admission before runShutdown reaches its first async boundary.
      this.closing = true
      this.shutdownPromise = this.runShutdown()
    }
    return this.shutdownPromise
  }

  private async runShutdown(): Promise<void> {
    this.cancelRequested = true

    // Drop any held dispatch before the first await so its admission timeout
    // cannot race shutdown settlement.
    this.clearDeferredDispatch()

    // Drain the queue synchronously so nothing already queued can start while
    // abort is in flight, but settle those requests only after final updates.
    const queued = this.turnQueue.splice(0, this.turnQueue.length)

    try {
      await this.proc.abort()
    } catch {
      // The subprocess may already be gone; shutdown must still settle turns.
    }

    const turn = this.pendingTurn
    if (turn) this.completeTurn(turn)

    // completeTurn resolves the active request only after this update chain.
    // Resolve drained queue entries afterward, then it is safe to await the
    // complete outstanding-turn set without deadlocking on those entries.
    await this.flushEmits()
    for (const queuedTurn of queued) queuedTurn.resolve('cancelled')

    await Promise.all([...this.outstandingTurns])
    await this.flushEmits()
  }

  private enqueueUpdate(update: SessionUpdate): Promise<void> {
    const delivery = this.lastEmit.then(() =>
      this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    )

    this.lastEmit = delivery.catch(() => {
      // Ignore notification errors (client may have gone away). We still want
      // prompt completion and later notifications to proceed.
    })
    return delivery
  }

  private emit(update: SessionUpdate): void {
    void this.enqueueUpdate(update)
  }

  sendSessionUpdate(params: Parameters<AcpClient['sessionUpdate']>[0]): Promise<void> {
    if (params.sessionId !== this.sessionId) {
      return Promise.reject(new Error(`session update mismatch: ${params.sessionId}`))
    }
    return this.enqueueUpdate(params.update)
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    const includeTerminal = params.includeTerminal && this.supportsTerminalOutputMeta
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    if (!this.supportsTerminalOutputMeta) {
      // Generic clients get the full accumulated output as ordered standard
      // content — text fenced in place, images kept in source order — and
      // tool_call_update content replaces earlier content, so the snapshot
      // stays consistent while streaming.
      const content = bashOrderedContent(params.result)
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: params.toolCallId,
        status: params.status,
        ...(content.length ? { content } : {})
      })
      return
    }

    const text = bashResultText(params.result)
    // Binary image blocks cannot travel through text-only terminal output;
    // they are preserved as standard image content beside the terminal ref.
    const imageContent: ToolCallContent[] = toolResultImageBlocks(params.result).map(image => ({
      type: 'content',
      content: { type: 'image', data: image.data, mimeType: image.mimeType }
    }))

    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      ...(imageContent.length ? { content: [...bashTerminalContent(params.toolCallId), ...imageContent] } : {}),
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.subagentToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.agentRunObserved = false
    this.lastDoneReason = null
    this.turnFailure = null

    const turn: PendingTurn = {
      resolve: t.resolve,
      reject: t.reject,
      completionStarted: false,
      promptDispatched: false,
      promptAccepted: false,
      piRunOwned: false,
      promptQueued: false,
      expectedPromptText: t.message,
      matchingPromptMessagesToSkip: 0
    }
    this.pendingTurn = turn

    // Flush the deferred startup banner (pi version / context / skills) as the
    // first agent_message_chunk of this turn. ACP only allows turn-bound
    // updates while a `session/prompt` is active, so the banner must not be
    // emitted right after session/new (https://github.com/svkozak/pi-acp/issues/59).
    this.sendStartupInfoIfPending()

    // Custom messages can arrive while pi is idle. Flush them now on the
    // normal idle path. If an out-of-band run owns the Pi event stream, keep
    // them buffered until dispatch so its content does not leak into this turn.
    if (!this.piBusyOutOfBand) this.sendPendingCustomMessages()

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi. The RPC `prompt` response only means the prompt was
    // accepted, queued, or handled — execution events continue streaming
    // asynchronously — so turn completion is driven by pi lifecycle events:
    // - `agent_settled` marks the fully settled prompt (after automatic
    //   retries, compaction retries, and queued continuations) and completes
    //   the turn (see handlePiEvent).
    // - An accepted prompt that never starts an agent run (e.g. handled
    //   immediately by an extension command or input hook) emits no agent
    //   events at all; handlePromptAccepted detects that and completes the
    //   turn so the ACP request does not hang.
    // While pi is observably busy with an out-of-band run, the raw prompt is
    // held (the ACP turn stays admitted) and dispatched only after that run's
    // authoritative settlement. A finite timeout fails closed.
    this.dispatchOrDefer(turn, t.message, t.images)
  }

  private dispatchOrDefer(turn: PendingTurn, message: string, images: unknown[]): void {
    if (this.pendingTurn !== turn || turn.completionStarted) return

    // A dead channel never defers: dispatching fails fast through the normal
    // prompt rejection path instead of parking the turn behind a run that can
    // no longer settle.
    if (this.piBusyOutOfBand && !this.procTermination) {
      this.deferredDispatch = { turn, message, images }
      const timer = setTimeout(() => {
        if (this.deferredAdmissionTimer === timer) this.deferredAdmissionTimer = null
        if (this.deferredDispatch?.turn !== turn) return

        this.deferredDispatch = null
        const error = new Error('Timed out waiting for out-of-band pi work to settle before dispatching the prompt.')
        // The child lifecycle can no longer be correlated safely. Quarantine
        // it and reject every admitted/queued turn without sending the prompt.
        this.dispose({ expected: false })
        this.failTurn(turn, error)
      }, this.deferredAdmissionTimeoutMs)
      timer.unref?.()
      this.deferredAdmissionTimer = timer
      return
    }

    this.dispatchPrompt(turn, message, images)
  }

  private dispatchPrompt(turn: PendingTurn, message: string, images: unknown[]): void {
    if (this.pendingTurn !== turn || turn.completionStarted) return

    // Custom messages that arrived during deferral were buffered because the
    // Pi run was not owned by this ACP turn. Flush them now, still inside the
    // open request and before its raw prompt is written.
    this.sendPendingCustomMessages()

    // Foreign run events observed while this turn was deferred can overwrite
    // the turn-scoped observation/result state that startTurn reset (a
    // foreign `done: 'length'` would map to max_tokens; a foreign provisional
    // retry failure would fail this turn at its own settlement). Re-reset
    // that state synchronously at dispatch so only events from this point on
    // shape the result. `cancelRequested` is intentionally preserved: a
    // client cancel issued while deferred must still resolve `cancelled`.
    this.agentRunObserved = false
    this.lastDoneReason = null
    this.turnFailure = null

    // Mark only the transport write here. A foreign agent_start may already be
    // buffered ahead of pi's response, so raw dispatch cannot establish event
    // ownership. PiRpcProcess invokes this callback synchronously on the
    // successful response record, before later records in the same chunk.
    turn.promptDispatched = true
    const markAccepted = () => {
      if (this.pendingTurn !== turn || turn.completionStarted || turn.promptAccepted) return
      turn.promptAccepted = true
      // With no observed run and no pre-response follow-up queue update, pi
      // took its idle path. It writes success immediately before starting
      // this prompt without yielding, so ownership is safe at this boundary.
      if (!this.piBusyOutOfBand && !turn.promptQueued && !this.lifecycleAmbiguity) {
        turn.piRunOwned = true
        this.sendPendingCustomMessages()
      }
    }
    this.proc
      .prompt(message, images, markAccepted)
      .then(() => {
        // Compatibility for test doubles and older embedders that implement
        // prompt() but ignore the optional synchronous acceptance callback.
        markAccepted()
        this.handlePromptAccepted(turn)
      })
      .catch(err => {
        if (err instanceof PiRpcRequestTimeoutError && err.command === 'prompt') {
          // PiRpcProcess already quarantined the channel. Unsubscribe session
          // event handling immediately and mark this session unavailable so a
          // later request restores a fresh subprocess instead of reusing it.
          this.dispose({ expected: false })
        }
        this.failTurn(turn, err)
      })
  }

  /**
   * Drop the held dispatch payload and its admission timer. `deferredDispatch`
   * always refers to the current pending turn, so every settlement path
   * (complete, fail, cancel, shutdown, disposal, process termination) clears
   * it unconditionally and no late timeout can send or settle it twice.
   */
  private clearDeferredDispatch(): void {
    this.deferredDispatch = null
    if (this.deferredAdmissionTimer) {
      clearTimeout(this.deferredAdmissionTimer)
      this.deferredAdmissionTimer = null
    }
  }

  /**
   * Called when pi's `prompt` RPC request settles successfully. That response
   * is an acceptance response, not an execution result: if an agent run was
   * (or is being) started, keep the ACP turn open until `agent_settled`.
   * Otherwise the prompt was handled without an agent run and no further
   * lifecycle events will arrive, so probe pi's state and complete the turn
   * instead of hanging forever.
   */
  private handlePromptAccepted(turn: PendingTurn): void {
    if (this.pendingTurn !== turn || turn.completionStarted || !turn.promptAccepted || this.agentRunObserved) return

    void this.proc.getState().then(
      state => {
        if (this.pendingTurn !== turn || turn.completionStarted || this.agentRunObserved) return
        const isStreaming = Boolean((state as { isStreaming?: unknown } | null | undefined)?.isStreaming)
        // pi sets `isStreaming` synchronously before its agent run starts and
        // writes RPC output in order: when a run is active, its `agent_start`
        // line precedes this get_state response, so agentRunObserved would
        // already be true. isStreaming=false with no observed run means the
        // prompt was handled without an agent run.
        if (!isStreaming) this.completeTurn(turn)
      },
      err => {
        // Without a successful idle-state probe, pi may still start the accepted
        // prompt later. Quarantine it before settlement so no late output can
        // escape into a closed or replacement ACP turn.
        if (this.pendingTurn !== turn || turn.completionStarted || this.agentRunObserved) return
        const failure = this.procTermination ? terminationError(this.procTermination) : err
        this.dispose({ expected: false })
        this.failTurn(turn, failure)
      }
    )
  }

  /**
   * Resolve the ACP `session/prompt` at a safe boundary: claim the pending
   * turn synchronously (making completion idempotent across the
   * `agent_settled` and no-agent-run paths), flush every queued
   * `session/update` so turn-bound notifications are delivered in-turn,
   * resolve, and only then start the next queued adapter prompt.
   */
  private completeTurn(turn: PendingTurn): void {
    if (this.pendingTurn !== turn || turn.completionStarted) return
    turn.completionStarted = true
    this.clearDeferredDispatch()
    const reason: StopReason = this.cancelRequested
      ? 'cancelled'
      : this.lastDoneReason === 'length'
        ? 'max_tokens'
        : 'end_turn'

    void this.flushEmits().finally(() => {
      // Keep the completing turn installed until its updates have flushed. New
      // prompts must remain queued behind it; clearing pendingTurn earlier lets
      // a newcomer start and then get overwritten by startNextQueuedTurn().
      this.pendingTurn = null
      turn.resolve(reason)
      this.startNextQueuedTurn()
    })
  }

  private failTurn(turn: PendingTurn, err: unknown): void {
    if (this.pendingTurn !== turn || turn.completionStarted) return
    turn.completionStarted = true
    this.clearDeferredDispatch()

    // Keep the failed turn installed while its existing updates flush so any
    // concurrent prompts queue rather than leapfrog it. Once that first flush
    // completes, JS run-to-completion makes the queue drain + pendingTurn clear
    // atomic with respect to new prompt requests.
    void this.flushEmits().finally(() => {
      const cancelled = this.cancelRequested
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      this.pendingTurn = null

      // Queue notifications may have been appended while the first flush was
      // blocked. Capture and flush them after closing the queue, before settling
      // either the failed request or any drained queued requests.
      void this.flushEmits().finally(() => {
        if (cancelled) {
          // ACP cancellation semantics dominate all underlying failures,
          // including auth-looking stderr from a process being torn down.
          turn.resolve('cancelled')
          for (const queuedTurn of queued) queuedTurn.resolve('cancelled')
        } else {
          const authErr = maybeAuthRequiredError(err, this.authMethods)
          if (authErr) {
            turn.reject(authErr)
            for (const queuedTurn of queued) queuedTurn.reject(authErr)
          } else {
            // Non-auth, non-cancel failures must reject the ACP request rather
            // than masquerade as a successful end_turn.
            const rpcError = toRequestError(err)
            turn.reject(rpcError)
            for (const queuedTurn of queued) queuedTurn.reject(rpcError)
          }
        }

        // Do not auto-run drained prompts: pi may be unhealthy. A genuinely
        // new prompt can start after the atomic queue close above; in that case
        // its own running metadata is authoritative and must not be overwritten.
        if (!this.pendingTurn) {
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: 0, running: false } }
          })
        }
      })
    })
  }

  isUnavailable(): boolean {
    return this.disposed || this.procTermination !== null
  }

  private isClosing(): boolean {
    return this.closing || this.disposed
  }

  private startNextQueuedTurn(): void {
    if (this.isClosing()) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      if (queued.length) {
        void this.flushEmits().finally(() => {
          for (const turn of queued) turn.resolve('cancelled')
        })
      }
      return
    }

    const next = this.turnQueue.shift()
    if (next) {
      // The queued turn's own `session/prompt` request is still in flight, so
      // this chunk is delivered in-turn for that prompt.
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')
    const turn = this.pendingTurn

    // A streaming prompt queues its expanded text before pi writes the prompt
    // success response. Preserve that text as the only available correlation
    // boundary for the follow-up's later user message.
    if (type === 'queue_update') {
      const steering = Array.isArray(ev.steering) ? ev.steering : []
      const followUp = Array.isArray(ev.followUp) ? ev.followUp : []
      this.piQueueHasMessages = steering.length > 0 || followUp.length > 0

      if (turn?.promptDispatched && !turn.promptAccepted && !turn.completionStarted) {
        const queuedText = followUp.at(-1)
        if (typeof queuedText === 'string') {
          turn.promptQueued = true
          turn.expectedPromptText = queuedText
          // Pi removes equal queue strings with indexOf. Existing identical
          // follow-ups ahead of ours must remain foreign until their FIFO
          // message_start records have been skipped.
          turn.matchingPromptMessagesToSkip = followUp.slice(0, -1).filter(item => item === queuedText).length
        }
      }
      // Pi invokes agent_end extension handlers before publishing agent_end,
      // so their queue_update can precede our low-level end flag. Retain the
      // queue state and also cover messages queued just after the visible end.
      if (this.lowLevelAgentEnded && this.piQueueHasMessages) this.continuationExpected = true
    }

    if (type === 'auto_retry_start' || type === 'auto_compaction_start' || type === 'compaction_start') {
      // These events are explicit Pi promises that another low-level start
      // belongs to the same AgentSession run. Some supported versions emit the
      // marker before their corresponding agent_end, so do not key it on the
      // local end flag.
      this.continuationExpected = true
    }
    if (
      (type === 'compaction_end' || type === 'auto_compaction_end') &&
      (ev as { willRetry?: unknown }).willRetry !== true
    ) {
      this.continuationExpected = false
    }

    // A follow-up queued behind unobserved autonomous work stays in the same
    // low-level run and emits no new agent_start. Its user message is therefore
    // the first protocol record that can establish ownership.
    if (
      type === 'message_start' &&
      turn?.promptAccepted &&
      !turn.piRunOwned &&
      !turn.completionStarted &&
      !this.lifecycleAmbiguity &&
      piUserMessageText(ev) === turn.expectedPromptText
    ) {
      if (turn.matchingPromptMessagesToSkip > 0) {
        turn.matchingPromptMessagesToSkip -= 1
      } else {
        turn.piRunOwned = true
        this.agentRunObserved = true
        this.sendPendingCustomMessages()
      }
    }

    const ownsPiTurn = Boolean(
      turn &&
      !turn.completionStarted &&
      !this.lifecycleAmbiguity &&
      (turn.piRunOwned || (turn.promptDispatched && !turn.promptAccepted && !this.piBusyOutOfBand))
    )

    // Pi extensions may run autonomously. Until an accepted prompt owns pi's
    // run, turn-bound output must not escape, mutate its result, or race a turn
    // already completing. Preserve the legacy translator test seam for
    // isolated events with no observed lifecycle; real pi emits agent_start.
    const suppressUnownedPiOutput =
      !ownsPiTurn &&
      (this.piBusyOutOfBand ||
        Boolean(turn?.promptDispatched) ||
        Boolean(turn?.completionStarted) ||
        Boolean(this.lifecycleAmbiguity))
    if (PI_TURN_BOUND_EVENT_TYPES.has(type) && suppressUnownedPiOutput) return

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            if (toolName === 'subagent') this.subagentToolCallIds.add(toolCallId)
            if (ame.type === 'toolcall_delta' && this.subagentToolCallIds.has(toolCallId)) break

            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations =
              ame.type === 'toolcall_delta' ? undefined : toToolCallLocations(toolName, rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        if (ame?.type === 'done') {
          const reason = typeof ame.reason === 'string' ? ame.reason : null
          // A known successful completion supersedes a provisional error from
          // an attempt that pi recovered via retry or compaction. Unknown future
          // reasons must not accidentally erase a real failure.
          if (reason === 'stop' || reason === 'length' || reason === 'toolUse') {
            this.turnFailure = null
          }
          // Only the latest message boundary counts: a mid-turn 'length' stop
          // followed by a continued run that ends with 'stop' is not truncation.
          this.lastDoneReason = reason
          break
        }

        if (ame?.type === 'error') {
          const reason = typeof ame.reason === 'string' ? ame.reason : 'error'
          const errorMessage = (ame as { error?: { errorMessage?: unknown } })?.error?.errorMessage
          const detail = typeof errorMessage === 'string' && errorMessage ? `: ${errorMessage}` : ''
          if (reason === 'aborted') {
            // Only a client-driven cancellation may map an abort to the ACP
            // `cancelled` stop reason; anything else is a failed turn.
            if (!this.cancelRequested) {
              this.turnFailure ??= new Error(`pi aborted the run unexpectedly${detail}`)
            }
          } else {
            this.turnFailure ??= new Error(`pi run failed${detail}`)
          }
          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'message_end': {
        const message = (ev as any).message
        if (message?.role !== 'custom' || message.display !== true) break

        const blocks = translateCustomMessageContent(message.content)
        if (!blocks.length) break

        const pendingMessage: PendingCustomMessage = {
          blocks,
          identity: customMessageIdentity(message, blocks),
          sequence: ++this.customMessageSequence
        }
        const activeTurn = this.pendingTurn
        const forwardedTurnActive = Boolean(
          activeTurn &&
          !activeTurn.completionStarted &&
          !this.lifecycleAmbiguity &&
          (activeTurn.piRunOwned ||
            (activeTurn.promptDispatched && !activeTurn.promptAccepted && !this.piBusyOutOfBand))
        )

        if (forwardedTurnActive || this.activeAdapterPromptTurns > 0) {
          this.emitCustomMessageBlocks(blocks)
        } else {
          this.pendingCustomMessages.push(pendingMessage)
        }
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (toolName === 'subagent') this.subagentToolCallIds.add(toolCallId)

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(toolName, args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(toolName, args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }
        if (this.subagentToolCallIds.has(toolCallId)) break

        const content = this.fileMutationToolCallIds.has(toolCallId) ? [] : toolResultToolCallContent(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: content.length ? content : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const orderedContent = toolResultToolCallContent(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  // ACP Diff requires an absolute path; pi may report a
                  // cwd-relative one.
                  type: 'diff',
                  path: abs,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (content) {
          // The structured diff replaces the tool's text summary; binary image
          // blocks are still preserved after it.
          const images = orderedContent.filter(item => item.type === 'content' && item.content.type === 'image')
          if (images.length) content = [...content, ...images]
        } else if (orderedContent.length) {
          content = orderedContent
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        if ((ev as { success?: unknown }).success === false) {
          const finalError = stringProp(ev, 'finalError')
          const text = finalError ? `Automatic retry failed: ${finalError}` : 'Automatic retry failed.'
          this.turnFailure = new Error(text)
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text } satisfies ContentBlock
          })
          break
        }

        this.turnFailure = null
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      // Legacy event names kept for compatibility with older pi versions.
      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        const activeTurn = this.pendingTurn
        const initialOwnedStart = Boolean(
          activeTurn?.piRunOwned && !activeTurn.completionStarted && !this.agentRunObserved
        )
        const ownedContinuation = Boolean(
          activeTurn?.piRunOwned && !activeTurn.completionStarted && this.continuationExpected
        )

        if (initialOwnedStart || ownedContinuation) {
          // Idle accepted prompts own their first start. Pi may later restart
          // the low-level agent for an explicitly signalled retry/compaction
          // continuation without ending the AgentSession run.
          this.agentRunObserved = true
          this.continuationExpected = false
        } else if (this.piBusyOutOfBand && this.continuationExpected) {
          // Equivalent continuation inside autonomous work: keep one busy gate
          // because AgentSession emits only one final agent_settled.
          this.continuationExpected = false
        } else if (this.piBusyOutOfBand || (activeTurn?.piRunOwned && !activeTurn.completionStarted)) {
          // A second start without a retry/compaction/queued-continuation
          // precursor can be a nested top-level run from an agent_settled hook.
          // Its later settlement cannot be correlated with the older run.
          this.lifecycleAmbiguity ??= new Error(
            'Pi started an uncorrelatable nested run before the current run settled.'
          )
          this.piBusyOutOfBand = true
          this.continuationExpected = false
        } else {
          // pi started work no accepted ACP turn owns (e.g. an extension
          // sendMessage with triggerTurn, including a start buffered ahead of
          // this prompt's success response). Raise the admission gate.
          this.piBusyOutOfBand = true
          this.continuationExpected = false
        }

        this.lowLevelAgentEnded = false
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here.
        break
      }

      case 'agent_end': {
        // Low-level agent run boundary. pi may continue after this event with
        // automatic retries, compaction retries, and queued continuations,
        // and their thought/tool updates must stay inside the active ACP
        // turn. Their precursor events mark the next agent_start as expected.
        // Do NOT resolve here; wait for AgentSession's agent_settled.
        this.lowLevelAgentEnded = true
        if (this.piQueueHasMessages || (ev as { willRetry?: unknown }).willRetry === true) {
          this.continuationExpected = true
        }
        break
      }

      case 'agent_settled': {
        const ambiguity = this.lifecycleAmbiguity
        if (ambiguity) {
          // Nested AgentSession runs can produce a newer settlement before an
          // older outer settlement. With no run IDs, neither boundary is safe
          // to consume. Quarantine even when no turn is pending so a prompt
          // cannot race the remaining stale settlement.
          this.dispose({ expected: false })
          const ambiguousTurn = this.pendingTurn
          if (ambiguousTurn && !ambiguousTurn.completionStarted) this.failTurn(ambiguousTurn, ambiguity)
          break
        }

        // Whatever unambiguous run was active has now reached its sole
        // authoritative AgentSession boundary.
        this.piBusyOutOfBand = false
        this.lowLevelAgentEnded = false
        this.piQueueHasMessages = false
        this.continuationExpected = false
        const activeTurn = this.pendingTurn
        if (!activeTurn) break

        if (!activeTurn.promptDispatched) {
          // Settlement of a run this ACP turn does not own. It is purely the
          // admission signal for the held dispatch: send exactly once and
          // keep the turn open for its own lifecycle.
          const deferred = this.deferredDispatch
          if (deferred?.turn === activeTurn) {
            this.clearDeferredDispatch()
            this.dispatchPrompt(activeTurn, deferred.message, deferred.images)
          }
          break
        }

        // A settlement buffered before pi's prompt response cannot settle the
        // new turn. The response callback will establish idle ownership or a
        // later matching user message will establish queued ownership.
        if (!activeTurn.promptAccepted) break

        if (!activeTurn.piRunOwned) {
          const error = new Error('Pi settled before the accepted prompt could be correlated with its run.')
          this.dispose({ expected: false })
          this.failTurn(activeTurn, error)
          break
        }

        // pi has fully settled this prompt: no automatic retry, compaction
        // retry, or queued continuation remains. This is the safe boundary to
        // resolve (or fail) the ACP `session/prompt`.
        if (this.turnFailure && !this.cancelRequested) {
          this.failTurn(activeTurn, this.turnFailure)
        } else {
          this.completeTurn(activeTurn)
        }
        break
      }

      case 'compaction_start': {
        const reason = stringProp(ev, 'reason')
        const label =
          reason === 'overflow'
            ? 'Context overflow; compacting to recover...'
            : reason === 'threshold'
              ? 'Context nearing limit; compacting...'
              : 'Compacting context...'
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: label } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end': {
        const errorMessage = stringProp(ev, 'errorMessage')
        const aborted = (ev as { aborted?: unknown }).aborted === true
        const text = errorMessage
          ? `Compaction failed: ${errorMessage}`
          : aborted
            ? 'Compaction aborted.'
            : 'Compaction finished; context was summarized to continue the session.'
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text } satisfies ContentBlock
        })
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    const activeTurn = this.pendingTurn
    const belongsToPrompt = Boolean(
      activeTurn &&
      !activeTurn.completionStarted &&
      !this.lifecycleAmbiguity &&
      (activeTurn.piRunOwned || (activeTurn.promptDispatched && !this.piBusyOutOfBand))
    )
    if (!belongsToPrompt && (this.piBusyOutOfBand || Boolean(activeTurn) || Boolean(this.lifecycleAmbiguity))) {
      // ACP permission requests and visible UI updates are turn-bound. An
      // observed autonomous extension run has no client request to attach
      // them to, so unblock pi by cancelling without contacting the client.
      // The no-lifecycle branch remains as a translator-test seam.
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function piUserMessageText(ev: PiRpcEvent): string | null {
  const message = ev.message as { role?: unknown; content?: unknown } | null | undefined
  if (message?.role !== 'user') return null
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return null

  const text = message.content
    .filter((part): part is { type: 'text'; text: string } => {
      if (!part || typeof part !== 'object') return false
      const record = part as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string'
    })
    .map(part => part.text)
    .join('\n')
  // Empty text is meaningful for image-only prompts: Pi always queues a text
  // block alongside the images, and the empty string is their correlation key.
  return text
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}
