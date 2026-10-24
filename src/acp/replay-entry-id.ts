/**
 * The retained history entry a replayed chunk belongs to, attached by the
 * load replay to each chunk update it emits. It travels as a symbol-keyed
 * property: JSON serialization drops symbol keys, so the v1 wire stays
 * byte-identical, and only the v2 chain reads it — to deliver one message per
 * retained entry instead of one per chunk.
 */
export const replayEntryId = Symbol('pi-acp.replayEntryId')
