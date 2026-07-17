import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent as ACPAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type AuthMethod,
  type StopReason,
  type ToolCallContent
} from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { getAuthMethods } from './auth.js'
import { SessionManager, type PiAcpSession } from './session.js'
import { SessionStore } from './session-store.js'
import { PiRpcProcess, PiRpcRequestTimeoutError } from '../pi-rpc/process.js'
import { getPiCommand, shouldUseShellForPiCommand } from '../pi-rpc/command.js'
import { comparePiVersions, parsePiVersion } from '../pi-rpc/version.js'
import { listPiSessions, findPiSession } from './pi-sessions.js'
import {
  translateAssistantContent,
  translateCustomMessageContent,
  translateUserContent
} from './translate/pi-messages.js'
import { toolResultImageBlocks, toolResultToolCallContent } from './translate/pi-tools.js'
import { PiSessionTreeError, walkActiveTreeBranch } from './translate/tree-walk.js'
import {
  FALLBACK_THINKING_LEVELS,
  isThinkingLevel,
  supportedThinkingLevels,
  type ThinkingLevel
} from './thinking-levels.js'
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
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands, type FileSlashCommand } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { spawnSync } from 'node:child_process'

type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

function historyToolKind(toolName: string): 'read' | 'edit' | 'other' {
  if (toolName === 'read') return 'read'
  if (toolName === 'write' || toolName === 'edit') return 'edit'
  return 'other'
}

/**
 * pi has no MCP support (an extension would be required to bridge MCP
 * servers), so silently accepting `mcpServers` would hand the client a
 * session that is missing its requested tools. Reject explicitly before any
 * session side effects instead of degrading silently.
 */
function assertNoMcpServers(mcpServers: readonly unknown[] | undefined): void {
  if (!mcpServers?.length) return
  throw RequestError.invalidParams(
    { reason: 'MCP_SERVERS_UNSUPPORTED' },
    `pi does not support MCP servers, so pi-acp cannot connect the ${mcpServers.length} requested MCP server(s). ` +
      'Remove mcpServers from the session request. To use MCP tools with pi, configure them through a pi extension ' +
      '(e.g. https://github.com/nicobailon/pi-mcp-adapter) instead.'
  )
}

function sessionPathsEquivalent(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
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
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

const BUILTIN_COMMAND_NAMES = new Set(builtinAvailableCommands().map(command => command.name))

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AcpClient
  // Declared before `sessions` so the shared store exists when the manager
  // field initializer runs (class fields initialize in declaration order).
  private readonly store = new SessionStore()
  private readonly sessions = new SessionManager(this.store)
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()
  private readonly cancellationEpochs = new Map<string, number>()
  private readonly loadGenerations = new Map<string, number>()
  private readonly activePrompts = new Map<string, Set<Promise<void>>>()
  private readonly activeLoads = new Map<string, Set<Promise<void>>>()
  private readonly closingSessions = new Map<string, Promise<void>>()
  // Serializes model/thinking-level mutations per session so a concurrent
  // write cannot slip between another write's support check and its
  // post-write verification.
  private readonly configMutationQueues = new Map<string, Promise<void>>()
  private disposed = false

  // Negotiated at initialize: the auth methods this connection advertised.
  // `authenticate` accepts only these IDs, and auth-required errors raised
  // anywhere in this agent's sessions advertise exactly this set.
  private authMethods: AuthMethod[] = []
  private advertisedAuthMethodIds = new Set<string>()

  // Negotiated at initialize. Zed advertises `_meta.terminal_output` for its
  // display-only terminal rendering convention; other clients get standard
  // text/image tool content instead. Defaults are strict (off) so nothing
  // non-standard leaks before initialization.
  private supportsTerminalOutputMeta = false

  dispose(): void {
    // Marking disposed first lets every in-flight create/restore that crosses
    // its next await boundary dispose its fresh process instead of
    // registering it; disposeAll then closes everything already registered.
    this.disposed = true
    this.sessions.disposeAll()
  }

  constructor(conn: AcpClient, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private findStoredSession(sessionId: string): { cwd: string; sessionFile: string } | null {
    const stored = this.store.get(sessionId)
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile }
    }

    const piSession = findPiSession(sessionId)
    if (!piSession) return null

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    })

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    }
  }

  private bumpCancellationEpoch(sessionId: string): void {
    const epoch = this.cancellationEpochs.get(sessionId) ?? 0
    this.cancellationEpochs.set(sessionId, epoch + 1)
  }

  private isPromptCancelled(sessionId: string, cancellationEpoch: number, signal?: AbortSignal): boolean {
    return (
      signal?.aborted === true ||
      this.disposed ||
      this.closingSessions.has(sessionId) ||
      this.activeLoads.has(sessionId) ||
      (this.cancellationEpochs.get(sessionId) ?? 0) !== cancellationEpoch
    )
  }

  private bumpLoadGeneration(sessionId: string): number {
    const generation = (this.loadGenerations.get(sessionId) ?? 0) + 1
    this.loadGenerations.set(sessionId, generation)
    return generation
  }

  private assertLoadActive(sessionId: string, generation: number): void {
    if (this.closingSessions.has(sessionId) || this.loadGenerations.get(sessionId) !== generation) {
      throw RequestError.requestCancelled({}, `session closed while loading: ${sessionId}`)
    }
  }

  private trackPrompt(sessionId: string, operation: () => Promise<PromptResponse>): Promise<PromptResponse> {
    // Defer operation startup by one microtask so registration is complete
    // before restore or adapter-side command execution reaches an async boundary.
    const result = Promise.resolve().then(operation)
    const tracked = result.then(
      () => undefined,
      () => undefined
    )

    let active = this.activePrompts.get(sessionId)
    if (!active) {
      active = new Set()
      this.activePrompts.set(sessionId, active)
    }
    active.add(tracked)

    void tracked.then(() => {
      active.delete(tracked)
      if (active.size === 0 && this.activePrompts.get(sessionId) === active) {
        this.activePrompts.delete(sessionId)
      }
    })

    return result
  }

  private trackLoad<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(operation)
    const tracked = result.then(
      () => undefined,
      () => undefined
    )

    let active = this.activeLoads.get(sessionId)
    if (!active) {
      active = new Set()
      this.activeLoads.set(sessionId, active)
    }
    active.add(tracked)

    return result.finally(() => {
      active.delete(tracked)
      if (active.size === 0 && this.activeLoads.get(sessionId) === active) {
        this.activeLoads.delete(sessionId)
      }
    })
  }

  private async waitForActivePrompts(sessionId: string): Promise<void> {
    while (true) {
      const active = this.activePrompts.get(sessionId)
      if (!active?.size) return
      await Promise.all([...active])
    }
  }

  private async waitForActiveLoads(sessionId: string): Promise<void> {
    while (true) {
      const active = this.activeLoads.get(sessionId)
      if (!active?.size) return
      await Promise.all([...active])
    }
  }

  private beginSessionClose(sessionId: string): Promise<void> {
    const inProgress = this.closingSessions.get(sessionId)
    if (inProgress) return inProgress

    this.bumpCancellationEpoch(sessionId)
    this.bumpLoadGeneration(sessionId)

    const closing = Promise.resolve()
      .then(async () => {
        // Dispose anything already registered so in-flight load RPCs reject,
        // then wait for every earlier load before a final cleanup sweep.
        await this.closeSessionResources(sessionId)
        await this.waitForActiveLoads(sessionId)
        await this.closeSessionResources(sessionId)
      })
      .finally(() => {
        if (this.closingSessions.get(sessionId) === closing) {
          this.closingSessions.delete(sessionId)
        }
      })
    this.closingSessions.set(sessionId, closing)
    return closing
  }

  private async closeSessionResources(sessionId: string): Promise<void> {
    let session = this.sessions.maybeGet(sessionId)
    if (!session) {
      const restoring = this.restoringSessions.get(sessionId)
      if (restoring) {
        try {
          session = await restoring
        } catch {
          // Registration precedes persistence, so a failed restore may still
          // have installed a session that must be cleaned up.
          session = this.sessions.maybeGet(sessionId)
        }
      }
    }

    if (session) {
      await session.shutdown()
      // Direct adapter commands settle when process disposal rejects their
      // pending RPC; waiting for them before disposal would deadlock.
      this.sessions.close(sessionId)
    }

    await this.waitForActivePrompts(sessionId)
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    const existing = this.sessions.maybeGet(sessionId)
    if (existing) return existing

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) return inFlight

    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId)
      if (!stored) {
        throw RequestError.resourceNotFound(sessionId)
      }

      const cwd = opts?.cwd ?? stored.cwd

      let proc: PiRpcProcess
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionPath: stored.sessionFile,
          piCommand: process.env.PI_ACP_PI_COMMAND
        })
      } catch (e: any) {
        if (e?.name === 'PiRpcSpawnError') {
          throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
        }
        throw e
      }

      // The connection may have been torn down while the spawn was in flight;
      // a disposed agent must never register (and thereby leak) this process.
      if (this.disposed) {
        proc.dispose()
        throw RequestError.internalError({}, 'pi-acp agent is disposed')
      }

      // Authoritative identity check before installation: the child must
      // actually be running the requested session. A pi that silently started
      // a different or fresh session (e.g. the stored file vanished) would
      // otherwise be installed under the wrong ACP sessionId.
      let state: any = null
      try {
        state = (await proc.getState()) as any
      } catch (e) {
        proc.dispose()
        throw (
          maybeAuthRequiredError(e, this.authMethods) ??
          RequestError.internalError({}, `pi did not report its session state: ${String((e as Error)?.message ?? e)}`)
        )
      }
      if (this.disposed) {
        proc.dispose()
        throw RequestError.internalError({}, 'pi-acp agent is disposed')
      }

      const reportedId = typeof state?.sessionId === 'string' ? state.sessionId.trim() : ''
      const reportedFile = typeof state?.sessionFile === 'string' ? state.sessionFile.trim() : ''
      if (
        reportedId !== sessionId ||
        !reportedFile ||
        (stored.sessionFile && !sessionPathsEquivalent(reportedFile, stored.sessionFile))
      ) {
        proc.dispose()
        throw RequestError.internalError(
          {},
          `pi did not restore the requested session (requested ${sessionId} at ${stored.sessionFile}, ` +
            `got ${reportedId || 'unknown'} at ${reportedFile || 'unknown'})`
        )
      }

      const fileCommands = loadSlashCommands(cwd)
      // getOrCreate refuses registration after teardown and disposes `proc`
      // itself when a concurrently registered session wins the race.
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands,
        supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
        authMethods: this.authMethods
      })

      try {
        this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile })
      } catch (error) {
        if (this.sessions.maybeGet(sessionId) === session && session.proc === proc) {
          this.sessions.close(sessionId)
        } else {
          proc.dispose()
        }
        throw error
      }

      return session
    })()

    this.restoringSessions.set(sessionId, restorePromise)

    try {
      return await restorePromise
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  /**
   * Restore for non-load consumers (resume, config mutations). While a
   * session/load is replaying this session, its freshly restored process is
   * provisional — a failing load evicts and disposes it — so other consumers
   * must not share it mid-flight. They wait for every active load to settle
   * and then use (or restore) the surviving state. The load itself calls
   * restoreSession directly and therefore never waits on itself.
   */
  private async restoreSessionAwaitingLoads(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    while (true) {
      await this.waitForActiveLoads(sessionId)
      const observedGeneration = this.loadGenerations.get(sessionId) ?? 0
      const session = await this.restoreSession(sessionId, opts)

      // A load can begin after the wait resolves but while restoration is in
      // flight. Never hand its provisional process to resume/config callers.
      if (!this.activeLoads.has(sessionId) && (this.loadGenerations.get(sessionId) ?? 0) === observedGeneration) {
        return session
      }
      await this.waitForActiveLoads(sessionId)
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support stable ACP protocol version 1.
    const supportedVersion = PROTOCOL_VERSION
    const requested = params.protocolVersion

    const clientCapabilities = params.clientCapabilities as
      | {
          auth?: { terminal?: unknown } | null
          _meta?: Record<string, unknown> | null
        }
      | null
      | undefined
    this.supportsTerminalOutputMeta = clientCapabilities?._meta?.['terminal_output'] === true
    // Terminal auth methods are advertised only against the standard
    // (unstable-SDK) `auth.terminal` capability; the Zed `_meta["terminal-auth"]`
    // launch spec is added only when the client also declared its meta flag.
    this.authMethods = getAuthMethods({
      supportsTerminalAuth: clientCapabilities?.auth?.terminal === true,
      supportsTerminalAuthMeta: clientCapabilities?._meta?.['terminal-auth'] === true
    })
    this.advertisedAuthMethodIds = new Set(this.authMethods.map(method => method.id))

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      authMethods: this.authMethods,
      // Keep this snapshot exactly in sync with the handlers registered in
      // `createPiAcpAgentApp` (src/acp/app.ts): omitted capability = unsupported.
      agentCapabilities: {
        loadSession: true,
        // pi has no MCP support; non-empty mcpServers are rejected explicitly
        // in session/new, session/load, and session/resume (see README
        // limitations), and no MCP transport capability is advertised.
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
          delete: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`)
    }
    assertNoMcpServers(params.mcpServers)

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
      authMethods: this.authMethods
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr, this.authMethods)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: this.authMethods },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr) {
      const authError = maybeAuthRequiredError(stateErr, this.authMethods)
      this.cleanupFailedNewSession(session.sessionId, state)
      if (authError) throw authError
      throw RequestError.internalError({}, String((stateErr as Error)?.message ?? stateErr))
    }

    const { configOptions, modes } = await getSessionConfiguration(session.proc, {
      state,
      availableModels
    })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // NOTE: The startup banner is intentionally NOT emitted here. ACP only
    // allows agent_message_chunk updates while a `session/prompt` is active;
    // emitting one right after session/new is an out-of-turn protocol
    // violation (https://github.com/svkozak/pi-acp/issues/59). The banner is
    // flushed as the first chunk of the first prompt turn instead (see
    // PiAcpSession.startTurn), and clients can also read it out-of-band from
    // `_meta.piAcp.startupInfo` above.

    // Advertise slash commands (ACP: available_commands_update) after the
    // session/new response has been delivered.
    this.advertiseCommandsSoon(session, { fileCommands, enableSkillCommands })

    return response
  }

  async authenticate(params: AuthenticateRequest) {
    // ACP defines methodId as one of the methods this agent advertised at
    // initialize; unknown or unadvertised IDs must not succeed silently.
    const methodId = typeof params?.methodId === 'string' ? params.methodId : ''
    if (!this.advertisedAuthMethodIds.has(methodId)) {
      throw RequestError.invalidParams(
        { methodId },
        `Unknown auth method: ${methodId || '(missing)'}. It was not advertised by this agent at initialize.`
      )
    }

    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` for the advertised method anyway, acknowledge it.
    return
  }

  prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
    const cancellationEpoch = this.cancellationEpochs.get(params.sessionId) ?? 0

    return this.trackPrompt(params.sessionId, async () => {
      let finishAdapterPromptTurn: (() => Promise<void>) | undefined

      try {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: 'cancelled' }
        }

        const response = await this.runPrompt(
          params,
          cancellationEpoch,
          finish => {
            finishAdapterPromptTurn = finish
          },
          signal
        )
        return this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)
          ? { stopReason: 'cancelled' }
          : response
      } catch (error) {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: 'cancelled' }
        }
        if (error instanceof PiRpcRequestTimeoutError) {
          // An adapter-handled command (compact, stats, export, ...) timed
          // out; the RPC layer already quarantined the channel. Evict this
          // session so the next request restores a fresh subprocess instead
          // of reusing the dead one.
          const session = this.sessions.maybeGet(params.sessionId)
          if (session) {
            session.dispose({ expected: false })
            this.sessions.evictIfCurrent(params.sessionId, session)
          }
        }
        throw error
      } finally {
        await finishAdapterPromptTurn?.()
      }
    })
  }

  private async runPrompt(
    params: PromptRequest,
    cancellationEpoch: number,
    registerAdapterPromptTurn: (finish: () => Promise<void>) => void,
    signal?: AbortSignal
  ): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)

    // Cancellation may arrive while restoreSession is spawning and registering
    // the pi subprocess. Do not let work started before that cancellation pass
    // the async restore boundary and reach pi.
    if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
      return { stopReason: 'cancelled' }
    }

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)
      if (BUILTIN_COMMAND_NAMES.has(cmd)) registerAdapterPromptTurn(session.beginAdapterPromptTurn())

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

        await session.sendSessionUpdate({
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

        await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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

          await session.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.sendSessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await session.sendSessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await session.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await session.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await session.sendSessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
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

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await session.sendSessionUpdate({
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

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await session.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await session.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await session.sendSessionUpdate({
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
          await session.sendSessionUpdate({
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
        await session.sendSessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await session.sendSessionUpdate({
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
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await session.sendSessionUpdate({
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
    }

    // Failures reject with an ACP error (session.PiAcpSession.failTurn);
    // successful turns resolve with a stable ACP stop reason.
    const stopReason: StopReason = await session.prompt(message, images)
    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.bumpCancellationEpoch(params.sessionId)

    // Do not restore an idle session merely to cancel it. Prompts already
    // crossing an in-progress restore observe the epoch change before they can
    // send work; an installed session still receives the normal live cancel.
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) return
    await session.cancel()
    if (session.isUnavailable()) this.sessions.evictIfCurrent(params.sessionId, session)
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (params.cwd != null && !isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`)
    }

    // Stable ACP semantics: no cwd filter means all known sessions.
    const all = listPiSessions()
    const filtered = params.cwd ? all.filter(s => s.cwd === params.cwd) : all

    // Cursors are opaque numeric offsets issued by this agent in `nextCursor`;
    // anything else is malformed and rejected rather than treated as page 0.
    let start = 0
    if (params.cursor != null) {
      const parsed = /^\d+$/.test(params.cursor) ? Number.parseInt(params.cursor, 10) : Number.NaN
      if (!Number.isSafeInteger(parsed)) {
        throw RequestError.invalidParams({}, `Invalid cursor: ${params.cursor}`)
      }
      start = parsed
    }

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  private async sendLoadUpdate(
    sessionId: string,
    generation: number,
    update: Parameters<AcpClient['sessionUpdate']>[0]
  ): Promise<void> {
    this.assertLoadActive(sessionId, generation)
    await this.conn.sessionUpdate(update)
    this.assertLoadActive(sessionId, generation)
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`)
    }
    assertNoMcpServers(params.mcpServers)

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.resourceNotFound(params.sessionId)
    }
    if (stored.cwd !== params.cwd) {
      throw RequestError.invalidParams(
        {},
        `cwd does not match the session's recorded cwd (${stored.cwd}): ${params.cwd}`
      )
    }

    this.bumpCancellationEpoch(params.sessionId)
    const generation = this.bumpLoadGeneration(params.sessionId)

    return this.trackLoad(params.sessionId, async () => {
      this.assertLoadActive(params.sessionId, generation)

      // A load owns its replacement teardown without publishing it as a public
      // close. A later session/close can therefore invalidate and await this
      // whole operation instead of coalescing with only the teardown.
      const existing = this.sessions.maybeGet(params.sessionId)
      if (existing || this.restoringSessions.has(params.sessionId) || this.activePrompts.has(params.sessionId)) {
        await this.closeSessionResources(params.sessionId)
        this.assertLoadActive(params.sessionId, generation)
      }

      const enableSkillCommands = getEnableSkillCommands(params.cwd)
      const session = await this.restoreSession(params.sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers
      })
      try {
        this.assertLoadActive(params.sessionId, generation)
        const proc = session.proc
        const fileCommands = loadSlashCommands(params.cwd)

        // Replay the complete raw active-branch history via pi's get_tree
        // (available on every supported pi version): unlike get_messages it
        // retains pre-compaction conversation. Capture the session's
        // custom-message sequence at the exact get_tree response boundary so
        // events written after that response cannot be mistaken for entries in
        // its snapshot.
        let customMessageBoundary = session.currentCustomMessageSequence()
        const treeData = await proc.getTree(() => {
          customMessageBoundary = session.currentCustomMessageSequence()
        })
        this.assertLoadActive(params.sessionId, generation)

        let entries: ReturnType<typeof walkActiveTreeBranch>
        try {
          entries = walkActiveTreeBranch(treeData)
        } catch (error) {
          if (error instanceof PiSessionTreeError) {
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
              await this.sendLoadUpdate(params.sessionId, generation, {
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
                await this.sendLoadUpdate(params.sessionId, generation, {
                  sessionId: session.sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: block.text }
                  }
                })
                continue
              }

              if (block.kind === 'thinking') {
                await this.sendLoadUpdate(params.sessionId, generation, {
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
              await this.sendLoadUpdate(params.sessionId, generation, {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: block.toolCallId,
                  title: isBash ? (bashCommand(block.rawInput) ?? block.toolName) : block.toolName,
                  kind: isBash ? 'execute' : historyToolKind(block.toolName),
                  status: 'pending',
                  rawInput: block.rawInput,
                  ...(isBash && this.supportsTerminalOutputMeta
                    ? {
                        content: bashTerminalContent(block.toolCallId),
                        _meta: bashTerminalInfoMeta(block.toolCallId, params.cwd)
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
              await this.sendLoadUpdate(params.sessionId, generation, {
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
                await this.sendLoadUpdate(params.sessionId, generation, {
                  sessionId: session.sessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId,
                    title: bashCommand(m) ?? toolName,
                    kind: 'execute',
                    status: 'in_progress',
                    ...(this.supportsTerminalOutputMeta
                      ? {
                          content: bashTerminalContent(toolCallId),
                          _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
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
              await this.sendLoadUpdate(params.sessionId, generation, {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId,
                  status: isError ? 'failed' : 'completed',
                  ...(this.supportsTerminalOutputMeta
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
              await this.sendLoadUpdate(params.sessionId, generation, {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId,
                  title: toolName,
                  kind: historyToolKind(toolName),
                  status: 'in_progress',
                  rawInput: null
                }
              })
            }

            const content: ToolCallContent[] = toolResultToolCallContent(m)
            await this.sendLoadUpdate(params.sessionId, generation, {
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

            await this.sendLoadUpdate(params.sessionId, generation, {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                title: bashCommand(m) ?? 'bash',
                kind: 'execute',
                status: 'in_progress',
                ...(this.supportsTerminalOutputMeta
                  ? {
                      content: bashTerminalContent(toolCallId),
                      _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
                    }
                  : {})
              }
            })

            await this.sendLoadUpdate(params.sessionId, generation, {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: failed ? 'failed' : 'completed',
                ...(this.supportsTerminalOutputMeta
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
          const terminalSettlement = metadata.isBash && this.supportsTerminalOutputMeta
          await this.sendLoadUpdate(params.sessionId, generation, {
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

        const { configOptions, modes } = await getSessionConfiguration(proc)
        this.assertLoadActive(params.sessionId, generation)

        const response = {
          configOptions,
          modes,
          _meta: {
            piAcp: {
              startupInfo: null
            }
          }
        }

        // Advertise slash commands after the response so the client knows the session exists.
        this.advertiseCommandsSoon(session, { fileCommands, enableSkillCommands })

        return response
      } catch (error) {
        // Any post-restore load failure (get_tree, malformed tree, replay
        // delivery, configuration, or generation cancellation) must not leave
        // this load's freshly restored session and pi subprocess installed.
        // Only the exact instance this load produced is evicted/disposed — a
        // replacement registered by a newer load is never touched — and the
        // durable session file/store entry is retained so the session remains
        // loadable.
        if (!this.sessions.evictIfCurrent(params.sessionId, session)) {
          session.dispose()
        }
        throw error
      }
    })
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`)
    }
    assertNoMcpServers(params.mcpServers)

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.resourceNotFound(params.sessionId)
    }

    // ACP allows resuming only under the session's recorded cwd; pi session
    // files are bound to the cwd they were created in.
    if (stored.cwd !== params.cwd) {
      throw RequestError.invalidParams(
        {},
        `cwd does not match the session's recorded cwd (${stored.cwd}): ${params.cwd}`
      )
    }

    const session = await this.restoreSessionAwaitingLoads(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers
    })

    // Unlike session/load, resume MUST NOT replay conversation history.
    const { configOptions, modes } = await getSessionConfiguration(session.proc)

    this.advertiseCommandsSoon(session, {
      fileCommands: loadSlashCommands(params.cwd),
      enableSkillCommands: getEnableSkillCommands(params.cwd)
    })

    const response = {
      configOptions,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    return response
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    // Close admission synchronously, cancel all prompt paths, dispose at the
    // normal lifecycle point, and wait for their ACP responses to settle.
    await this.beginSessionClose(params.sessionId)

    // Closing an unknown or already-closed session succeeds silently.
    return {}
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    await this.closeSession({ sessionId: params.sessionId })

    // Only unlink a session file discovered by scanning pi's real session
    // directory whose recorded header matches this sessionId. The adapter's
    // session map is never trusted for deletion: a tampered map entry must
    // not let session/delete unlink arbitrary paths.
    const piSession = findPiSession(params.sessionId)
    if (piSession) {
      try {
        unlinkSync(piSession.sessionFile)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw RequestError.internalError(
            { code: (error as NodeJS.ErrnoException).code, path: piSession.sessionFile },
            `Failed to delete session: ${params.sessionId}`
          )
        }
      }
    }

    this.store.delete(params.sessionId)

    // Deleting an unknown or already-deleted session succeeds silently.
    return {}
  }

  /**
   * Send `available_commands_update` after the current request's response has
   * been delivered. Some clients (e.g. Zed) ignore notifications for a
   * sessionId they have not yet confirmed.
   */
  // Test seam: deferred scheduling for post-response notifications. Tests
  // replace this locally instead of monkey-patching the global setTimeout.
  private scheduleDeferred: (task: () => void) => void = task => {
    setTimeout(task, 0)
  }

  private advertiseCommandsSoon(
    session: PiAcpSession,
    opts: { fileCommands: FileSlashCommand[]; enableSkillCommands: boolean }
  ): void {
    this.scheduleDeferred(() => {
      void this.advertiseCommands(session, opts)
    })
  }

  private async advertiseCommands(
    session: PiAcpSession,
    opts: { fileCommands: FileSlashCommand[]; enableSkillCommands: boolean }
  ): Promise<void> {
    if (this.sessions.maybeGet(session.sessionId) !== session) return

    try {
      const pi = (await session.proc.getCommands()) as any
      const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
        enableSkillCommands: opts.enableSkillCommands,
        includeExtensionCommands: false
      })

      if (this.sessions.maybeGet(session.sessionId) !== session) return
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: mergeCommands(commands, builtinAvailableCommands())
        }
      })
      return
    } catch {
      // Fall back to file-based prompt templates (legacy behavior).
    }

    if (this.sessions.maybeGet(session.sessionId) !== session) return
    try {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: mergeCommands(toAvailableCommands(opts.fileCommands), builtinAvailableCommands())
        }
      })
    } catch {
      // The session or ACP connection may have closed before this deferred update.
    }
  }

  /**
   * Serialize model/thinking-level writes per session: a concurrent mutation
   * must not slip between another write's support check, set command, and
   * post-write verification.
   */
  private runExclusiveConfigMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.configMutationQueues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.configMutationQueues.set(sessionId, tail)
    void tail.then(() => {
      if (this.configMutationQueues.get(sessionId) === tail) this.configMutationQueues.delete(sessionId)
    })
    return result
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const mode = String(params.modeId)

    // Restoration, validation, verification, write, and publication share one
    // queue. Restoring first also preserves resource-not-found precedence for
    // unknown sessions.
    await this.runExclusiveConfigMutation(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId)
      if (!isThinkingLevel(mode)) {
        throw RequestError.invalidParams({}, `Unknown modeId: ${mode}`)
      }
      const state = await applyThinkingLevel(session.proc, mode)

      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: mode
        }
      })

      await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc, { state })
    })

    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const configId = String(params.configId)

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams({}, `Expected string value for config option: ${configId}`)
    }

    const value = params.value
    if (configId !== MODEL_CONFIG_ID && configId !== THOUGHT_LEVEL_CONFIG_ID) {
      throw RequestError.invalidParams({}, `Unknown config option: ${configId}`)
    }
    if (configId === THOUGHT_LEVEL_CONFIG_ID && !isThinkingLevel(value)) {
      throw RequestError.invalidParams({}, `Unknown thinking level: ${value}`)
    }

    // Check + write + verify + publish run as one exclusive mutation so a
    // concurrent mutation can neither interleave with the write nor apply
    // before this one's updates are delivered.
    const configOptions = await this.runExclusiveConfigMutation(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId)
      if (configId === MODEL_CONFIG_ID) {
        const state = await applySessionModel(session.proc, value)
        return emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc, { state })
      }

      const state = await applyThinkingLevel(session.proc, value as ThinkingLevel)
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: value
        }
      })
      return emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc, { state })
    })
    return { configOptions }
  }
}

/**
 * Run a `session/prompt` while honoring the request's AbortSignal. ACP
 * clients normally stop a turn with the `session/cancel` notification, but
 * the signal also fires when the client sends the generic `$/cancel_request`
 * for this prompt (or the connection closes). Route that into the same
 * per-session cancellation path so the prompt still settles with the
 * `cancelled` stop reason after final updates flush, instead of running to
 * completion.
 *
 * The listener is scoped to this call: once the prompt settles it is removed,
 * so a later teardown-time abort of the signal cannot cancel a subsequent
 * turn.
 */
export async function runPromptWithCancellation(
  agent: Pick<PiAcpAgent, 'prompt' | 'cancel'>,
  params: PromptRequest,
  signal: AbortSignal
): Promise<PromptResponse> {
  let cancellationStarted = false
  const onAbort = () => {
    if (cancellationStarted) return
    cancellationStarted = true

    // Fire-and-forget: nothing awaits this listener, so swallow rejections
    // rather than surfacing them as unhandled.
    void agent.cancel({ sessionId: params.sessionId }).catch(() => {})
  }

  // Pass the signal through prompt startup so an abort cannot cross an async
  // restoration boundary and reach pi. The listener still routes mid-turn
  // aborts through the normal per-session cancellation path.
  const prompt = agent.prompt(params, signal)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  try {
    const response = await prompt
    return signal.aborted ? { stopReason: 'cancelled' } : response
  } catch (error) {
    if (signal.aborted) return { stopReason: 'cancelled' }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

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
async function applyThinkingLevel(proc: PiRpcProcess, level: ThinkingLevel): Promise<unknown> {
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

async function getSessionConfiguration(
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

async function emitConfigOptionsUpdate(
  conn: AcpClient,
  sessionId: string,
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc, pre)

  await conn.sessionUpdate({
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
async function applySessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<unknown> {
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

let updateNoticeCache: { value: string | null } | null = null

/** Test seam: clear the per-process update-notice cache. */
export function resetUpdateNoticeCacheForTests(): void {
  updateNoticeCache = null
}

function buildUpdateNotice(compute: () => string | null = computeUpdateNotice): string | null {
  // Cached for the process lifetime: the installed pi version cannot change
  // under a running adapter, and the synchronous npm lookup must not tax
  // every session/new. The object sentinel also caches a null result.
  if (updateNoticeCache) return updateNoticeCache.value
  const value = compute()
  updateNoticeCache = { value }
  return value
}

/** Deterministic local seam for cache behavior; does not replace child_process globals. */
export function getCachedUpdateNoticeForTests(compute: () => string | null): string | null {
  return buildUpdateNotice(compute)
}

function computeUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piCommand = getPiCommand(process.env.PI_ACP_PI_COMMAND)
    const piVersion = spawnSync(piCommand, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      shell: shouldUseShellForPiCommand(piCommand)
    })
    const installed = parsePiVersion(String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim())
    if (!installed) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = parsePiVersion(String(latestRes.stdout ?? '').trim())

    if (!latest) return null
    if (comparePiVersions(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piCommand = getPiCommand(process.env.PI_ACP_PI_COMMAND)
    const piVersion = spawnSync(piCommand, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      shell: shouldUseShellForPiCommand(piCommand)
    })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // All pi-owned global resources share the same override-aware root.
  const agentDir = getAgentDir()
  const globalSkillsDir = join(agentDir, 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(homedir(), '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(agentDir, 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(agentDir, 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (best-effort)
  try {
    const settingsPath = join(agentDir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
    const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
    for (const pkg of pkgs) {
      const s = String(pkg)
      if (s.startsWith('npm:')) {
        // Render a two-line bullet structure using markdown indentation.
        extItems.push(`${s}\n  - index.ts`)
      } else {
        extItems.push(s)
      }
    }
  } catch {
    // ignore
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
