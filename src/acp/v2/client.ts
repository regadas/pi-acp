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
 * message upserts, one message per retained entry, carrying the
 * deterministic id `replay:<entryId>`: an entry's blocks accumulate —
 * including across interruptions by tool calls, which flush and later
 * re-emit the full cumulative content — and v2 message updates replace a
 * message's content as a whole, so replaying the same history again
 * re-sends it under the same ids without duplicating what the client
 * already holds.
 */
export class V2ClientConnection implements AcpClient {
  private readonly currentMessage = new Map<string, { kind: string; id: string }>()
  /** Open replaying windows per session (depth: windows may overlap while a superseded restore settles). */
  private readonly replayDepth = new Map<string, number>()
  /**
   * Cumulative replayed content per retained (entry, kind), surviving the
   * intermediate flushes: an entry interrupted by other updates (text,
   * tool call, text) re-emits ALL its content, not just the last run.
   */
  private readonly replayContent = new Map<
    string,
    Map<string, { entryId: string; kind: ChunkKind; content: v2.ContentBlock[] }>
  >()
  /** The (entry, kind) accumulating right now; flushes emit its full cumulative content. */
  private readonly currentReplayKey = new Map<string, string>()

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
      const key = `${entryId} ${kind}`
      if (this.currentReplayKey.get(sessionId) !== key) {
        await this.flushReplayEntry(sessionId)
        this.currentReplayKey.set(sessionId, key)
      }
      const entries = this.replayContent.get(sessionId) ?? new Map()
      this.replayContent.set(sessionId, entries)
      const entry = entries.get(key) ?? { entryId, kind, content: [] as v2.ContentBlock[] }
      entry.content.push((toV2SessionUpdate(update, `replay:${entryId}`) as { content: v2.ContentBlock }).content)
      entries.set(key, entry)
      return
    }
    await this.flushReplayEntry(sessionId)
    const messageId = kind !== null ? this.messageIdFor(sessionId, kind) : undefined
    const translated = toV2SessionUpdate(update, messageId)
    if (translated !== undefined)
      await this.ctx.notify(v2.methods.client.session.update, { sessionId, update: translated })
  }

  /**
   * Emit the current entry's v2 message upsert with its full cumulative
   * content. The accumulator survives the flush: a later chunk of the same
   * entry re-emits everything, idempotent under v2 upsert replacement
   * semantics.
   */
  private async flushReplayEntry(sessionId: string): Promise<void> {
    const key = this.currentReplayKey.get(sessionId)
    if (key === undefined) return
    this.currentReplayKey.delete(sessionId)
    const entry = this.replayContent.get(sessionId)?.get(key)
    if (!entry) return
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
   * inner window's end from closing the outer one's. Each new window drops
   * the session's buffered replay state first: the newer load wins (the
   * engine supersedes the older one), so a superseded window's partial entry
   * cannot merge duplicate blocks into the winner's message. Residual: an
   * inner window that fails validation before replaying still drops the
   * outer winner's unflushed partial (contrived: two racing resumes).
   */
  async replaying<T>(sessionId: string, restore: () => Promise<T>): Promise<T> {
    this.replayDepth.set(sessionId, (this.replayDepth.get(sessionId) ?? 0) + 1)
    this.replayContent.delete(sessionId)
    this.currentReplayKey.delete(sessionId)
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
        this.replayContent.delete(sessionId)
        this.currentReplayKey.delete(sessionId)
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
