import type { SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk/unstable'

const MAX_FIELD_COMPARE_CHARS = 16_384

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type InitialToolCallParams = {
  toolCallId: string
  name?: string | null
  title: string
  kind: ToolKind
  status: 'pending' | 'in_progress'
  locations?: ToolCallLocation[]
  rawInput?: unknown
  content?: ToolCallContent[]
  _meta?: Record<string, unknown>
}

export type ToolCallDeltaPatch = {
  status?: ToolCallStatus
  kind?: ToolKind
  title?: string
  locations?: ToolCallLocation[]
  clearLocations?: boolean
  rawInput?: unknown
  rawOutput?: unknown
  content?: ToolCallContent[]
  _meta?: Record<string, unknown>
}

type EmittedToolCallState = {
  status: ToolCallStatus
  kind: ToolKind
  title: string
  hasLocations: boolean
  locationsKey?: string
  rawInputRef?: unknown
  rawInputKey?: string | null
  rawOutputRef?: unknown
  rawOutputKey?: string | null
  hadDiffPreview: boolean
  lastDiffContent?: ToolCallContent[]
}

function exceedsFieldBudget(value: unknown, budget: { remaining: number }, seen: Set<object>): boolean {
  if (budget.remaining < 0) return true
  if (value === null) return (budget.remaining -= 4) < 0
  if (value === undefined) return false
  if (typeof value === 'string') return (budget.remaining -= value.length + 2) < 0
  if (typeof value === 'boolean') return (budget.remaining -= value ? 4 : 5) < 0
  if (typeof value === 'number') return (budget.remaining -= String(value).length) < 0
  if (typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    budget.remaining -= 2
    if (Array.isArray(value)) {
      if (value.length > 1) budget.remaining -= value.length - 1
      for (const item of value) {
        if (exceedsFieldBudget(item, budget, seen)) return true
      }
      return budget.remaining < 0
    }
    for (const [k, v] of Object.entries(value)) {
      budget.remaining -= k.length + 3
      if (exceedsFieldBudget(v, budget, seen)) return true
    }
    return budget.remaining < 0
  } finally {
    seen.delete(value)
  }
}

export function boundedFieldKey(value: unknown): string | null {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return value.length <= MAX_FIELD_COMPARE_CHARS ? JSON.stringify(value) : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (exceedsFieldBudget(value, { remaining: MAX_FIELD_COMPARE_CHARS }, new Set())) return null
  try {
    const serialized = JSON.stringify(value)
    return serialized && serialized.length <= MAX_FIELD_COMPARE_CHARS ? serialized : null
  } catch {
    return null
  }
}

export function sameBoundedField(
  next: unknown,
  nextKey: string | null,
  prev: unknown,
  prevKey: string | null | undefined
): boolean {
  if (Object.is(next, prev)) return true
  if (nextKey !== null && prevKey !== null && prevKey !== undefined) return nextKey === prevKey
  return false
}

export function resultHasDetailsDiff(result: unknown): boolean {
  const diff = (result as { details?: { diff?: unknown } } | null | undefined)?.details?.diff
  return typeof diff === 'string' && diff.trim().length > 0
}

export class ToolCallStateTracker {
  private readonly states = new Map<string, EmittedToolCallState>()

  begin(params: InitialToolCallParams): Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> {
    const locations = params.locations?.length ? params.locations : undefined
    const name = params.name || undefined
    const rawInputKey = params.rawInput !== undefined ? boundedFieldKey(params.rawInput) : undefined
    this.states.set(params.toolCallId, {
      status: params.status,
      kind: params.kind,
      title: params.title,
      hasLocations: Boolean(locations),
      locationsKey: locations ? JSON.stringify(locations) : undefined,
      rawInputRef: params.rawInput,
      rawInputKey,
      hadDiffPreview: false
    })
    return {
      sessionUpdate: 'tool_call',
      toolCallId: params.toolCallId,
      ...(name ? { name } : {}),
      title: params.title,
      kind: params.kind,
      status: params.status,
      ...(locations ? { locations } : {}),
      ...(params.rawInput === undefined ? {} : { rawInput: params.rawInput }),
      ...(params.content?.length ? { content: params.content } : {}),
      ...(params._meta && Object.keys(params._meta).length ? { _meta: params._meta } : {})
    }
  }

  delta(
    toolCallId: string,
    patch: ToolCallDeltaPatch
  ): Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> | null {
    const state = this.states.get(toolCallId)
    if (!state) return null
    if (state.status === 'completed' || state.status === 'failed') return null

    const update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> = {
      sessionUpdate: 'tool_call_update',
      toolCallId
    }
    let changed = false

    if (patch.status !== undefined && patch.status !== state.status) {
      const downgrade = state.status === 'in_progress' && patch.status === 'pending'
      if (!downgrade) {
        update.status = patch.status
        state.status = patch.status
        changed = true
      }
    }

    if (patch.kind !== undefined && patch.kind !== state.kind) {
      update.kind = patch.kind
      state.kind = patch.kind
      changed = true
    }

    if (patch.title !== undefined && patch.title !== state.title) {
      update.title = patch.title
      state.title = patch.title
      changed = true
    }

    if (patch.locations?.length) {
      const key = JSON.stringify(patch.locations)
      if (key !== state.locationsKey) {
        update.locations = patch.locations
        state.locationsKey = key
        state.hasLocations = true
        changed = true
      }
    } else if (patch.clearLocations && state.hasLocations) {
      update.locations = []
      state.locationsKey = undefined
      state.hasLocations = false
      changed = true
    }

    if (patch.rawInput !== undefined) {
      const nextKey = boundedFieldKey(patch.rawInput)
      if (!sameBoundedField(patch.rawInput, nextKey, state.rawInputRef, state.rawInputKey)) {
        update.rawInput = patch.rawInput
        state.rawInputRef = patch.rawInput
        state.rawInputKey = nextKey
        changed = true
      }
    }

    if (patch.rawOutput !== undefined) {
      const nextKey = boundedFieldKey(patch.rawOutput)
      if (!sameBoundedField(patch.rawOutput, nextKey, state.rawOutputRef, state.rawOutputKey)) {
        update.rawOutput = patch.rawOutput
        state.rawOutputRef = patch.rawOutput
        state.rawOutputKey = nextKey
        changed = true
      }
    }

    if (patch.content !== undefined) {
      update.content = patch.content
      changed = true
    }

    if (patch._meta && Object.keys(patch._meta).length) {
      update._meta = patch._meta
      changed = true
    }

    return changed ? update : null
  }

  recordDiffPreview(toolCallId: string, content: ToolCallContent[]): void {
    const state = this.states.get(toolCallId)
    if (state && content.length) {
      state.hadDiffPreview = true
      state.lastDiffContent = content
    }
  }

  getDiffPreview(toolCallId: string): { hadDiffPreview: boolean; lastDiffContent?: ToolCallContent[] } | undefined {
    const state = this.states.get(toolCallId)
    if (!state) return undefined
    return { hadDiffPreview: state.hadDiffPreview, lastDiffContent: state.lastDiffContent }
  }

  delete(toolCallId: string): void {
    this.states.delete(toolCallId)
  }

  clear(): void {
    this.states.clear()
  }
}
