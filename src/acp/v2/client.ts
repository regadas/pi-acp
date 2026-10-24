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
import { replayEntryId } from '../replay-entry-id.js'

type ChunkKind = ReturnType<typeof chunkUpdateKind> extends infer K | null ? K : never

/** The v2 message upsert a replayed entry's chunks accumulate into. */
const UPSERT_OF_CHUNK_KIND: Record<ChunkKind, 'user_message' | 'agent_message' | 'agent_thought'> = {
  user_message_chunk: 'user_message',
  agent_message_chunk: 'agent_message',
  agent_thought_chunk: 'agent_thought'
}

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
 * Inside {@link replaying} windows, replayed history is delivered as v2
 * message upserts, one message per retained entry (its chunks grouped),
 * carrying the deterministic id `replay:<entryId>`. v2 message updates
 * replace a message's content as a whole, so replaying the same history
 * again re-sends it under the same ids without duplicating what the client
 * already holds.
 */
export class V2ClientConnection implements AcpClient {
  private readonly currentMessage = new Map<string, { kind: string; id: string }>()
  /** Open replaying windows per session (depth: windows may overlap while a superseded restore settles). */
  private readonly replayDepth = new Map<string, number>()
  /** The retained entry whose chunks are accumulating into one message right now. */
  private readonly replayEntries = new Map<string, { entryId: string; kind: ChunkKind; content: v2.ContentBlock[] }>()

  constructor(private readonly ctx: v2.AgentContext) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const sessionId = params.sessionId
    const kind = chunkUpdateKind(params.update)
    if ((this.replayDepth.get(sessionId) ?? 0) > 0) {
      await this.replayUpdate(sessionId, kind, params.update)
      return
    }
    if (kind === null) {
      this.currentMessage.delete(sessionId)
    }
    const messageId = kind !== null ? this.messageIdFor(sessionId, kind) : undefined
    const update = toV2SessionUpdate(params.update, messageId)
    if (update !== undefined) await this.ctx.notify(v2.methods.client.session.update, { sessionId, update })
  }

  /**
   * A replayed update: the chunks of one retained entry accumulate into
   * that entry's single message; any other update (or the next entry) first
   * completes the buffered one. Markerless chunks — none exist today — fall
   * back to the live grouping.
   */
  private async replayUpdate(
    sessionId: string,
    kind: ChunkKind | null,
    update: Parameters<AcpClient['sessionUpdate']>[0]['update']
  ): Promise<void> {
    const entryId = kind !== null ? (update as typeof update & { [replayEntryId]?: string })[replayEntryId] : undefined
    if (kind !== null && typeof entryId === 'string') {
      const current = this.replayEntries.get(sessionId)
      if (current && (current.entryId !== entryId || current.kind !== kind)) {
        await this.flushReplayEntry(sessionId)
      }
      const entry = this.replayEntries.get(sessionId) ?? { entryId, kind, content: [] as v2.ContentBlock[] }
      entry.content.push((toV2SessionUpdate(update, `replay:${entryId}`) as { content: v2.ContentBlock }).content)
      this.replayEntries.set(sessionId, entry)
      return
    }
    await this.flushReplayEntry(sessionId)
    const messageId = kind !== null ? this.messageIdFor(sessionId, kind) : undefined
    const translated = toV2SessionUpdate(update, messageId)
    if (translated !== undefined)
      await this.ctx.notify(v2.methods.client.session.update, { sessionId, update: translated })
  }

  /** Emit the buffered entry as its v2 message upsert, with the entry's full content. */
  private async flushReplayEntry(sessionId: string): Promise<void> {
    const entry = this.replayEntries.get(sessionId)
    if (!entry) return
    this.replayEntries.delete(sessionId)
    await this.ctx.notify(v2.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: UPSERT_OF_CHUNK_KIND[entry.kind],
        messageId: `replay:${entry.entryId}`,
        content: entry.content
      } as v2.SessionUpdate
    })
  }

  /**
   * Runs `restore`, which replays the history of `sessionId`, inside a replay
   * window: replayed entries become deterministic message upserts. Windows
   * may overlap while a superseded restore settles; the depth keeps the
   * inner window's end from closing the outer one's.
   */
  async replaying<T>(sessionId: string, restore: () => Promise<T>): Promise<T> {
    this.replayDepth.set(sessionId, (this.replayDepth.get(sessionId) ?? 0) + 1)
    this.currentMessage.delete(sessionId)
    try {
      return await restore()
    } finally {
      // Only the last window's end completes the history and closes the
      // replay mode — an inner (superseded) window's end must not.
      const depth = (this.replayDepth.get(sessionId) ?? 1) - 1
      if (depth === 0) {
        this.replayDepth.delete(sessionId)
        await this.flushReplayEntry(sessionId)
      } else {
        this.replayDepth.set(sessionId, depth)
      }
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
}
