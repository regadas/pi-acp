import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk/unstable'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { randomUUID } from 'node:crypto'
import type { AcpClient, RequestOptions } from '../client.js'
import { chunkUpdateKind, toV1PermissionResponse, toV2PermissionRequest, toV2SessionUpdate } from './translate.js'

/**
 * The {@link AcpClient} of an ACP v2 connection: it delivers the v1 session
 * updates of the engine as v2 updates, and asks permissions in their v2 form.
 *
 * The engine's chunk updates carry no message id (v1 allows none), so this
 * connection groups consecutive chunks of the same kind into one v2 message:
 * any other update of the session ends the current message, as does any
 * app-level update (a state snapshot or user-message echo). The synthesized
 * ids are unique per connection, so replayed chunks never collide with a
 * message a client may still hold.
 */
export class V2ClientConnection implements AcpClient {
  private readonly currentMessage = new Map<string, { kind: string; id: string }>()

  constructor(private readonly ctx: v2.AgentContext) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const kind = chunkUpdateKind(params.update)
    if (kind === null) {
      this.currentMessage.delete(params.sessionId)
    }
    const messageId = kind !== null ? this.messageIdFor(params.sessionId, kind) : undefined
    const update = toV2SessionUpdate(params.update, messageId)
    if (update !== undefined)
      await this.ctx.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update })
  }

  /**
   * An app-level v2 update outside the engine's update stream (a state
   * snapshot, a user-message echo). Delivered in call order, like the
   * engine's updates: the engine's consumer awaits each update before
   * reporting the next turn event.
   */
  async send(sessionId: string, update: v2.SessionUpdate): Promise<void> {
    this.currentMessage.delete(sessionId)
    await this.ctx.notify(v2.methods.client.session.update, { sessionId, update })
  }

  async requestPermission(
    params: RequestPermissionRequest,
    options?: RequestOptions
  ): Promise<RequestPermissionResponse> {
    const response = await this.ctx.request(
      v2.methods.client.session.requestPermission,
      toV2PermissionRequest(params),
      options
    )
    return toV1PermissionResponse(response)
  }

  createElicitation(params: CreateElicitationRequest, options?: RequestOptions): Promise<CreateElicitationResponse> {
    // Elicitation requests and responses have the same shape in v1 and v2.
    return this.ctx.request(
      v2.methods.client.elicitation.create,
      params as v2.CreateElicitationRequest,
      options
    ) as Promise<CreateElicitationResponse>
  }

  private messageIdFor(sessionId: string, kind: string): string {
    const current = this.currentMessage.get(sessionId)
    if (current?.kind === kind) return current.id
    const entry = { kind, id: randomUUID() }
    this.currentMessage.set(sessionId, entry)
    return entry.id
  }
}
