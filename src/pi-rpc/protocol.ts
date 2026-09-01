export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'abort' | 'get_state' | 'get_available_models' | 'get_available_thinking_levels'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  | { type: 'set_thinking_level'; id?: string; level: PiThinkingLevel }
  | { type: 'set_follow_up_mode' | 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  | { type: 'get_session_stats' | 'get_entries' | 'get_commands'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }

export type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export type PiAssistantMessageEvent =
  | { type: 'text_delta' | 'thinking_delta'; delta: string; contentIndex?: number }
  | { type: 'toolcall_start'; contentIndex?: number; id?: string; toolName?: string; toolCall?: unknown }
  | {
      type: 'toolcall_delta'
      contentIndex?: number
      id?: string
      toolName?: string
      delta?: string
      argumentsDelta?: string
      toolCall?: unknown
    }
  | { type: 'toolcall_end'; contentIndex?: number; id?: string; toolName?: string; toolCall?: unknown }
  | { type: 'done'; reason?: string; usage?: unknown }
  | { type: 'error'; reason?: string; error?: { errorMessage?: unknown } }
  | { type: string; [key: string]: unknown }

export type PiRpcEvent = {
  type: string
  [key: string]: unknown
} & (
  | { type: 'message_update'; assistantMessageEvent?: PiAssistantMessageEvent }
  | { type: 'extension_ui_request'; id?: string; method?: string }
  | { type: 'ignored'; originalType?: string }
  | { type: string }
)

export type DecodedPiRecord = PiRpcResponse | PiRpcEvent

const KNOWN_EVENTS = new Set([
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'extension_ui_request',
  'queue_update',
  'session_info_changed',
  'thinking_level_changed',
  'auto_retry_start',
  'auto_retry_end',
  'auto_compaction_start',
  'auto_compaction_end',
  'compaction_start',
  'compaction_end'
])

/** Decode untrusted NDJSON once; malformed records are ignored explicitly. */
export function decodePiRecord(value: unknown): DecodedPiRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type === 'response') {
    if (typeof record.command !== 'string' || typeof record.success !== 'boolean') return null
    return {
      type: 'response',
      id: typeof record.id === 'string' ? record.id : undefined,
      command: record.command,
      success: record.success,
      data: record.data,
      error: typeof record.error === 'string' ? record.error : undefined
    }
  }
  if (typeof record.type !== 'string') return null
  if (!KNOWN_EVENTS.has(record.type)) return { type: 'ignored', originalType: record.type }
  return record as PiRpcEvent
}
