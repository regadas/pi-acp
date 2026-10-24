import { RequestError } from '@agentclientprotocol/sdk/unstable'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type {
  AvailableCommand,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse
} from '@agentclientprotocol/sdk/unstable'

type ChunkSessionUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk' }
>

export type ChunkKind = ChunkSessionUpdate['sessionUpdate']

/** The chunk kind of a v1 session update, or null when the update is not a message chunk. */
export function chunkUpdateKind(update: SessionUpdate): ChunkKind | null {
  const kind = update.sessionUpdate
  return kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' ? kind : null
}

/**
 * The v2 form of a v1 session update, or undefined when v2 has no counterpart.
 * Chunk updates need the id of the message they belong to: v1 allows none, v2
 * requires one. Update kinds without a v2 counterpart throw rather than
 * silently vanishing.
 */
export function toV2SessionUpdate(
  update: SessionUpdate,
  chunkMessageId: string | undefined
): v2.SessionUpdate | undefined {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (chunkMessageId === undefined) {
        throw new Error(`An ACP v2 ${update.sessionUpdate} needs a messageId`)
      }
      return {
        sessionUpdate: update.sessionUpdate,
        messageId: chunkMessageId,
        content: update.content
      } as v2.SessionUpdate
    }
    case 'tool_call':
    case 'tool_call_update': {
      // v2 has no first-report variant: a v1 tool_call is the first
      // tool_call_update of that tool call. The fields share their shape;
      // the brands of the two schema versions' unions do not.
      const { sessionUpdate: _kind, ...fields } = update
      return { sessionUpdate: 'tool_call_update', ...fields } as v2.SessionUpdate
    }
    case 'available_commands_update':
      return { sessionUpdate: update.sessionUpdate, availableCommands: toV2AvailableCommands(update.availableCommands) }
    case 'config_option_update':
      return { sessionUpdate: update.sessionUpdate, configOptions: toV2ConfigOptions(update.configOptions) }
    case 'session_info_update':
    case 'usage_update':
      // The v1-unstable and v2-stable shapes of these updates are the same.
      return update as v2.SessionUpdate
    default:
      throw new Error(`pi-acp: no ACP v2 translation for ${update.sessionUpdate} session update`)
  }
}

/** v2 names the id of a config option `configId`; v1 calls it `id`. */
export function toV2ConfigOptions(options: readonly SessionConfigOption[]): v2.SessionConfigOption[] {
  return options.map(option => {
    const { id, ...rest } = option
    return { ...rest, configId: id } as v2.SessionConfigOption
  })
}

/** v2 tags the free-text input of a command with `type: "text"`. */
export function toV2AvailableCommands(commands: readonly AvailableCommand[]): v2.AvailableCommand[] {
  return commands.map(({ input, ...command }) => ({
    ...command,
    ...(input != null ? { input: { type: 'text', hint: input.hint } } : {})
  }))
}

/**
 * The v1 initialize request the engine serves for a v2 one. Terminal auth and
 * the terminal-output meta stay off: the v2 surface does not advertise the
 * `auth/login`/`auth/logout` methods or v2 terminal updates they would
 * require, so a v2 client must configure pi credentials out of band.
 */
export function v1InitializeRequest(params: v2.InitializeRequest): InitializeRequest {
  const elicitation = params.capabilities?.elicitation
  return {
    protocolVersion: 1,
    clientInfo: params.info,
    clientCapabilities: {
      ...(elicitation?.form != null ? { elicitation: { form: elicitation.form } } : {})
    }
  }
}

/** The v2 initialize response: only the session surface this adapter backs. */
export function toV2InitializeResponse(response: InitializeResponse): v2.InitializeResponse {
  const info = response.agentInfo ?? { name: 'pi-acp', version: '0.0.0' }
  return {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: info.name, title: info.title ?? info.name, version: info.version ?? '0.0.0' },
    capabilities: {
      session: {
        prompt: { image: {}, embeddedContext: {} },
        delete: {},
        additionalDirectories: {}
      }
    }
  }
}

export function v1NewSessionRequest(params: v2.NewSessionRequest): NewSessionRequest {
  return {
    cwd: params.cwd,
    ...(params.additionalDirectories != null ? { additionalDirectories: params.additionalDirectories } : {}),
    // v1 requires the list; v2 treats an omitted one as empty. Non-empty
    // lists are rejected by the engine before any side effect.
    mcpServers: (params.mcpServers ?? []) as NewSessionRequest['mcpServers'],
    ...(params._meta != null ? { _meta: params._meta } : {})
  }
}

export function toV2NewSessionResponse(response: NewSessionResponse): v2.NewSessionResponse {
  return {
    sessionId: response.sessionId,
    ...(response.configOptions != null ? { configOptions: toV2ConfigOptions(response.configOptions) } : {}),
    ...(response._meta != null ? { _meta: response._meta } : {})
  }
}

/**
 * The v1 request a v2 `session/resume` means. v2 replays only when
 * `replayFrom` asks for it: v1 splits that across `session/resume` (no
 * replay) and `session/load` (replays the whole history). Only the `start`
 * cursor exists; any other is rejected rather than silently resumed.
 */
export function v1RestoreSessionRequest(
  params: v2.ResumeSessionRequest
): { method: 'resume'; request: ResumeSessionRequest } | { method: 'load'; request: LoadSessionRequest } {
  const request = {
    sessionId: params.sessionId,
    cwd: params.cwd,
    ...(params.additionalDirectories != null ? { additionalDirectories: params.additionalDirectories } : {}),
    mcpServers: (params.mcpServers ?? []) as LoadSessionRequest['mcpServers'],
    ...(params._meta != null ? { _meta: params._meta } : {})
  }
  if (params.replayFrom == null) return { method: 'resume', request }
  if (params.replayFrom.type === 'start') return { method: 'load', request }
  throw RequestError.invalidParams(
    { replayFrom: params.replayFrom },
    `Replaying from a ${(params.replayFrom as { type: unknown }).type} cursor is not supported`
  )
}

export function toV2ResumeSessionResponse(response: ResumeSessionResponse): v2.ResumeSessionResponse {
  return {
    ...(response.configOptions != null ? { configOptions: toV2ConfigOptions(response.configOptions) } : {}),
    ...(response._meta != null ? { _meta: response._meta } : {})
  }
}

/**
 * The v1 request a v2 `session/set_config_option` means. Only id values map:
 * the adapter's config options (model, thinking level) are select options.
 */
export function v1SetSessionConfigOptionRequest(
  params: v2.SetSessionConfigOptionRequest
): SetSessionConfigOptionRequest {
  if (!v2.SetSessionConfigOptionRequest.isId(params)) {
    throw RequestError.invalidParams({}, `Expected string value for config option: ${params.configId}`)
  }
  return {
    sessionId: params.sessionId,
    configId: params.configId,
    value: params.value,
    ...(params._meta != null ? { _meta: params._meta } : {})
  }
}

export function toV2SetSessionConfigOptionResponse(
  response: SetSessionConfigOptionResponse
): v2.SetSessionConfigOptionResponse {
  return {
    ...(response._meta != null ? { _meta: response._meta } : {}),
    configOptions: toV2ConfigOptions(response.configOptions)
  }
}

export function toV2ListSessionsResponse(response: ListSessionsResponse): v2.ListSessionsResponse {
  return {
    sessions: response.sessions.map(toV2SessionInfo),
    ...(response.nextCursor != null ? { nextCursor: response.nextCursor } : {}),
    ...(response._meta != null ? { _meta: response._meta } : {})
  }
}

function toV2SessionInfo(info: SessionInfo): v2.SessionInfo {
  return {
    sessionId: info.sessionId,
    cwd: info.cwd,
    ...(info.additionalDirectories != null ? { additionalDirectories: [...info.additionalDirectories] } : {}),
    ...(info.title != null ? { title: info.title } : {}),
    ...(info.updatedAt != null ? { updatedAt: info.updatedAt } : {})
  }
}

/**
 * v2 prompt blocks pass through: the block kinds this adapter advertises
 * (text, image, resource link, embedded resource) have the same shape in both
 * versions, and any other kind is rejected by the engine's own validation
 * with an explicit invalid-params error.
 */
export function v1PromptRequest(params: v2.PromptRequest): PromptRequest {
  return { sessionId: params.sessionId, prompt: params.prompt as ContentBlock[] }
}

/** v2 asks about a subject with its own title; v1 asks about the tool call. */
export function toV2PermissionRequest(params: RequestPermissionRequest): v2.RequestPermissionRequest {
  return {
    sessionId: params.sessionId,
    title: params.toolCall.title ?? params.toolCall.name ?? 'Permission request',
    subject: { type: 'tool_call', toolCall: params.toolCall } as v2.RequestPermissionSubject,
    options: params.options,
    ...(params._meta != null ? { _meta: params._meta } : {})
  }
}

/**
 * The v1 answer to a v2 permission response. v2 outcomes v1 does not know
 * mean no approval, which v1 expresses as `cancelled`.
 */
export function toV1PermissionResponse(response: v2.RequestPermissionResponse): RequestPermissionResponse {
  const outcome = response.outcome
  if (outcome.outcome !== 'selected') return { outcome: { outcome: 'cancelled' } }
  return {
    outcome: outcome as Extract<RequestPermissionResponse['outcome'], { outcome: 'selected' }>,
    ...(response._meta != null ? { _meta: response._meta } : {})
  }
}
