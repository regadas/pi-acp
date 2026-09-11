import { RequestError, type ToolCallContent } from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import type { PiAcpSession } from './session.js'
import {
  translateAssistantContent,
  translateCustomMessageContent,
  translateUserContent
} from './translate/pi-messages.js'
import { toolResultImageBlocks, toolResultToolCallContent } from './translate/pi-tools.js'
import { PiSessionEntriesError, walkActiveEntryBranch } from './translate/entry-walk.js'
import { toToolCallLocations, toToolKind } from './translate/tool-calls.js'
import {
  bashCommand,
  bashExitCode,
  bashOrderedContent,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'

type ReplayOptions = {
  session: PiAcpSession
  cwd: string
  supportsTerminalOutputMeta: boolean
  assertActive(): void
  sendUpdate(update: Parameters<AcpClient['sessionUpdate']>[0]): Promise<void>
}

export async function replaySessionHistory({
  session,
  cwd,
  supportsTerminalOutputMeta,
  assertActive,
  sendUpdate
}: ReplayOptions): Promise<void> {
  const proc = session.proc
  // Replay the complete raw active-branch history via pi's get_entries
  // (available on every supported pi version): unlike get_messages it
  // retains pre-compaction conversation. Capture the session's
  // custom-message sequence at the exact get_entries response boundary so
  // events written after that response cannot be mistaken for entries in
  // its snapshot.
  let customMessageBoundary = session.currentCustomMessageSequence()
  const entryData = await proc.getEntries(() => {
    customMessageBoundary = session.currentCustomMessageSequence()
  })
  assertActive()

  let entries: ReturnType<typeof walkActiveEntryBranch>
  try {
    entries = walkActiveEntryBranch(entryData)
  } catch (error) {
    if (error instanceof PiSessionEntriesError) {
      throw RequestError.internalError({}, `Cannot replay session history: ${error.message}`)
    }
    throw error
  }

  // Conversation records on the active branch, in order. `message` entries
  // carry pi AgentMessages directly; `custom_message` entries are
  // normalized to the CustomMessage shape live `message_end` events use so
  // custom-identity reconciliation sees one consistent format. Internal
  // entries (compaction, branch_summary, thinking/model changes, labels,
  // session_info, extension custom state) are not conversation: the
  // original pre-compaction messages remain on the path, so replaying
  // compaction summaries as well would duplicate history.
  const records: Array<{ entryId: string; message: Record<string, unknown> }> = []
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
      records.push({ entryId: entry.id, message: entry.message as Record<string, unknown> })
    } else if (entry.type === 'custom_message') {
      records.push({
        entryId: entry.id,
        message: {
          role: 'custom',
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: entry.timestamp
        }
      })
    }
  }

  session.reconcileLoadedCustomMessages(
    records.map(record => record.message),
    customMessageBoundary
  )

  const replayedToolCallIds = new Set<string>()
  // Assistant tool calls that never see a durable toolResult on the
  // branch; closed as failed after the walk (see below).
  const openToolCalls = new Map<string, { isBash: boolean }>()

  for (const { entryId, message: m } of records) {
    const role = String(m?.role ?? '')

    if (role === 'user') {
      for (const block of translateUserContent(m?.content)) {
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content:
              block.kind === 'text'
                ? { type: 'text', text: block.text }
                : { type: 'image', data: block.data, mimeType: block.mimeType }
          }
        })
      }
      continue
    }

    if (role === 'assistant') {
      for (const block of translateAssistantContent(m?.content)) {
        if (block.kind === 'text') {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: block.text }
            }
          })
          continue
        }

        if (block.kind === 'thinking') {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: block.text }
            }
          })
          continue
        }

        // Reconstruct the tool call from the assistant block; the matching
        // toolResult later upgrades it to its terminal status.
        replayedToolCallIds.add(block.toolCallId)
        const isBash = isBashTool(block.toolName)
        openToolCalls.set(block.toolCallId, { isBash })
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: block.toolCallId,
            title: isBash ? (bashCommand(block.rawInput) ?? block.toolName) : block.toolName,
            kind: isBash ? 'execute' : toToolKind(block.toolName),
            status: 'pending',
            rawInput: block.rawInput,
            locations: toToolCallLocations(block.toolName, block.rawInput, cwd),
            ...(isBash && supportsTerminalOutputMeta
              ? {
                  content: bashTerminalContent(block.toolCallId),
                  _meta: bashTerminalInfoMeta(block.toolCallId, cwd)
                }
              : {})
          }
        })
      }
      continue
    }

    if (role === 'custom') {
      if (m?.display !== true) continue
      for (const block of translateCustomMessageContent(m?.content)) {
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content:
              block.kind === 'text'
                ? { type: 'text', text: block.text }
                : { type: 'image', data: block.data, mimeType: block.mimeType }
          }
        })
      }
      continue
    }

    if (role === 'toolResult') {
      const toolName = String(m?.toolName ?? 'tool')
      const toolCallId = typeof m?.toolCallId === 'string' && m.toolCallId ? m.toolCallId : `pi-load-${entryId}`
      const isError = Boolean(m?.isError)
      const alreadyReplayed = replayedToolCallIds.has(toolCallId)
      replayedToolCallIds.add(toolCallId)
      openToolCalls.delete(toolCallId)

      if (isBashTool(toolName)) {
        if (!alreadyReplayed) {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'in_progress',
              ...(supportsTerminalOutputMeta
                ? {
                    content: bashTerminalContent(toolCallId),
                    _meta: bashTerminalInfoMeta(toolCallId, cwd)
                  }
                : {})
            }
          })
        }

        const text = bashResultText(m)
        // Binary image blocks cannot travel through terminal output text;
        // preserve them as standard image content on both bash paths.
        // The generic path keeps text and images in source order.
        const bashImages: ToolCallContent[] = toolResultImageBlocks(m).map(image => ({
          type: 'content',
          content: { type: 'image', data: image.data, mimeType: image.mimeType }
        }))
        const genericContent = bashOrderedContent(m)
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            ...(supportsTerminalOutputMeta
              ? {
                  ...(bashImages.length ? { content: [...bashTerminalContent(toolCallId), ...bashImages] } : {}),
                  _meta: {
                    ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                    ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
                  }
                }
              : genericContent.length
                ? { content: genericContent }
                : {})
          }
        })
        continue
      }

      if (!alreadyReplayed) {
        // No assistant toolCall block preceded this result (e.g. older
        // session data). Synthesize the initial call so the terminal
        // status transition stays monotonic.
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            rawInput: null
          }
        })
      }

      const content: ToolCallContent[] = toolResultToolCallContent(m)
      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content: content.length ? content : null,
          rawOutput: m
        }
      })
      continue
    }

    if (role === 'bashExecution') {
      // pi `!command` shell executions: replay as a synthetic execute tool
      // call keyed from the durable entry id.
      const toolCallId = `pi-bash-${entryId}`
      const cancelled = m?.cancelled === true
      const output = bashResultText(m)
      const exitCode = bashExitCode(m, cancelled)
      const failed = cancelled || exitCode !== 0

      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: bashCommand(m) ?? 'bash',
          kind: 'execute',
          status: 'in_progress',
          ...(supportsTerminalOutputMeta
            ? {
                content: bashTerminalContent(toolCallId),
                _meta: bashTerminalInfoMeta(toolCallId, cwd)
              }
            : {})
        }
      })

      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: failed ? 'failed' : 'completed',
          ...(supportsTerminalOutputMeta
            ? {
                _meta: {
                  ...(output ? bashTerminalOutputMeta(toolCallId, output) : {}),
                  ...bashTerminalExitMeta(toolCallId, exitCode)
                }
              }
            : (() => {
                const content = bashOrderedContent(m)
                return content.length ? { content } : {}
              })())
        }
      })
      continue
    }
  }

  // Latest Zed renders a replayed tool call with no terminal status as a
  // spinner forever. A durable history that ends mid-call has no result to
  // replay, so close such calls as failed with a standard explanation.
  // Live sessions are unaffected: this runs only on load replay.
  for (const [toolCallId, metadata] of openToolCalls) {
    const explanation: ToolCallContent = {
      type: 'content',
      content: {
        type: 'text',
        text: 'No result was recorded for this tool call; the session ended before it completed.'
      }
    }
    const terminalSettlement = metadata.isBash && supportsTerminalOutputMeta
    await sendUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: terminalSettlement ? [...bashTerminalContent(toolCallId), explanation] : [explanation],
        ...(terminalSettlement ? { _meta: bashTerminalExitMeta(toolCallId, 1) } : {})
      }
    })
  }
}
