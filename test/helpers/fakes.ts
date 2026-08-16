import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpClient } from '../../src/acp/client.js'
import type { PiRpcEvent, PiRpcTermination } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = SessionNotification

export type ConfigSyncRecord = {
  seeds: Array<{ configOptions: SessionConfigOption[]; currentModeId: string | undefined }>
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
    seedSessionConfiguration(configOptions: SessionConfigOption[], currentModeId?: string): void {
      configSync.seeds.push({ configOptions, currentModeId })
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
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  private terminationHandlers: Array<(t: PiRpcTermination) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
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

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
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
    for (const h of this.terminationHandlers) h(termination)
  }

  async prompt(message: string, attachments: unknown[] = [], onAccepted?: () => void): Promise<void> {
    this.prompts.push({ message, attachments })
    this.beforePromptAccepted?.(message)
    onAccepted?.()
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  // Mirrors PiRpcProcess.dispose(options?) so sessions exercising the
  // expected/unexpected disposal distinction compile against the fake.
  dispose(options?: { expected?: boolean }): void {
    this.disposeCount += 1
    this.disposeOptions.push(options)
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return this.state
  }

  readonly thinkingLevels: string[] = []
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

  async getMessages(beforeResponseResolve?: () => void): Promise<any> {
    beforeResponseResolve?.()
    return { messages: [] }
  }

  // Mutable fake get_tree payload; tests set `tree` to replay history.
  tree: { tree: unknown[]; leafId: string | null } = { tree: [], leafId: null }

  async getTree(beforeResponseResolve?: () => void): Promise<any> {
    beforeResponseResolve?.()
    return this.tree
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpClient {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AcpClient
}
