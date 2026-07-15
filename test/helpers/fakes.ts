import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpClient } from '../../src/acp/client.js'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = SessionNotification

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

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  disposeCount = 0

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

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  dispose(): void {
    this.disposeCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return this.state
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(beforeResponseResolve?: () => void): Promise<any> {
    beforeResponseResolve?.()
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpClient {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AcpClient
}
