import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getPiCommand, resolvePiCommandForVersionPreflight, shouldUseShellForPiCommand } from './command.js'
import { LfLineDecoder } from './line-decoder.js'
import { assertSupportedPiVersion, PiVersionError } from './version.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
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

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: PiThinkingLevel }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'get_entries'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
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
}

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
      this.settleTermination({ reason: 'error', code: null, signal: null, error: err })
    })
    child.on('exit', (code, signal) => {
      // Prefer settling on 'close' so stdout data already buffered in the pipe
      // is dispatched to event handlers first; the fallback timer guards
      // against stdio that never closes.
      const timer = setTimeout(() => this.settleTermination({ reason: 'exit', code, signal }), this.closeFallbackMs)
      timer.unref?.()
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

    const record = msg as { type?: unknown; id?: unknown }
    if (record?.type === 'response') {
      // Responses are correlation records, never pi events. A response whose
      // request already timed out is stale and must not reach session event
      // handlers or a later turn.
      if (typeof record.id !== 'string') return
      const entry = this.takePending(record.id)
      if (!entry) return
      try {
        const response = msg as PiRpcResponse
        entry.beforeResolve?.(response)
        entry.resolve(response)
      } catch (error) {
        entry.reject(error)
      }
      return
    }

    this.dispatchEvent(msg as PiRpcEvent)
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

    // Preflight Windows command scripts before probing them through a shell.
    // The resolved path is used only to classify a missing pi.cmd/pi.bat as
    // ENOENT. The probe itself must use the original command: converting a
    // bare launcher to an absolute path containing spaces can make cmd.exe
    // tokenize a valid installation incorrectly.
    const versionPreflightCommand = resolvePiCommandForVersionPreflight(cmd, params.cwd)
    if (!versionPreflightCommand) throw piExecutableNotFoundError(cmd)

    // Fail closed on unsupported/unknown pi versions before spawning the RPC
    // subprocess (see MIN_PI_VERSION): the ACP prompt lifecycle depends on
    // pi's `agent_settled` event. Launch failures return null here and are
    // surfaced by the detailed spawn error handling below instead.
    try {
      assertSupportedPiVersion(cmd, params.cwd)
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
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    })
    // Wire stdout/stderr and lifecycle listeners immediately. A child can exit
    // directly after its `spawn` event; constructing only after awaiting that
    // event creates a window where the terminal event is lost.
    const proc = new PiRpcProcess(child)

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
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      proc.dispose({ expected: false })
      const code = typeof e?.code === 'string' ? e.code : undefined
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
    return this.pending.size > 0
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

  dispose(options?: { expected?: boolean }): void {
    if (this.disposeRequested) return
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
    timer.unref?.()
    this.killTimer = timer
  }

  async prompt(message: string, images: unknown[] = [], onAccepted?: () => void): Promise<void> {
    // TOCTOU backstop: pi consults streamingBehavior only when it is already
    // streaming, where a bare prompt is rejected outright ("Agent is already
    // processing"). Extensions can start runs pi-acp does not own, so a
    // dispatch that races such a run is queued non-interruptively as a
    // follow-up instead of failing the ACP request. The idle path is
    // unchanged: pi ignores the field entirely when not streaming.
    const res = await this.request(
      { type: 'prompt', message, images, streamingBehavior: 'followUp' },
      {
        // This callback runs synchronously at the successful response record,
        // before any later event records from the same stdout chunk. Session
        // ownership must cross that wire boundary rather than the earlier
        // stdin-write boundary.
        beforeResolve: response => {
          if (response.success) onAccepted?.()
        }
      }
    )
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
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
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(
    cmd: PiRpcCommand,
    opts?: { beforeResolve?: (response: PiRpcResponse) => void }
  ): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const line = `${JSON.stringify({ ...cmd, id })}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      if (this.termination || this.disposeRequested) {
        reject(this.closedError())
        return
      }

      const entry: PendingEntry = { resolve, reject, beforeResolve: opts?.beforeResolve }
      const timeoutMs = this.timeoutForCommand(cmd.type)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timer = setTimeout(() => {
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
        }, timeoutMs)
        timer.unref?.()
        entry.timer = timer
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
