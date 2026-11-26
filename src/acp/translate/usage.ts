import type { SessionUpdate, Usage } from '@agentclientprotocol/sdk/unstable'
import type { PiRpcEvent } from '../../pi-rpc/process.js'
import type { PiAssistantMessageEvent } from '../../pi-rpc/protocol.js'

export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function extractPiUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as {
    input?: unknown
    output?: unknown
    cacheRead?: unknown
    cacheWrite?: unknown
    totalTokens?: unknown
    total?: unknown
    inputTokens?: unknown
    outputTokens?: unknown
    cachedReadTokens?: unknown
    cachedWriteTokens?: unknown
    thoughtTokens?: unknown
  }
  const inputTokens = finiteNonNegative(u.input ?? u.inputTokens)
  const outputTokens = finiteNonNegative(u.output ?? u.outputTokens)
  const cachedReadTokens = finiteNonNegative(u.cacheRead ?? u.cachedReadTokens)
  const cachedWriteTokens = finiteNonNegative(u.cacheWrite ?? u.cachedWriteTokens)
  const thoughtTokens = finiteNonNegative(u.thoughtTokens)
  const explicitTotal = finiteNonNegative(u.totalTokens ?? u.total)
  if (inputTokens === undefined || outputTokens === undefined) return null
  const totalTokens = explicitTotal ?? inputTokens + outputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return null
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {})
  }
}

export function extractPiEventUsage(ev: PiRpcEvent, ame: PiAssistantMessageEvent | undefined): Usage | null {
  const evMessage = (ev as { message?: { role?: unknown; usage?: unknown } }).message
  if (evMessage?.role === 'assistant') {
    const u = extractPiUsage(evMessage.usage)
    if (u) return u
  }
  const ameRecord = ame as { usage?: unknown; message?: { usage?: unknown }; partial?: { usage?: unknown } } | undefined
  return extractPiUsage(ameRecord?.usage ?? ameRecord?.message?.usage ?? ameRecord?.partial?.usage)
}

export function addUsage(base: Usage | null, next: Usage): Usage {
  if (!base) return { ...next }
  const cachedReadTokens =
    base.cachedReadTokens !== undefined || next.cachedReadTokens !== undefined
      ? (base.cachedReadTokens ?? 0) + (next.cachedReadTokens ?? 0)
      : undefined
  const cachedWriteTokens =
    base.cachedWriteTokens !== undefined || next.cachedWriteTokens !== undefined
      ? (base.cachedWriteTokens ?? 0) + (next.cachedWriteTokens ?? 0)
      : undefined
  const thoughtTokens =
    base.thoughtTokens !== undefined || next.thoughtTokens !== undefined
      ? (base.thoughtTokens ?? 0) + (next.thoughtTokens ?? 0)
      : undefined
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    totalTokens: base.totalTokens + next.totalTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {})
  }
}

export function combineOwnedTurnUsage(completed: Usage | null, current: Usage | null): Usage | undefined {
  if (completed && current) return addUsage(completed, current)
  return completed ?? current ?? undefined
}

export type ParsedSessionStatsUsage = {
  usageUpdate?: {
    update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>
    dedupKey: string
  }
  usage?: Usage
}

export function parseSessionStatsUsage(stats: unknown): ParsedSessionStatsUsage {
  if (!stats || typeof stats !== 'object') return {}
  const record = stats as {
    tokens?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown }
    cost?: unknown
    contextUsage?: { tokens?: unknown; contextWindow?: unknown }
  }

  let usageUpdate: ParsedSessionStatsUsage['usageUpdate']
  const used = finiteNonNegative(record.contextUsage?.tokens)
  const size = finiteNonNegative(record.contextUsage?.contextWindow)
  if (used !== undefined && size !== undefined) {
    const amount = finiteNonNegative(record.cost)
    usageUpdate = {
      dedupKey: `${used}:${size}:${amount ?? ''}`,
      update: {
        sessionUpdate: 'usage_update',
        used,
        size,
        ...(amount === undefined ? {} : { cost: { amount, currency: 'USD' } })
      }
    }
  }

  let usage: Usage | undefined
  const inputTokens = finiteNonNegative(record.tokens?.input)
  const outputTokens = finiteNonNegative(record.tokens?.output)
  const totalTokens = finiteNonNegative(record.tokens?.total)
  if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined) {
    const cachedReadTokens = finiteNonNegative(record.tokens?.cacheRead)
    const cachedWriteTokens = finiteNonNegative(record.tokens?.cacheWrite)
    usage = {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
      ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {})
    }
  }

  return {
    ...(usageUpdate ? { usageUpdate } : {}),
    ...(usage ? { usage } : {})
  }
}
