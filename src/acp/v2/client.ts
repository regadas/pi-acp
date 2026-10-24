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
 * connection synthesizes them. Live chunks group consecutive chunks of the
 * same kind into one v2 message; any other update of the session ends the
 * current message. The live ids are fresh UUIDs: the engine's live emission
 * path has no persisted-entry identity, so a live message's id can never
 * match the id its later replay uses — a documented association limitation
 * (see docs/adapter-reference.md).
 *
 * Inside a {@link replaying} window, replayed chunks each become their own
 * message (adjacent same-kind history entries never merge) with ids
 * deterministic in their position: replaying the same history twice yields
 * identical ids, and ids stay stable while earlier history is unchanged.
 */
export class V2ClientConnection implements AcpClient {
  private readonly currentMessage = new Map<string, { kind: string; id: string }>()
  /** Sessions whose history is being replayed right now. */
  private readonly replays = new Set<string>()
  /** Replay chunk counters per session and kind; the key of the next replay message id. */
  private readonly replayCounts = new Map<string, Map<string, number>>()

  constructor(private readonly ctx: v2.AgentContext) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const kind = chunkUpdateKind(params.update)
    let update: v2.SessionUpdate | undefined
    if (this.replays.has(params.sessionId)) {
      // Replayed chunks never group: each is one message, with a
      // position-stable id so repeated replays reuse it.
      update =
        kind !== null
          ? toV2SessionUpdate(params.update, this.replayMessageId(params.sessionId, kind))
          : toV2SessionUpdate(params.update, undefined)
    } else {
      if (kind === null) {
        this.currentMessage.delete(params.sessionId)
      }
      const messageId = kind !== null ? this.messageIdFor(params.sessionId, kind) : undefined
      update = toV2SessionUpdate(params.update, messageId)
    }
    if (update !== undefined)
      await this.ctx.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update })
  }

  /**
   * Runs `restore`, which replays the history of `sessionId`, inside a replay
   * window: replayed chunks get deterministic per-position message ids.
   */
  async replaying<T>(sessionId: string, restore: () => Promise<T>): Promise<T> {
    this.replays.add(sessionId)
    this.replayCounts.delete(sessionId)
    this.currentMessage.delete(sessionId)
    try {
      return await restore()
    } finally {
      this.replays.delete(sessionId)
      this.replayCounts.delete(sessionId)
      this.currentMessage.delete(sessionId)
    }
  }

  /**
   * An app-level v2 update outside the engine's update stream (a state
   * snapshot, a user-message echo). Delivered in call order, like the
   * engine's updates.
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

  private replayMessageId(sessionId: string, kind: string): string {
    let counts = this.replayCounts.get(sessionId)
    if (!counts) {
      counts = new Map()
      this.replayCounts.set(sessionId, counts)
    }
    const index = counts.get(kind) ?? 0
    counts.set(kind, index + 1)
    return `replay:${kind}:${index}`
  }
}
