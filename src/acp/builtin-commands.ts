import { RequestError, type AvailableCommand, type PromptResponse } from '@agentclientprotocol/sdk/unstable'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandContext, PiAcpSession } from './session.js'
import { piRecord } from '../pi-rpc/protocol.js'

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
    },
    {
      name: 'model',
      description:
        'Guidance only: pick the model from your ACP client session settings (the standard model config option)'
    },
    {
      name: 'thinking',
      description:
        'Guidance only: set the thinking level from your ACP client session settings (the standard thought_level config option)'
    },
    { name: 'clear', description: 'Not implemented; start a new session from your ACP client instead' }
  ]
}

// Documented client-control pointers (README / adapter-reference): answered
// locally, so their text never reaches pi as a prompt for the provider.
const GUIDANCE_ONLY_COMMANDS: Record<string, string> = {
  model:
    'Model selection is owned by your ACP client\'s session settings (the standard "model" session config option); pick the model from your client\'s controls.',
  thinking:
    'Thinking level is owned by your ACP client\'s session settings (the standard "thought_level" session config option); set it from your client\'s controls.',
  clear: '/clear is not implemented. Start a new session from your ACP client instead.'
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

/**
 * `rawArgs` is the unparsed remainder after the command name, preserved
 * verbatim for free-text commands (/name, /compact) so apostrophes, quotes
 * and spacing survive; `args` stays tokenized for option-style commands.
 */
export async function runBuiltinCommand(
  session: PiAcpSession,
  cmd: string,
  args: string[],
  ctx: CommandContext,
  rawArgs: string
): Promise<PromptResponse> {
  const say = (text: string) =>
    ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    })

  const guidance = GUIDANCE_ONLY_COMMANDS[cmd]
  if (guidance) {
    await say(guidance)

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'compact') {
    const customInstructions = rawArgs.trim() || undefined
    const res = await session.proc.compact(customInstructions)

    const r = res && typeof res === 'object' ? (res as { tokensBefore?: unknown; summary?: unknown }) : null
    const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
    const summary = typeof r?.summary === 'string' ? r.summary : null

    const headerLines = [
      `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
      tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
    ].filter(Boolean)

    const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

    await say(text)

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'session') {
    const stats = await session.proc.getSessionStats()
    const record = piRecord(stats)

    const lines: string[] = []
    if (record.sessionId) lines.push(`Session: ${record.sessionId}`)
    if (record.sessionFile) lines.push(`Session file: ${record.sessionFile}`)
    if (typeof record.totalMessages === 'number') lines.push(`Messages: ${record.totalMessages}`)

    if (typeof record.cost === 'number') lines.push(`Cost: ${record.cost}`)

    const tokens = piRecord(record.tokens)
    const parts: string[] = []
    if (typeof tokens.input === 'number') parts.push(`in ${tokens.input}`)
    if (typeof tokens.output === 'number') parts.push(`out ${tokens.output}`)
    if (typeof tokens.cacheRead === 'number') parts.push(`cache read ${tokens.cacheRead}`)
    if (typeof tokens.cacheWrite === 'number') parts.push(`cache write ${tokens.cacheWrite}`)
    if (typeof tokens.total === 'number') parts.push(`total ${tokens.total}`)
    if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)

    // Fallback if stats shape changes.
    const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

    await say(text)

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'name') {
    const name = rawArgs.trim()
    if (!name) {
      await say('Usage: /name <name>')
      return { stopReason: 'end_turn' }
    }

    // A user rename is authoritative: a generated title must never replace it.
    const wasNamed = session.markUserSessionName()

    try {
      await session.proc.setSessionName(name)
    } catch (e: unknown) {
      // A failed rename leaves the session as it was named before this attempt.
      session.markUserSessionName(wasNamed)
      const msg = String(e instanceof Error ? e.message : e)
      const hint = /set_session_name/i.test(msg)
        ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
        : ''

      await say(`Failed to set session name: ${msg}${hint}`)
      return { stopReason: 'end_turn' }
    }

    // The title publication bypasses the command sink, so a cancelled
    // command must not rename the session on the client either. The predicate
    // is re-checked inside the serialized publication queue, where this can
    // wait behind unrelated session-info work.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.syncSessionInfo(name, ctx.cancelled)

    await say(`Session name set: ${name}`)

    return { stopReason: 'end_turn' }
  }

  const modeCommand =
    cmd === 'steering'
      ? {
          key: 'steeringMode',
          label: 'Steering',
          set: (mode: 'all' | 'one-at-a-time') => session.proc.setSteeringMode(mode)
        }
      : cmd === 'follow-up'
        ? {
            key: 'followUpMode',
            label: 'Follow-up',
            set: (mode: 'all' | 'one-at-a-time') => session.proc.setFollowUpMode(mode)
          }
        : undefined
  if (modeCommand) {
    const modeRaw = String(args[0] ?? '').toLowerCase()
    const current = String(piRecord(await session.proc.getState())[modeCommand.key] ?? '')

    if (!modeRaw) {
      await say(`${modeCommand.label} mode: ${current || 'unknown'}`)
      return { stopReason: 'end_turn' }
    }

    if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
      await say(`Usage: /${cmd} all | /${cmd} one-at-a-time`)
      return { stopReason: 'end_turn' }
    }

    // Cancellation landed while pi's state was being read: settle as
    // cancelled instead of applying a mutation nobody is waiting for.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await modeCommand.set(modeRaw)

    await say(`${modeCommand.label} mode set to: ${modeRaw}`)

    return { stopReason: 'end_turn' }
  }

  if (cmd === 'export') {
    // The export always lands in the session cwd; a user-provided path is not accepted.
    // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
    // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
    // (no id), which would otherwise hang our request. So we guard here.
    const state = piRecord(await session.proc.getState())
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : null
    const messageCount = typeof state.messageCount === 'number' ? state.messageCount : 0

    if (!sessionFile || messageCount === 0 || !(await hasExportableSessionFile(sessionFile))) {
      await say('Nothing to export yet (no session messages). Send a prompt first.')
      return { stopReason: 'end_turn' }
    }

    const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

    // Cancellation landed during the pre-export probes: do not write an
    // export file for a command that already settled as cancelled.
    if (ctx.cancelled()) return { stopReason: 'end_turn' }

    let resultPath: string
    try {
      const result = await session.proc.exportHtml(outputPath)
      resultPath = result.path
    } catch (e: unknown) {
      await say(`Export failed: ${String(e instanceof Error ? e.message : e)}`)
      return { stopReason: 'end_turn' }
    }

    if (!resultPath) {
      await say('Export failed: no output path returned by pi.')
      return { stopReason: 'end_turn' }
    }

    const uri = pathToFileURL(resultPath).href

    // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
    // assistant message, so this avoids the "link + duplicate plain text" look.
    await say('Session exported: ')

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
      enabled = !piRecord(await session.proc.getState()).autoCompactionEnabled
    } else {
      // An unrecognized argument is a typo, not a toggle: report usage
      // instead of silently flipping the setting.
      await say(`Unknown argument: ${args[0]}. Usage: /autocompact on | off | toggle`)
      return { stopReason: 'end_turn' }
    }

    if (ctx.cancelled()) return { stopReason: 'end_turn' }
    await session.proc.setAutoCompaction(enabled)

    await say(`Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`)

    return { stopReason: 'end_turn' }
  }

  // Callers gate on BUILTIN_COMMAND_NAMES, so this is unreachable.
  throw RequestError.internalError({ command: cmd }, `Unhandled builtin command: /${cmd}`)
}
