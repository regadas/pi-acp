export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Levels advertised when the current model is unknown (state probe failed or
 * pi reported no model). Support cannot be established, so only the
 * conservative `off` level is offered: advertising levels blind would let a
 * client select one pi then silently clamps.
 */
export const FALLBACK_THINKING_LEVELS: readonly ThinkingLevel[] = ['off']

export function isThinkingLevel(x: string): x is ThinkingLevel {
  return (ALL_THINKING_LEVELS as readonly string[]).includes(x)
}

/**
 * Mirror of pi's `getSupportedThinkingLevels` (pi-ai models.ts, pi 0.80.10):
 * - non-reasoning models support only `off`;
 * - base levels (off..high) are supported unless thinkingLevelMap[level] is null;
 * - `xhigh` and `max` require a defined, non-null thinkingLevelMap entry, so an
 *   absent map yields only the base levels.
 */
export function supportedThinkingLevels(model: unknown): ThinkingLevel[] {
  const record = model as { reasoning?: unknown; thinkingLevelMap?: unknown } | null | undefined
  if (record?.reasoning !== true) return ['off']

  const map =
    record.thinkingLevelMap && typeof record.thinkingLevelMap === 'object'
      ? (record.thinkingLevelMap as Record<string, unknown>)
      : undefined

  return ALL_THINKING_LEVELS.filter(level => {
    const mapped = map?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}
