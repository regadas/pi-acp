import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import type { PiRpcProcess } from '../pi-rpc/process.js'
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
 * Thinking levels the current pi model actually supports (mirrors pi's
 * getSupportedThinkingLevels; see thinking-levels.ts). When the model is
 * unknown (state probe failed or pi reports no model) only the conservative
 * `off` level is offered: no level is ever advertised blind.
 */
function thinkingLevelsFromState(state: unknown): readonly ThinkingLevel[] {
  const model = (state as { model?: unknown } | null | undefined)?.model
  if (!model || typeof model !== 'object') return FALLBACK_THINKING_LEVELS
  const supported = supportedThinkingLevels(model)
  return supported.length ? supported : FALLBACK_THINKING_LEVELS
}

async function assertThinkingLevelSupported(proc: PiRpcProcess, level: ThinkingLevel): Promise<void> {
  let state: unknown
  try {
    state = await proc.getState()
  } catch (e) {
    // Fail closed: without state, support cannot be established, and pi would
    // silently clamp an unsupported level while we report success.
    throw RequestError.internalError(
      {},
      `Cannot verify thinking level support (get_state failed): ${String((e as Error)?.message ?? e)}`
    )
  }

  const supported = thinkingLevelsFromState(state)
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

  const applied = (state as { thinkingLevel?: unknown } | null | undefined)?.thinkingLevel
  if (applied !== level) {
    throw RequestError.internalError(
      {},
      `pi did not apply thinking level ${level} (current: ${typeof applied === 'string' ? applied : 'unknown'})`
    )
  }

  return state
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  const state = Object.prototype.hasOwnProperty.call(pre ?? {}, 'state') ? pre?.state : ((await proc.getState()) as any)

  const available = thinkingLevelsFromState(state)

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  let current: ThinkingLevel = tl && isThinkingLevel(tl) ? tl : 'off'
  // The advertised current value must be one of the advertised options: when
  // support is unknown or the reported level is outside the model's set,
  // report the conservative effective level instead of an unselectable one.
  if (!available.includes(current)) {
    current = available.includes('off') ? 'off' : (available[0] ?? 'off')
  }

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

export async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  configOptions: SessionConfigOption[]
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}> {
  // Resolve each health probe once. Missing prefetches are real RPC calls and
  // failures propagate; only a successful response with absent/unknown data
  // may produce conservative configuration.
  const hasState = Object.prototype.hasOwnProperty.call(pre ?? {}, 'state')
  const hasAvailableModels = Object.prototype.hasOwnProperty.call(pre ?? {}, 'availableModels')
  const [state, availableModels] = await Promise.all([
    hasState ? Promise.resolve(pre?.state) : proc.getState(),
    hasAvailableModels ? Promise.resolve(pre?.availableModels) : proc.getAvailableModels()
  ])
  const prefetched = { state, availableModels }
  const [models, modes] = await Promise.all([
    getModelState(proc, prefetched),
    getThinkingState(proc, { state: prefetched.state })
  ])

  return {
    configOptions: buildConfigOptions({ models, modes }),
    modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
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
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data = Object.prototype.hasOwnProperty.call(pre ?? {}, 'availableModels')
    ? pre?.availableModels
    : ((await proc.getAvailableModels()) as any)

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state = Object.prototype.hasOwnProperty.call(pre ?? {}, 'state') ? pre?.state : ((await proc.getState()) as any)

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

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
  pre?: { state?: any | null }
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc, pre)

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
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
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
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
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

  const model = (state as { model?: unknown } | null | undefined)?.model
  const appliedProvider =
    model && typeof model === 'object' ? String((model as { provider?: unknown }).provider ?? '').trim() : ''
  const appliedId = model && typeof model === 'object' ? String((model as { id?: unknown }).id ?? '').trim() : ''
  if (appliedProvider !== provider || appliedId !== modelId) {
    const current = appliedProvider && appliedId ? `${appliedProvider}/${appliedId}` : 'unknown'
    throw RequestError.internalError({}, `pi did not apply model ${provider}/${modelId} (current: ${current})`)
  }

  return state
}
