import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import type { PiRpcProcess } from '../pi-rpc/process.js'
import { piRecord } from '../pi-rpc/protocol.js'
import {
  FALLBACK_THINKING_LEVELS,
  isThinkingLevel,
  supportedThinkingLevels,
  type ThinkingLevel
} from './thinking-levels.js'

type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

export const MODEL_CONFIG_ID = 'model'
export const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

/**
 * Values pi already handed the caller (e.g. the parallel newSession probes);
 * a present own property — even `undefined` — suppresses the matching RPC.
 */
type PrefetchedConfig = {
  readonly state?: unknown
  readonly availableModels?: unknown
}

/** pi get_available_models payloads are untrusted; only the models array is consumed. */
export function piModelsList(payload: unknown): readonly unknown[] {
  const models = piRecord(payload).models
  return Array.isArray(models) ? models : []
}

/**
 * Thinking levels the current pi model actually supports. When the model is
 * unknown only the conservative `off` level is offered: no level is ever
 * advertised blind.
 */
function thinkingLevelsFromState(state: unknown): readonly ThinkingLevel[] {
  const model = piRecord(state).model
  if (!model || typeof model !== 'object') return FALLBACK_THINKING_LEVELS
  const supported = supportedThinkingLevels(model)
  return supported.length ? supported : FALLBACK_THINKING_LEVELS
}

async function availableThinkingLevels(proc: PiRpcProcess, state: unknown): Promise<readonly ThinkingLevel[]> {
  if (typeof proc.getAvailableThinkingLevels !== 'function') return thinkingLevelsFromState(state)
  try {
    const data = (await proc.getAvailableThinkingLevels()) as { levels?: unknown } | unknown[]
    const raw = Array.isArray(data) ? data : Array.isArray(data?.levels) ? data.levels : []
    return raw.filter((level): level is ThinkingLevel => typeof level === 'string' && isThinkingLevel(level))
  } catch (error) {
    if ((error as Error & { unsupportedCommand?: boolean }).unsupportedCommand) return thinkingLevelsFromState(state)
    throw error
  }
}

async function assertThinkingLevelSupported(proc: PiRpcProcess, level: ThinkingLevel): Promise<void> {
  let state: unknown
  try {
    state = await proc.getState()
  } catch (e) {
    throw RequestError.internalError(
      {},
      `Cannot verify thinking level support (get_state failed): ${String((e as Error)?.message ?? e)}`
    )
  }

  const supported = await availableThinkingLevels(proc, state)
  if (!supported.includes(level)) {
    throw RequestError.invalidParams(
      {},
      `Thinking level not supported by the current model: ${level} (supported: ${supported.join(', ')})`
    )
  }
}

/**
 * Apply a thinking level and verify it against pi's authoritative post-write
 * state. pi clamps unsupported levels silently (e.g. after a concurrent model
 * change), so success is only reported when the level actually stuck.
 * Returns the verified state for config-option publication.
 */
export async function applyThinkingLevel(proc: PiRpcProcess, level: ThinkingLevel): Promise<unknown> {
  await assertThinkingLevelSupported(proc, level)
  await proc.setThinkingLevel(level)

  let state: unknown
  try {
    state = await proc.getState()
  } catch (e) {
    throw RequestError.internalError(
      {},
      `Could not verify the thinking level after set_thinking_level: ${String((e as Error)?.message ?? e)}`
    )
  }

  const applied = piRecord(state).thinkingLevel
  if (applied !== level) {
    throw RequestError.internalError(
      {},
      `pi did not apply thinking level ${level} (current: ${typeof applied === 'string' ? applied : 'unknown'})`
    )
  }

  return state
}

type ThoughtLevelState = {
  available: readonly ThinkingLevel[]
  current: ThinkingLevel
}

async function getThoughtLevelState(proc: PiRpcProcess, pre?: PrefetchedConfig): Promise<ThoughtLevelState> {
  const state = Object.hasOwn(pre ?? {}, 'state') ? pre?.state : await proc.getState()

  const available = await availableThinkingLevels(proc, state)

  const reported = piRecord(state).thinkingLevel
  let current: ThinkingLevel = typeof reported === 'string' && isThinkingLevel(reported) ? reported : 'off'
  // The advertised current must be one of the advertised options: report the
  // conservative effective level when it is not.
  if (!available.includes(current)) {
    current = available.includes('off') ? 'off' : (available[0] ?? 'off')
  }

  return { available, current }
}

export async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: PrefetchedConfig
): Promise<SessionConfigOption[]> {
  // Missing prefetches are real RPC calls and failures propagate; only a
  // successful response with absent/unknown data may produce conservative
  // configuration.
  const hasState = Object.hasOwn(pre ?? {}, 'state')
  const hasAvailableModels = Object.hasOwn(pre ?? {}, 'availableModels')
  const [state, availableModels] = await Promise.all([
    hasState ? Promise.resolve(pre?.state) : proc.getState(),
    hasAvailableModels ? Promise.resolve(pre?.availableModels) : proc.getAvailableModels()
  ])
  const prefetched = { state, availableModels }
  const [models, thoughtLevel] = await Promise.all([
    getModelState(proc, prefetched),
    getThoughtLevelState(proc, { state: prefetched.state })
  ])

  return buildConfigOptions({ models, thoughtLevel })
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  thoughtLevel: ThoughtLevelState
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.thoughtLevel.current,
      options: state.thoughtLevel.available.map(level => ({
        value: level,
        name: `Thinking: ${level}`,
        description: null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: PrefetchedConfig
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  const data = Object.hasOwn(pre ?? {}, 'availableModels') ? pre?.availableModels : await proc.getAvailableModels()

  // String coercion, not schema validation: only a trimmed provider/id must be
  // non-empty for an entry to be advertised.
  const availableModels: AdvertisedModel[] = piModelsList(data)
    .map(entry => {
      const record = piRecord(entry)
      const provider = String(record.provider ?? '').trim()
      const id = String(record.id ?? '').trim()
      if (!provider || !id) return null
      const name = String(record.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(model => model !== null)

  const state = Object.hasOwn(pre ?? {}, 'state') ? pre?.state : await proc.getState()

  const model = piRecord(piRecord(state).model)
  const provider = String(model.provider ?? '').trim()
  const id = String(model.id ?? '').trim()
  const currentModelId = provider && id ? `${provider}/${id}` : null

  if (!availableModels.length && !currentModelId) return null

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

/**
 * Narrow publication sink. PiAcpSession implements it and serializes every
 * update behind one delivery queue, so mutation publications and event-driven
 * syncs share a single total order instead of racing on the raw connection.
 */
export type SessionUpdateSink = {
  sendSessionUpdate(params: Parameters<AcpClient['sessionUpdate']>[0]): Promise<void>
}

export async function emitConfigOptionsUpdate(
  sink: SessionUpdateSink,
  sessionId: string,
  proc: PiRpcProcess,
  pre?: PrefetchedConfig
): Promise<SessionConfigOption[]> {
  const configOptions = await getSessionConfiguration(proc, pre)

  await sink.sendSessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

/**
 * Apply a model change and verify it against pi's authoritative post-write
 * state before success is reported. Returns the verified state for
 * config-option publication.
 */
export async function applySessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<unknown> {
  // Accept "provider/model" (preferred, matching how models are advertised) or
  // a bare "model" resolved through the available models.
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [candidateProvider, ...rest] = requestedModelId.split('/')
    provider = candidateProvider
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const found = piModelsList(await proc.getAvailableModels()).find(entry => String(piRecord(entry).id) === modelId)
    if (found) {
      const record = piRecord(found)
      provider = String(record.provider)
      modelId = String(record.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams({}, `Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)

  let state: unknown
  try {
    state = await proc.getState()
  } catch (e) {
    throw RequestError.internalError(
      {},
      `Could not verify the model after set_model: ${String((e as Error)?.message ?? e)}`
    )
  }

  const appliedModel = piRecord(piRecord(state).model)
  const appliedProvider = String(appliedModel.provider ?? '').trim()
  const appliedId = String(appliedModel.id ?? '').trim()
  if (appliedProvider !== provider || appliedId !== modelId) {
    const current = appliedProvider && appliedId ? `${appliedProvider}/${appliedId}` : 'unknown'
    throw RequestError.internalError({}, `pi did not apply model ${provider}/${modelId} (current: ${current})`)
  }

  return state
}
