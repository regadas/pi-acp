import type {
  AuthMethod,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcRequestTimeoutError,
  PiRpcSpawnError,
  type PiRpcEvent,
  type PiRpcTermination
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
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

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AcpClient
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  /** Client negotiated Zed's `_meta.terminal_output` tool rendering convention. */
  supportsTerminalOutputMeta?: boolean
  /** Auth methods the owning agent advertised at initialize (for auth-required errors). */
  authMethods?: AuthMethod[]
}

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  completionStarted: boolean
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
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

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

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(
  toolName: string,
  args: unknown,
  cwd: string,
  line?: number
): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  let entry: ReturnType<typeof lstatSync>
  try {
    entry = lstatSync(resolvedPath)
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isMissing || toolName.toLowerCase() !== 'write') return undefined
    return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
  }

  if (entry.isSymbolicLink()) {
    try {
      entry = statSync(resolvedPath)
    } catch {
      return undefined
    }
  }

  if (!entry.isFile()) return undefined
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store: SessionStore
  private disposed = false

  /** The owning agent shares its store so both sides see one mapping. */
  constructor(store: SessionStore = new SessionStore()) {
    this.store = store
  }

  /**
   * Dispose all sessions and their underlying pi subprocesses and refuse any
   * later registration: an in-flight create/restore that finishes spawning
   * after teardown must dispose its fresh process instead of installing it.
   */
  disposeAll(): void {
    this.disposed = true
    for (const [id] of this.sessions) this.close(id)
  }

  isDisposed(): boolean {
    return this.disposed
  }

  private assertNotDisposed(proc?: PiRpcProcess): void {
    if (!this.disposed) return
    proc?.dispose()
    throw RequestError.internalError({}, 'pi-acp session manager is disposed')
  }

  /** Get a registered, usable session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session?.isUnavailable()) return session

    session.dispose()
    this.sessions.delete(sessionId)
    return undefined
  }

  /** Remove a session only if it is still the instance the caller observed. */
  evictIfCurrent(sessionId: string, expectedSession: PiAcpSession): boolean {
    if (this.sessions.get(sessionId) !== expectedSession) return false
    this.close(sessionId)
    return true
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.dispose()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    this.assertNotDisposed()

    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }
    this.assertNotDisposed(proc)

    // The ACP sessionId must be pi's authoritative persisted session identity;
    // fabricating one would return an ID that can never be found, listed, or
    // loaded again. Any failure past this point owns the spawned process.
    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch (e) {
      proc.dispose()
      throw maybeAuthRequiredError(e, params.authMethods) ?? toRequestError(e)
    }
    this.assertNotDisposed(proc)

    const sessionId = typeof state?.sessionId === 'string' && state.sessionId.trim() ? state.sessionId : null
    const sessionFile = typeof state?.sessionFile === 'string' && state.sessionFile.trim() ? state.sessionFile : null
    if (!sessionId || !sessionFile) {
      proc.dispose()
      throw RequestError.internalError(
        {},
        'pi did not report an authoritative sessionId/sessionFile for the new session'
      )
    }

    // pi creates its session directory lazily; ensure it exists up-front so
    // commands that read the session file (e.g. export_html) cannot fail on a
    // missing parent directory. Best-effort: pi itself creates it on write.
    try {
      mkdirSync(dirname(sessionFile), { recursive: true })
    } catch {
      // ignore
    }

    try {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    } catch (e) {
      proc.dispose()
      throw toRequestError(e)
    }

    let session: PiAcpSession
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        proc,
        conn: params.conn,
        fileCommands: params.fileCommands ?? [],
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods
      })
    } catch (error) {
      proc.dispose()
      throw error
    }

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const session = this.maybeGet(sessionId)
    if (!session) throw RequestError.resourceNotFound(sessionId)
    return session
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered. When a registered session wins the race,
   * the caller's freshly spawned losing process is disposed here so it can
   * never leak; after disposeAll the fresh process is disposed and the call
   * fails instead of registering.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    this.assertNotDisposed(params.proc)

    const existing = this.maybeGet(sessionId)
    if (existing) {
      if (existing.proc !== params.proc) params.proc.dispose()
      return existing
    }

    let session: PiAcpSession
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        proc: params.proc,
        conn: params.conn,
        fileCommands: params.fileCommands ?? [],
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods
      })
    } catch (error) {
      params.proc.dispose()
      throw error
    }

    this.sessions.set(sessionId, session)
    return session
  }
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
  // whether the current ACP turn observed an agent run at all (`agent_start`),
  // so prompts that pi handles without starting a run (e.g. extension
  // commands or input hooks) can complete without hanging.
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

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
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
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.supportsTerminalOutputMeta = opts.supportsTerminalOutputMeta ?? false
    this.authMethods = opts.authMethods ?? []

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

    try {
      // Abort the currently running turn (if any). If nothing is running, this is a no-op.
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
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.agentRunObserved = false
    this.lastDoneReason = null
    this.turnFailure = null

    const turn: PendingTurn = { resolve: t.resolve, reject: t.reject, completionStarted: false }
    this.pendingTurn = turn

    // Flush the deferred startup banner (pi version / context / skills) as the
    // first agent_message_chunk of this turn. ACP only allows turn-bound
    // updates while a `session/prompt` is active, so the banner must not be
    // emitted right after session/new (https://github.com/svkozak/pi-acp/issues/59).
    this.sendStartupInfoIfPending()

    // Custom messages can arrive while pi is idle. Defer them until a prompt
    // is active so their agent_message_chunks remain inside an ACP turn.
    this.sendPendingCustomMessages()

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
    this.proc
      .prompt(t.message, t.images)
      .then(() => this.handlePromptAccepted(turn))
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
   * Called when pi's `prompt` RPC request settles successfully. That response
   * is an acceptance response, not an execution result: if an agent run was
   * (or is being) started, keep the ACP turn open until `agent_settled`.
   * Otherwise the prompt was handled without an agent run and no further
   * lifecycle events will arrive, so probe pi's state and complete the turn
   * instead of hanging forever.
   */
  private handlePromptAccepted(turn: PendingTurn): void {
    if (this.pendingTurn !== turn || turn.completionStarted || this.agentRunObserved) return

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
        const forwardedTurnActive = Boolean(this.pendingTurn && !this.pendingTurn.completionStarted)

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
        this.agentRunObserved = true
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
        // turn. Do NOT resolve the ACP `session/prompt` here; wait for
        // `agent_settled`.
        break
      }

      case 'agent_settled': {
        // pi has fully settled this prompt: no automatic retry, compaction
        // retry, or queued continuation remains. This is the safe boundary to
        // resolve (or fail) the ACP `session/prompt`.
        const turn = this.pendingTurn
        if (!turn) break
        if (this.turnFailure && !this.cancelRequested) {
          this.failTurn(turn, this.turnFailure)
        } else {
          this.completeTurn(turn)
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

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function toRequestError(err: unknown): RequestError {
  if (err instanceof RequestError) return err
  const message = err instanceof Error ? err.message : String(err)
  return RequestError.internalError({}, message)
}

function terminationError(termination: PiRpcTermination): Error {
  const base =
    termination.reason === 'error'
      ? `pi process failed: ${termination.error instanceof Error ? termination.error.message : String(termination.error)}`
      : `pi process exited unexpectedly (code=${termination.code}, signal=${termination.signal})`
  const tail = termination.stderrTail.trim()
  return new Error(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base)
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

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
