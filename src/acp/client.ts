import { methods, type AgentContext } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'

/**
 * Narrow client-facing surface the agent calls back into. This is the subset
 * of ACP client methods the adapter actually uses, expressed as a small
 * interface so tests can supply lightweight fakes. In production it is backed
 * by {@link ClientConnection} over the SDK's connection-scoped `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
}

/**
 * Bridges {@link AcpClient} to the `AgentContext` exposed by
 * `AgentApp.connect(...)` as `connection.client`. The peer handle stays valid
 * for the entire connection lifetime, so it is captured once at construction.
 */
export class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params)
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params)
  }
}
