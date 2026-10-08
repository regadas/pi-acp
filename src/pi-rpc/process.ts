import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPiInvocation, getPiCommand } from './command.js'
import { LfLineDecoder } from './line-decoder.js'
import { assertSupportedPiVersion, PiVersionError } from './version.js'
import {
  decodePiRecord,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiThinkingLevel
} from './protocol.js'
export type { PiRpcEvent, PiThinkingLevel } from './protocol.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    this.cause = opts?.cause
  }
}

function piExecutableNotFoundError(cmd: string, cause?: unknown): PiRpcSpawnError {
  return new PiRpcSpawnError(
    `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
    { code: 'ENOENT', cause }
  )
}

export class PiRpcRequestTimeoutError extends Error {
  readonly command: string
  readonly timeoutMs: number

  constructor(command: string, timeoutMs: number) {
    super(`pi ${command} timed out after ${timeoutMs}ms: no RPC response from the pi subprocess.`)
    this.name = 'PiRpcRequestTimeoutError'
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

/** A healthy foreign model run won admission; no user input was queued. */
export class PiRpcPromptDeferredError extends Error {}

export class PiRpcClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiRpcClosedError'
  }
}

/** Terminal state of the pi child process, reported at most once. */
export type PiRpcTermination = {
  reason: 'exit' | 'error'
  code: number | null
  signal: NodeJS.Signals | null
  /** True when the adapter itself requested disposal before termination. */
  expected: boolean
  error?: unknown
  /** Bounded tail of the child's stderr output for diagnostics. */
  stderrTail: string
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const ABORT_TIMEOUT_MS = 10_000
// Prompt preflight may run extension hooks and overflow compaction before pi
// sends its acceptance response, so give it the same bounded budget as an
// explicit compaction rather than the short control-command default.
const PROMPT_TIMEOUT_MS = 10 * 60_000
const COMPACT_TIMEOUT_MS = 10 * 60_000
// get_entries serializes the complete flat session history and export_html
// renders the whole session; both scale with history size, so give them a
// larger (still finite) budget than short control commands.
const GET_ENTRIES_TIMEOUT_MS = 2 * 60_000
const EXPORT_TIMEOUT_MS = 2 * 60_000
const KILL_GRACE_MS = 2_000
// If stdio never closes after exit (e.g. an orphaned grandchild holds the
// pipe), force termination settlement so accepted prompts cannot hang.
const CLOSE_FALLBACK_MS = 1_000
const STDERR_TAIL_LIMIT = 8 * 1024

type PiRpcProcessOptions = {
  requestTimeoutMs?: number
  killGraceMs?: number
  closeFallbackMs?: number
  maxStdoutRecordBytes?: number
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

type SpawnParams = {
  cwd: string
  sessionDirectory?: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Cancels the version preflight before the RPC child is spawned. */
  signal?: AbortSignal
  /**
   * Called synchronously with the wrapper as soon as the OS child exists,
   * which is before this spawn resolves. Owners take responsibility for
   * terminating the child here so a teardown racing the spawn cannot miss it.
   * A throwing hook fails the spawn with the child disposed, never leaving it
   * alive and unowned.
   */
  onProcess?: (proc: PiRpcProcess) => void
}

type PendingEntry = {
  resolve: (v: PiRpcResponse) => void
  reject: (e: unknown) => void
  beforeResolve?: (response: PiRpcResponse) => void
  timer?: NodeJS.Timeout
  admission: boolean
  remainingMs?: number
  timerStartedAt?: number
  onTimeout?: () => void
}

type StagedPrompt = { owner: string; withdrawn: boolean; begin?: Promise<boolean> }

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingEntry>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private terminationHandlers: Array<(t: PiRpcTermination) => void> = []
  private readonly requestTimeoutMs?: number
  private readonly killGraceMs: number
  private readonly closeFallbackMs: number
  private stderrTailBuf = ''
  private termination: PiRpcTermination | null = null
  private disposeRequested = false
  private disposeIsExpected = false
  private killTimer: NodeJS.Timeout | undefined
  private exitFallbackTimer: NodeJS.Timeout | undefined
  private nativeUnsettled = false

  private constructor(child: ChildProcessWithoutNullStreams, opts?: PiRpcProcessOptions) {
    this.child = child
    this.requestTimeoutMs = opts?.requestTimeoutMs
    this.killGraceMs = opts?.killGraceMs ?? KILL_GRACE_MS
    this.closeFallbackMs = opts?.closeFallbackMs ?? CLOSE_FALLBACK_MS

    const decoder = new LfLineDecoder(opts?.maxStdoutRecordBytes)
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) this.handleStdoutLine(line)
      } catch {
        // An unterminated framing flood makes the channel unusable. Dispose as
        // an unexpected fault; subsequent bytes/events are ignored.
        this.dispose({ expected: false })
      }
    })
    child.stdout.on('end', () => {
      try {
        const rest = decoder.end()
        if (rest !== null) this.handleStdoutLine(rest)
      } catch {
        this.dispose({ expected: false })
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTailBuf = (this.stderrTailBuf + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT)
    })

    child.on('error', err => {
      // A failed kill can emit error while the child still owns its session file.
      // Even after exit, close must drain stdout before releasing ownership.
      if (child.pid === undefined) {
        this.settleTermination({
          reason: 'error',
          code: null,
          signal: null,
          error: err
        })
      }
    })
    child.on('exit', (code, signal) => {
      // Prefer settling on 'close' so stdout data already buffered in the pipe
      // is dispatched to event handlers first; the fallback timer guards
      // against stdio that never closes.
      const timer = setTimeout(() => this.settleTermination({ reason: 'exit', code, signal }), this.closeFallbackMs)
      this.exitFallbackTimer = timer
    })
    child.on('close', (code, signal) => {
      this.settleTermination({ reason: 'exit', code, signal })
    })
  }

  /**
   * Wrap an already-spawned pi RPC child process.
   * Test seam: production code must go through {@link PiRpcProcess.spawn}.
   */
  static fromChild(child: ChildProcessWithoutNullStreams, opts?: PiRpcProcessOptions): PiRpcProcess {
    return new PiRpcProcess(child, opts)
  }

  private handleStdoutLine(line: string): void {
    // Once the channel is quarantined or terminal, no record can safely be
    // attributed to an ACP turn. An orphaned descendant may still hold and
    // write to stdout after the pi child exits.
    if (this.disposeRequested || this.termination || !line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      // Ignore human-readable startup output and malformed records without
      // letting either break later NDJSON events.
      return
    }

    const decoded = decodePiRecord(msg)
    if (!decoded) return
    if (decoded.type === 'response' && 'command' in decoded && 'success' in decoded) {
      // Responses are correlation records, never pi events. A response whose
      // request already timed out is stale and must not reach session event
      // handlers or a later turn.
      if (typeof decoded.id !== 'string') return
      const entry = this.takePending(decoded.id)
      if (!entry) return
      const response = decoded as PiRpcResponse
      try {
        entry.beforeResolve?.(response)
        entry.resolve(response)
      } catch (error) {
        entry.reject(error)
      }
      return
    }

    if (decoded.type === 'agent_start' || decoded.type === 'agent_settled') {
      this.nativeUnsettled = decoded.type === 'agent_start'
      for (const entry of this.pending.values()) {
        if (!entry.admission) continue
        if (this.nativeUnsettled && entry.timer) {
          clearTimeout(entry.timer)
          entry.remainingMs = Math.max(1, entry.remainingMs! - (Date.now() - entry.timerStartedAt!))
          entry.timer = undefined
        } else if (!this.nativeUnsettled) this.armRequestTimer(entry)
      }
    }
    this.dispatchEvent(decoded as PiRpcEvent)
  }

  private dispatchEvent(ev: PiRpcEvent): void {
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(ev)
      } catch {
        // One subscriber must not break sibling handlers or the stdout reader.
      }
    }
  }

  private takePending(id: string): PendingEntry | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }

  private rejectAllPending(err: unknown): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  private settleTermination(info: {
    reason: 'exit' | 'error'
    code: number | null
    signal: NodeJS.Signals | null
    error?: unknown
  }): void {
    if (this.termination) return
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    if (this.exitFallbackTimer) {
      clearTimeout(this.exitFallbackTimer)
      this.exitFallbackTimer = undefined
    }

    this.termination = {
      ...info,
      expected: this.disposeIsExpected,
      stderrTail: this.stderrTailBuf
    }

    this.rejectAllPending(this.closedError())

    const handlers = [...this.terminationHandlers]
    this.terminationHandlers = []
    for (const handler of handlers) {
      try {
        handler(this.termination)
      } catch {
        // Isolate subscriber failures from each other and from the exit path.
      }
    }
  }

  private closedError(): PiRpcClosedError {
    const t = this.termination
    if (!t) return new PiRpcClosedError('pi process is shutting down')

    const base =
      t.reason === 'error'
        ? `pi process failed: ${t.error instanceof Error ? t.error.message : String(t.error)}`
        : `pi process exited (code=${t.code}, signal=${t.signal})`
    const tail = t.stderrTail.trim()
    return new PiRpcClosedError(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base)
  }

  private timeoutForCommand(type: PiRpcCommand['type']): number {
    if (this.requestTimeoutMs !== undefined) return this.requestTimeoutMs
    switch (type) {
      case 'abort':
        return ABORT_TIMEOUT_MS
      case 'prompt':
        return PROMPT_TIMEOUT_MS
      case 'compact':
        return COMPACT_TIMEOUT_MS
      case 'get_entries':
        return GET_ENTRIES_TIMEOUT_MS
      case 'export_html':
        return EXPORT_TIMEOUT_MS
      default:
        return DEFAULT_REQUEST_TIMEOUT_MS
    }
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Fail closed on unsupported/unknown pi versions before spawning the RPC
    // subprocess (see MIN_PI_VERSION): the ACP prompt lifecycle depends on
    // pi's `agent_settled` event. Launch failures return null here and are
    // surfaced by the detailed spawn error handling below instead.
    try {
      await assertSupportedPiVersion(cmd, params.cwd, params.signal)
    } catch (e) {
      if (e instanceof PiVersionError) {
        throw new PiRpcSpawnError(e.message, { code: 'UNSUPPORTED_PI_VERSION', cause: e })
      }
      throw e
    }

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const extension = new URL('./acp-extension.js', import.meta.url)
    const extensionPath = fileURLToPath(
      existsSync(extension) ? extension : new URL('./acp-extension.ts', import.meta.url)
    )
    const args = ['--mode', 'rpc', '--no-themes', '--extension', extensionPath]
    let emptySessionPath: string | undefined
    if (!params.sessionPath && params.sessionDirectory) {
      // Pi opens an explicit empty session file eagerly. Its default new-session
      // path is not persisted until an assistant message, making preflight cancel
      // followed by restore otherwise lose the session identity.
      mkdirSync(params.sessionDirectory, { recursive: true, mode: 0o700 })
      emptySessionPath = join(
        params.sessionDirectory,
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID()}.jsonl`
      )
      writeFileSync(emptySessionPath, '', { flag: 'wx', mode: 0o600 })
    }
    const sessionPath = params.sessionPath ?? emptySessionPath
    if (sessionPath) args.push('--session', sessionPath)
    const cleanupEmptySession = () => {
      if (!emptySessionPath) return
      try {
        if (statSync(emptySessionPath).size === 0) unlinkSync(emptySessionPath)
      } catch {
        /* Already removed or inaccessible. */
      }
    }

    const invocation = buildPiInvocation(cmd, args, { cwd: params.cwd })
    if (!invocation) {
      cleanupEmptySession()
      throw piExecutableNotFoundError(cmd)
    }
    const child = spawn(invocation.executable, invocation.args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    })
    // Wire stdout/stderr and lifecycle listeners immediately. A child can exit
    // directly after its `spawn` event; constructing only after awaiting that
    // event creates a window where the terminal event is lost.
    const proc = new PiRpcProcess(child)
    void proc.whenTerminated().then(cleanupEmptySession)

    // The OS child is alive now. Hand it to its owner before the first await
    // so a shutdown starting inside this window still terminates it.
    try {
      params.onProcess?.(proc)
    } catch (error) {
      proc.dispose()
      throw error
    }

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (error: Error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (error) {
      proc.dispose({ expected: false })
      const e = error as NodeJS.ErrnoException
      const code = typeof e.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw piExecutableNotFoundError(cmd, e)
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    // No hidden handshake: spawn returns as soon as the OS process exists so
    // the caller owns the child immediately. Authoritative get_state
    // validation (and session-dir setup) happens in SessionManager.create /
    // PiAcpAgent.restoreSession, which also own failure disposal.
    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  /**
   * Subscribe to the child's terminal state. The handler is invoked at most
   * once, even when Node emits both 'error' and 'exit' for the same child.
   * Subscribing after termination delivers the recorded state asynchronously.
   */
  onTermination(handler: (termination: PiRpcTermination) => void): () => void {
    const settled = this.termination
    if (settled) {
      queueMicrotask(() => {
        try {
          handler(settled)
        } catch {
          // Isolate subscriber failures.
        }
      })
      return () => {}
    }

    this.terminationHandlers.push(handler)
    return () => {
      this.terminationHandlers = this.terminationHandlers.filter(h => h !== handler)
    }
  }

  /** Bounded tail of the child's stderr output (for diagnostics). */
  stderrTail(): string {
    return this.stderrTailBuf
  }

  /**
   * Whether a request is still awaiting its correlated pi response. pi has no
   * command that cancels in-flight RPC work (`abort` only stops an agent run,
   * not a manual compaction/export), so callers that must settle promptly use
   * this to decide whether the channel has to be quarantined.
   */
  hasPendingRequests(): boolean {
    // Serialized, withdrawable admission bookkeeping is not foreground or
    // manual RPC work that requires quarantine when an adapter command cancels.
    return [...this.pending.values()].some(entry => !entry.admission)
  }

  /**
   * Resolves once the child has actually terminated (immediately if it
   * already has). Final adapter shutdown awaits this so the SIGTERM ->
   * SIGKILL escalation in {@link dispose} can complete before process exit.
   */
  whenTerminated(): Promise<void> {
    if (this.termination) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.onTermination(() => resolve())
    })
  }

  private backgroundDisposal = false

  dispose(options?: { expected?: boolean; backgroundOwner?: string }): void {
    if (this.disposeRequested) return
    if (this.backgroundDisposal && options?.expected !== false) return
    if (options?.backgroundOwner && options.expected !== false) {
      this.backgroundDisposal = true
      void this.abort(options.backgroundOwner)
        .catch(() => {
          console.error('pi-acp: background stop failed during shutdown; detached work may still be running')
        })
        .finally(() => {
          this.backgroundDisposal = false
          this.dispose({ expected: options.expected })
        })
      return
    }
    this.disposeRequested = true
    this.disposeIsExpected = options?.expected ?? true

    // Nothing can answer once shutdown starts; fail pending requests now
    // instead of leaving them to time out.
    this.rejectAllPending(this.closedError())
    if (this.termination) return

    try {
      this.child.kill('SIGTERM')
    } catch {
      // ignore
    }

    const timer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, this.killGraceMs)
    this.killTimer = timer
  }

  private bridgeReady: Promise<void> | undefined

  private stagedPrompt: StagedPrompt | undefined
  private admissionControls: Promise<void> = Promise.resolve()

  private queueAdmissionControl(operation: 'begin' | 'withdraw', stage: StagedPrompt): Promise<boolean> {
    const control = this.admissionControls.then(async () => {
      await this.ensureBridge()
      if (operation === 'begin' && (this.stagedPrompt !== stage || stage.withdrawn)) return false
      return this.control(operation, stage.owner, DEFAULT_REQUEST_TIMEOUT_MS, undefined, true)
    })
    // Native settled actions run sequentially too. An old begin and its exact
    // withdrawal must finish before a newer token can acquire native ownership.
    this.admissionControls = control.then(
      () => {},
      () => {}
    )
    return control
  }

  private beginPrompt(stage: StagedPrompt): Promise<boolean> {
    stage.begin ??= this.queueAdmissionControl('begin', stage).finally(() => {
      stage.begin = undefined
    })
    return stage.begin
  }

  private async ensureBridge(): Promise<void> {
    this.bridgeReady ??= this.getCommands().then(raw => {
      const commands = (raw as { commands?: Array<{ name?: unknown }> })?.commands
      if (!Array.isArray(commands) || !commands.some(command => command.name === 'pi-acp-control'))
        throw new Error(
          'The adapter lifecycle extension failed to load; refusing to send an internal command to the model'
        )
    })
    await this.bridgeReady
  }

  async stagePrompt(owner: string): Promise<void> {
    const stage: StagedPrompt = this.stagedPrompt?.owner === owner ? this.stagedPrompt : { owner, withdrawn: false }
    this.stagedPrompt = stage
    await this.beginPrompt(stage)
  }

  async withdrawPrompt(owner: string): Promise<void> {
    const stage = this.stagedPrompt
    if (!stage || stage.owner !== owner) return
    stage.withdrawn = true
    this.stagedPrompt = undefined
    // Invalidate locally before any await. Native cleanup may itself be deferred
    // behind healthy settlement hooks/synthesis; cancellation must not wait for it.
    void this.queueAdmissionControl('withdraw', stage).catch(() => this.dispose({ expected: false }))
  }

  async prompt(
    message: string,
    images: unknown[] = [],
    onAccepted?: () => void,
    owner?: string,
    onDispatched?: () => void
  ): Promise<void> {
    if (/^\/pi-acp-control(?:\s|$)/.test(message)) throw new Error('pi-acp-control is reserved for the adapter')
    let stage: StagedPrompt | undefined
    if (owner) {
      stage = this.stagedPrompt?.owner === owner ? this.stagedPrompt : { owner, withdrawn: false }
      this.stagedPrompt = stage
      const ready = await this.beginPrompt(stage)
      if (this.stagedPrompt !== stage || stage.withdrawn) return
      if (!ready || this.nativeUnsettled) throw new PiRpcPromptDeferredError('Pi model run is still active')
    }
    // Never insert unremovable text into a foreign native queue. If a run
    // starts after readiness, Pi rejects this bare prompt before acceptance;
    // the session re-admits its exact staged token without aborting that run.
    onDispatched?.()
    const res = await this.request(
      { type: 'prompt', message, images },
      {
        beforeResolve: response => {
          if (response.success) onAccepted?.()
        }
      }
    )
    if (!res.success) {
      if (
        owner &&
        /^(Agent is already processing\.|Cannot submit a prompt while compaction is in progress\.)/.test(
          res.error ?? ''
        )
      )
        throw new PiRpcPromptDeferredError('Pi became busy before prompt acceptance')
      throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    }
    if (this.stagedPrompt === stage) this.stagedPrompt = undefined
  }

  private async control(
    operation: 'begin' | 'withdraw' | 'cancel' | 'check',
    owner: string,
    timeoutMs: number,
    deadline?: number,
    admission = false
  ): Promise<boolean> {
    let acknowledgement: { state?: unknown; error?: unknown } | undefined
    const unsubscribe = this.onEvent(event => {
      if (
        event.type !== 'extension_ui_request' ||
        event.method !== 'setWidget' ||
        event.widgetKey !== 'pi-acp-lifecycle'
      )
        return
      try {
        const lines = event.widgetLines
        if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== 'string') return
        const state = JSON.parse(lines[0]) as { version?: unknown; owner?: unknown; state?: unknown; error?: unknown }
        if (
          state.version === 1 &&
          state.owner === owner &&
          (operation === 'begin'
            ? ['ready', 'waiting', 'rejected', 'error']
            : operation === 'withdraw'
              ? ['withdrawn', 'error']
              : operation === 'cancel'
                ? ['stopping', 'error']
                : ['pending', 'cancelled', 'error']
          ).includes(String(state.state))
        )
          acknowledgement = state
      } catch {
        /* Ignore malformed widget payloads. */
      }
    })
    try {
      const response = await this.request(
        {
          type: 'prompt',
          message: `/pi-acp-control ${operation} ${owner}${deadline === undefined ? '' : ` ${deadline}`}`
        },
        { timeoutMs, admission }
      )
      if (!response.success) throw new Error(`pi prompt failed: ${response.error ?? JSON.stringify(response.data)}`)
      // Pi reports a handled command as RPC success even when its handler throws.
      // Only the companion's correlated acknowledgement permits user dispatch.
      if (operation !== 'begin' && operation !== 'withdraw' && typeof acknowledgement?.error === 'string')
        this.abortControlDiagnostic = acknowledgement.error
      if (operation === 'check' && acknowledgement?.state === 'pending') return false
      if (operation === 'begin' && acknowledgement?.state === 'waiting') return false
      if (
        acknowledgement?.state ===
        (operation === 'begin'
          ? 'ready'
          : operation === 'withdraw'
            ? 'withdrawn'
            : operation === 'cancel'
              ? 'stopping'
              : 'cancelled')
      )
        return true
      if (acknowledgement?.state !== 'rejected') this.dispose({ expected: false })
      throw new Error(
        `ACP lifecycle ${operation} failed: ${String(acknowledgement?.error ?? 'missing acknowledgement')}`
      )
    } finally {
      unsubscribe()
    }
  }

  private abortInFlight: Promise<void> | undefined
  private abortOwner: string | undefined
  private abortControlDiagnostic: string | undefined

  async abort(owner?: string): Promise<void> {
    if (this.abortInFlight) {
      if (owner && this.abortOwner && owner !== this.abortOwner) throw new Error('Conflicting ACP cancellation owner')
      this.abortOwner ??= owner
      return this.abortInFlight
    }
    this.abortOwner = owner
    const abort = this.boundedAbort()
    this.abortInFlight = abort
    try {
      await abort
    } finally {
      if (this.abortInFlight === abort) {
        this.abortInFlight = undefined
        this.abortOwner = undefined
        this.abortControlDiagnostic = undefined
      }
    }
  }

  private async boundedAbort(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.runAbort(Date.now() + ABORT_TIMEOUT_MS),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.dispose({ expected: false })
            reject(new Error('Pi cancellation timed out; detached background work may still be running'))
          }, ABORT_TIMEOUT_MS)
        })
      ])
    } catch (error) {
      // A deadline check can reject before the watchdog fires. Quarantine here
      // too, so disposal cannot start a second cancellation with a fresh budget.
      this.dispose({ expected: false })
      if (this.abortControlDiagnostic)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; last unconfirmed nested control: ${this.abortControlDiagnostic}`,
          { cause: error }
        )
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async runAbort(deadline: number): Promise<void> {
    const remaining = () => Math.max(1, deadline - Date.now())
    await this.call({ type: 'clear_queue' }, remaining())
    // Native abort is the tool_result barrier. Read the owner afterward so close
    // or cancellation can upgrade an already-running ownerless transaction.
    await this.call({ type: 'abort' }, remaining())
    while (this.abortOwner) {
      if (Date.now() >= deadline)
        throw new Error('Cancellation quiescence could not be confirmed; detached background work may still be running')
      await this.control('cancel', this.abortOwner, remaining(), deadline)
      await this.call({ type: 'clear_queue' }, remaining())
      await this.call({ type: 'abort' }, remaining())
      // Stops may trigger synthesis and late tool results. Only a read-only
      // check after native abort can finish; new work gets another bounded pass.
      if (await this.control('check', this.abortOwner, remaining(), deadline)) return
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining())))
    }
  }

  async getState(): Promise<unknown> {
    return this.call({ type: 'get_state' })
  }

  async getAvailableModels(): Promise<unknown> {
    return this.call({ type: 'get_available_models' })
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.call({ type: 'set_model', provider, modelId })
  }

  async getAvailableThinkingLevels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success) {
      const error = new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
      ;(error as Error & { unsupportedCommand?: boolean }).unsupportedCommand = /unknown command|unsupported/i.test(
        res.error ?? ''
      )
      throw error
    }
    return res.data
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    await this.call({ type: 'set_thinking_level', level })
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    await this.call({ type: 'set_follow_up_mode', mode })
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    await this.call({ type: 'set_steering_mode', mode })
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return this.call({ type: 'compact', customInstructions })
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.call({ type: 'set_auto_compaction', enabled })
  }

  async getSessionStats(): Promise<unknown> {
    return this.call({ type: 'get_session_stats' })
  }

  async setSessionName(name: string): Promise<void> {
    await this.call({ type: 'set_session_name', name })
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data as { path?: unknown } | null | undefined
    return { path: String(data?.path ?? '') }
  }

  /**
   * The callback runs synchronously at the response line boundary, before
   * later stdout events can be dispatched from the same input chunk.
   */
  async getEntries(beforeResponseResolve?: () => void): Promise<unknown> {
    const res = await this.request({ type: 'get_entries' }, { beforeResolve: beforeResponseResolve })
    if (!res.success) throw new Error(`pi get_entries failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    return this.call({ type: 'get_commands' })
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private async call(cmd: PiRpcCommand, timeoutMs?: number): Promise<unknown> {
    const res = await this.request(cmd, { timeoutMs })
    if (!res.success) throw new Error(`pi ${cmd.type} failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private armRequestTimer(entry: PendingEntry): void {
    if (entry.timer || entry.remainingMs === undefined || (entry.admission && this.nativeUnsettled)) return
    entry.timerStartedAt = Date.now()
    entry.timer = setTimeout(entry.onTimeout!, entry.remainingMs)
  }

  private request(
    cmd: PiRpcCommand,
    opts?: { beforeResolve?: (response: PiRpcResponse) => void; timeoutMs?: number; admission?: boolean }
  ): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const line = `${JSON.stringify({ ...cmd, id })}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      if (this.termination || this.disposeRequested) {
        reject(this.closedError())
        return
      }

      const entry: PendingEntry = {
        resolve,
        reject,
        beforeResolve: opts?.beforeResolve,
        admission: opts?.admission ?? false
      }
      const timeoutMs = opts?.timeoutMs ?? this.timeoutForCommand(cmd.type)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.remainingMs = timeoutMs
        entry.onTimeout = () => {
          if (!this.takePending(id)) return
          const error = new PiRpcRequestTimeoutError(cmd.type, timeoutMs)
          // Any timed-out command leaves both the command outcome and channel
          // health unknown: pi may still execute it later and stream output
          // (a prompt after slow preflight, a compact mutating state, a
          // wedged event loop recovering). Quarantine the channel as an
          // unexpected fault before rejecting so no late response or event
          // can escape into a closed or replacement ACP turn, and every
          // future request fails fast instead of hanging.
          this.dispose({ expected: false })
          reject(error)
        }
        // Only internal admission/withdrawal budgets exclude observed native
        // work through authoritative settlement, including awaited hooks. Reads,
        // raw preflight, manual work and owned cancellation keep wall-clock guards.
        this.armRequestTimer(entry)
      }
      this.pending.set(id, entry)

      void this.writeLine(line).catch(error => {
        if (this.takePending(id)) reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        // A failed stdin write leaves it unknown how much of the record pi
        // received, so the channel can no longer be framed reliably.
        // Quarantine it as an unexpected fault before rejecting: later
        // requests must fail fast instead of running on a broken channel.
        this.dispose({ expected: false })
        reject(error)
      }

      try {
        this.child.stdin.write(line, error => {
          if (error) {
            fail(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        fail(error)
      }
    })
  }
}
