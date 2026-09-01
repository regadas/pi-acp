import { RequestError, type AvailableCommand, type PromptResponse } from '@agentclientprotocol/sdk'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandContext, PiAcpSession } from './session.js'

export function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    { name: 'autocompact', description: 'Toggle automatic context compaction', input: { hint: 'on|off|toggle' } },
    { name: 'export', description: 'Export session to an HTML file in the session cwd' },
    { name: 'session', description: 'Show session stats (messages, tokens, cost, session file)' },
    { name: 'name', description: 'Set session display name', input: { hint: '<name>' } },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    }
  ]
}

const AUTOCOMPACT_ON_ALIASES = new Set(['on', 'true', 'enable', 'enabled'])
const AUTOCOMPACT_OFF_ALIASES = new Set(['off', 'false', 'disable', 'disabled'])
const EXPORT_PREFLIGHT_LIMIT = 64 * 1024

async function hasExportableSessionFile(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(EXPORT_PREFLIGHT_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').trim().length > 0
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function runBuiltinCommand(
  session: PiAcpSession,
  cmd: string,
  args: string[],
  ctx: CommandContext
): Promise<PromptResponse> {
  if (cmd === 'compact') {
    const customInstructions = args.join(' ').trim() || undefined
    const res = await session.proc.compact(customInstructions)

    const r: any = res && typeof res === 'object' ? (res as any) : null
    const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
    const summary = typeof r?.summary === 'string' ? r.summary : null

    const headerLines = [
      `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
      tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
    ].filter(Boolean)

    const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'session') {
    const stats = (await session.proc.getSessionStats()) as any

    const lines: string[] = []
    if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
    if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
    if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

    if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

    const t = stats?.tokens
    if (t && typeof t === 'object') {
      const parts: string[] = []
      if (typeof t.input === 'number') parts.push(`in ${t.input}`)
      if (typeof t.output === 'number') parts.push(`out ${t.output}`)
      if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
      if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
      if (typeof t.total === 'number') parts.push(`total ${t.total}`)
      if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
    }

    // Fallback if stats shape changes.
    const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'name') {
    const name = args.join(' ').trim()
    if (!name) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Usage: /name <name>' }
        }
      })
      return { stopReason: 'end_turn' }
    }

    try {
      await session.proc.setSessionName(name)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      const hint = /set_session_name/i.test(msg)
        ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
        : ''

      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
        }
      })
      return { stopReason: 'end_turn' }
    }

    // The title publication bypasses the command sink, so a cancelled
    // command must not rename the session on the client either. The predicate
    // is re-checked inside the serialized publication queue, where this can
    // wait behind unrelated session-info work.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.syncSessionInfo(name, ctx.cancelled)

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Session name set: ${name}` }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'steering') {
    const modeRaw = String(args[0] ?? '').toLowerCase()
    const state = (await session.proc.getState()) as any
    const current = String(state?.steeringMode ?? '')

    // If no arg, just report current.
    if (!modeRaw) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Steering mode: ${current || 'unknown'}`
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Usage: /steering all | /steering one-at-a-time'
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    // Cancellation landed while pi's state was being read: settle as
    // cancelled instead of applying a mutation nobody is waiting for.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'follow-up') {
    const modeRaw = String(args[0] ?? '').toLowerCase()
    const state = (await session.proc.getState()) as any
    const current = String(state?.followUpMode ?? '')

    // If no arg, just report current.
    if (!modeRaw) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Follow-up mode: ${current || 'unknown'}`
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Usage: /follow-up all | /follow-up one-at-a-time'
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'export') {
    // For now we always export into the session cwd and do not accept a user-provided path.
    // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
    // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
    // (no id), which would otherwise hang our request. So we guard here.
    const state = (await session.proc.getState()) as any
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
    const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

    if (!sessionFile || messageCount === 0 || !(await hasExportableSessionFile(sessionFile))) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Nothing to export yet (no session messages). Send a prompt first.'
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

    // Cancellation landed during the pre-export probes: do not write an
    // export file for a command that already settled as cancelled.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }

    let resultPath = ''
    try {
      const result = await session.proc.exportHtml(outputPath)
      resultPath = result.path
    } catch (e: any) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Export failed: ${String(e?.message ?? e)}`
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    if (!resultPath) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Export failed: no output path returned by pi.'
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    const uri = pathToFileURL(resultPath).href

    // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
    // assistant message, so this avoids the "link + duplicate plain text" look.
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Session exported: '
        }
      }
    })

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource_link',
          name: `pi-session-${safeSessionId}.html`,
          uri,
          mimeType: 'text/html',
          title: 'Session exported'
        }
      }
    })

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'autocompact') {
    const mode = (args[0] ?? 'toggle').toLowerCase()
    let enabled: boolean

    if (AUTOCOMPACT_ON_ALIASES.has(mode)) {
      enabled = true
    } else if (AUTOCOMPACT_OFF_ALIASES.has(mode)) {
      enabled = false
    } else if (mode === 'toggle') {
      const state = (await session.proc.getState()) as any
      enabled = !state?.autoCompactionEnabled
    } else {
      // An unrecognized argument is a typo, not a toggle: report usage
      // instead of silently flipping the setting.
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Unknown argument: ${args[0]}. Usage: /autocompact on | off | toggle`
          }
        }
      })
      return { stopReason: 'end_turn' }
    }

    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.proc.setAutoCompaction(enabled)

    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
        }
      }
    })

    return { stopReason: 'end_turn' }
  }

  // Callers gate on BUILTIN_COMMAND_NAMES, so this is unreachable.
  throw RequestError.internalError({ command: cmd }, `Unhandled builtin command: /${cmd}`)
}
