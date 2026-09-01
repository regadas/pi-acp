import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpClient } from '../../src/acp/client.js'
import type { PiRpcEvent, PiRpcTermination } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = SessionNotification

export type ConfigSyncRecord = {
  seeds: SessionConfigOption[][]
  beginCalls: number
  endCalls: number
}

/**
 * PiAcpSession's configuration-sync and publication surface. PiAcpAgent calls
 * both unconditionally, so session doubles must implement them (and can assert
 * on `configSync`) instead of letting the calls be skipped. `updateSink`
 * stands in for the session's ordered delivery queue.
 */
export function fakeSessionConfigSync(updateSink?: FakeAgentSideConnection) {
  const configSync: ConfigSyncRecord = { seeds: [], beginCalls: 0, endCalls: 0 }
  return {
    configSync,
    updateSink: updateSink ?? null,
    // Reads `this` so doubles built by spreading can wire `updateSink` later.
    async sendSessionUpdate(
      this: { updateSink: FakeAgentSideConnection | null },
      params: SessionUpdateMsg
    ): Promise<void> {
      if (!this.updateSink) throw new Error('fakeSessionConfigSync: no updateSink connected')
      await this.updateSink.sessionUpdate(params)
    },
    seedSessionConfiguration(configOptions: SessionConfigOption[]): void {
      configSync.seeds.push(configOptions)
    },
    beginConfigurationMutation(): void {
      configSync.beginCalls += 1
    },
    async endConfigurationMutation(): Promise<void> {
      configSync.endCalls += 1
    }
  }
}

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown,
    _options?: { cancellationSignal?: AbortSignal }
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async createElicitation(): Promise<{ action: 'cancel' }> {
    return { action: 'cancel' }
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  private terminationHandlers: Array<(t: PiRpcTermination) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  disposed = false
  disposeCount = 0
  readonly disposeOptions: Array<{ expected?: boolean } | undefined> = []
  beforePromptAccepted: ((message: string) => void) | null = null

  // Mutable fake pi state returned by getState(). Defaults to an active agent
  // run so lifecycle tests behave like a real running pi; tests exercising
  // the no-agent-run acceptance path set `state = { isStreaming: false }`.
  state: Record<string, unknown> = { isStreaming: true }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent | Record<string, unknown>) {
    for (const h of this.handlers) h(ev as PiRpcEvent)
  }

  onTermination(handler: (t: PiRpcTermination) => void): () => void {
    this.terminationHandlers.push(handler)
    return () => {
      this.terminationHandlers = this.terminationHandlers.filter(h => h !== handler)
    }
  }

  // Unlike the real PiRpcProcess (which notifies at most once), this does not
  // dedupe deliveries so tests can assert session-side idempotency.
  emitTermination(info: Partial<PiRpcTermination> = {}) {
    const termination: PiRpcTermination = {
      reason: 'exit',
      code: 1,
      signal: null,
      expected: false,
      stderrTail: '',
      ...info
    }
    this.markTerminated()
    for (const h of this.terminationHandlers) h(termination)
  }

  terminated = false
  private terminationWaiters: Array<() => void> = []

  whenTerminated(): Promise<void> {
    if (this.terminated) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.terminationWaiters.push(resolve)
    })
  }

  /** Settle `whenTerminated` waiters; `emitTermination` also runs the handlers. */
  private markTerminated(): void {
    this.terminated = true
    const waiters = this.terminationWaiters
    this.terminationWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * Whether disposal terminates the child. Default `false` keeps it "alive"
   * after SIGTERM so shutdown-escalation tests stay in control; tests that need
   * a child which exits promptly on disposal opt in. Opting in emits a real
   * termination (handlers *and* `whenTerminated`) because the two are
   * inseparable in `PiRpcProcess.settleTermination`.
   */
  terminateOnDispose = false

  async prompt(message: string, attachments: unknown[] = [], onAccepted?: () => void): Promise<void> {
    this.prompts.push({ message, attachments })
    this.beforePromptAccepted?.(message)
    onAccepted?.()
  }

  // Mirrors real pi: `abort` stops an agent run. It does NOT settle an
  // in-flight manual RPC such as compaction or export, so it must never be
  // used by tests to make a blocked command's promise resolve.
  async abort(): Promise<void> {
    this.abortCount += 1
  }

  // Outstanding pi RPCs, mirroring PiRpcProcess's correlation map.
  private readonly pending = new Set<(err: unknown) => void>()

  hasPendingRequests(): boolean {
    return this.pending.size > 0
  }

  /**
   * Model an RPC that stays outstanding until `settlement` settles. Only
   * `dispose()` can reject it early, exactly like the real channel.
   */
  pendingRequest<T>(settlement: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.add(reject)
      const done = () => this.pending.delete(reject)
      settlement.then(
        value => {
          done()
          resolve(value)
        },
        error => {
          done()
          reject(error)
        }
      )
    })
  }

  // Mirrors PiRpcProcess.dispose(options?), including its idempotency, so
  // sessions exercising the expected/unexpected disposal distinction compile
  // against the fake and repeated disposals stay observable as one.
  dispose(options?: { expected?: boolean }): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeCount += 1
    this.disposeOptions.push(options)

    const pending = [...this.pending]
    this.pending.clear()
    for (const reject of pending) reject(new Error('pi process closed'))

    // A real disposed child exits on SIGTERM (or is SIGKILLed), which is what
    // the replacement barrier waits for.
    if (this.terminateOnDispose) {
      this.emitTermination({ reason: 'exit', code: 0, signal: null, expected: options?.expected ?? true })
    }
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return this.state
  }

  readonly thinkingLevels: string[] = []
  availableThinkingLevels: string[] | null = null

  async getAvailableThinkingLevels(): Promise<unknown> {
    if (this.availableThinkingLevels) return { levels: this.availableThinkingLevels }
    const error = new Error('unknown command: get_available_thinking_levels') as Error & {
      unsupportedCommand?: boolean
    }
    error.unsupportedCommand = true
    throw error
  }
  readonly models: Array<{ provider: string; modelId: string }> = []
  // Optional hook so tests can model pi echoing its own state-change events.
  afterThinkingLevelSet: ((level: string) => void) | null = null

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingLevels.push(level)
    this.state = { ...this.state, thinkingLevel: level }
    this.afterThinkingLevelSet?.(level)
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.models.push({ provider, modelId })
    this.state = { ...this.state, model: { provider, id: modelId, reasoning: true } }
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  // Mutable fake get_entries payload; tests set it to replay history.
  entrySnapshot: { entries: unknown[]; leafId: string | null } = { entries: [], leafId: null }

  async getEntries(beforeResponseResolve?: () => void): Promise<any> {
    beforeResponseResolve?.()
    return this.entrySnapshot
  }
}

/**
 * Text of the last `agent_message_chunk` delivered. Settled work publishes
 * terminal `session_info_update` queue metadata afterwards, so the last update
 * overall is not the command's output.
 */
export function lastAgentMessageText(conn: FakeAgentSideConnection): string {
  for (let i = conn.updates.length - 1; i >= 0; i--) {
    const update = conn.updates[i]!.update as { sessionUpdate?: string; content?: { type?: string; text?: unknown } }
    if (update.sessionUpdate !== 'agent_message_chunk') continue
    if (update.content?.type === 'text' && typeof update.content.text === 'string') return update.content.text
  }
  throw new Error('no agent_message_chunk was delivered')
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpClient {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AcpClient
}
