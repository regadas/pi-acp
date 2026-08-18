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
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type AuthMethod,
  type StopReason,
  type ToolCallContent
} from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { getAuthMethods } from './auth.js'
import type { CommandContext, PiAcpSession } from './session.js'
import { SessionManager } from './session-manager.js'
import {
  MODEL_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
  applySessionModel,
  applyThinkingLevel,
  emitConfigOptionsUpdate,
  getSessionConfiguration
} from './session-config.js'
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
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels.js'
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
import { toToolKind } from './translate/tool-calls.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands, type FileSlashCommand } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { assertValidSessionCwd, sessionCwdsEquivalent } from './session-cwd.js'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { spawnSync } from 'node:child_process'

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

function assertNoAdditionalDirectories(additionalDirectories: readonly string[] | undefined): void {
  if (!additionalDirectories?.length) return
  throw RequestError.invalidParams(
    { reason: 'ADDITIONAL_DIRECTORIES_UNSUPPORTED' },
    `pi-acp does not support additional workspace directories, so it cannot use the ${additionalDirectories.length} ` +
      'requested additional directories. Remove additionalDirectories from the session request.'
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
const AUTOCOMPACT_ON_ALIASES = new Set(['on', 'true', 'enable', 'enabled'])
const AUTOCOMPACT_OFF_ALIASES = new Set(['off', 'false', 'disable', 'disabled'])

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

// Slightly above PiRpcProcess's 2s SIGTERM -> SIGKILL grace plus its 1s stdio
// close fallback, so an ordinary replacement never trips the barrier while a
// child that ignores SIGTERM is still being escalated.
const REPLACEMENT_TERMINATION_TIMEOUT_MS = 5_000

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
  // Delete transactions in flight. A delete owns its session from the close
  // through the retirement wait, the unlink, and the store tombstone; restoring
  // anywhere inside that window would spawn a child that recreates the file the
  // delete is about to remove (pi appends by path), so the deletion would not
  // stick. `closingSessions` cannot express this: it is cleared as soon as the
  // close finishes, which is only the first step of a delete.
  private readonly deletingSessions = new Map<string, Promise<void>>()
  // Serializes model/thinking-level mutations per session so a concurrent
  // write cannot slip between another write's support check and its
  // post-write verification.
  private readonly configMutationQueues = new Map<string, Promise<void>>()
  // Test seam: bound for the pre-spawn wait on a retired pi child's exit.
  private replacementTerminationTimeoutMs = REPLACEMENT_TERMINATION_TIMEOUT_MS
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

  /**
   * Final-shutdown variant of {@link dispose}: also waits (bounded) for the pi
   * children to terminate so the adapter cannot exit while a child is still
   * being escalated from SIGTERM to SIGKILL. Idempotent, like `dispose`.
   */
  async disposeAndWait(timeoutMs: number): Promise<void> {
    this.disposed = true
    await this.sessions.disposeAllAndWait(timeoutMs)
  }

  constructor(conn: AcpClient) {
    this.conn = conn
  }

  private cleanupFailedNewSession(sessionId: string): void {
    this.sessions.close(sessionId)

    // Only the store mapping SessionManager wrote from pi's authoritative
    // startup state may be unlinked. A path read from a later, unverified
    // get_state response must never decide which file this deletes.
    const sessionFile = this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  /**
   * Best-effort session-file aliases for the replacement barrier. A missing or
   * unreadable mapping only narrows the barrier to the session id, which is the
   * pre-existing behavior, so store problems must not fail the caller here.
   */
  private knownSessionFiles(sessionId: string): string[] {
    try {
      const sessionFile = this.store.get(sessionId)?.sessionFile
      return sessionFile ? [sessionFile] : []
    } catch {
      return []
    }
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

  private resolveStoredSessionCwd(sessionId: string, requestedCwd: string): string {
    const stored = this.findStoredSession(sessionId)
    if (!stored) throw RequestError.resourceNotFound(sessionId)
    if (!sessionCwdsEquivalent(stored.cwd, requestedCwd)) {
      throw RequestError.invalidParams(
        {},
        `cwd does not match the session's recorded cwd (${stored.cwd}): ${requestedCwd}`
      )
    }
    return stored.cwd
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
      // Start turn shutdown (abort + settle), then dispose without waiting for
      // it: session updates (including load replay) share one client delivery
      // chain, and a client that stalls one delivery must not keep the pi
      // subprocess alive. Adapter commands and in-flight RPCs settle when
      // disposal rejects them, so the settlement wait comes after disposal.
      const shutdown = session.shutdown()
      this.sessions.close(sessionId)
      await shutdown
    }

    await this.waitForActivePrompts(sessionId)
  }

  /**
   * Refuse to hand out (or create) a session while its deletion is in flight.
   * One check at the single entry point covers the whole restore: the body's
   * synchronous prefix (including the `findStoredSession` mapping refresh) runs
   * in the same tick, and concurrent callers awaiting an in-flight restore
   * already passed this guard themselves.
   *
   * Failing closed rather than waiting is deliberate: a restore parked until the
   * delete finished would still be registered in `activePrompts`, and the
   * delete's own `closeSessionResources` awaits exactly that set -- the wait
   * would deadlock the transaction it is waiting for.
   */
  private assertNotDeleting(sessionId: string): void {
    if (!this.deletingSessions.has(sessionId)) return
    throw RequestError.requestCancelled({}, `session is being deleted: ${sessionId}`)
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    this.assertNotDeleting(sessionId)

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

      // pi does not coordinate concurrent writers on a session file, so a
      // replacement must not open this session's file while the child it
      // replaces is still being terminated. Disposal only starts that
      // escalation, so wait (bounded, fail closed) for the real exit first.
      // Keyed by the file as well as the id: a child retired under a *different*
      // session id (pi reported another identity) may still append to this file.
      await this.sessions.waitForRetiredProcesses([sessionId, stored.sessionFile], this.replacementTerminationTimeoutMs)

      // Spawned through the session manager so the child is owned (and waited
      // for at shutdown) even if this restore disposes it below.
      let proc: PiRpcProcess
      try {
        proc = await this.sessions.spawnOwned({
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
      // Every disposal below retires through the manager: this child opened
      // `stored.sessionFile`, so an immediate retry must wait for its exit
      // instead of opening the same file a second time.
      if (this.disposed) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile])
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
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile])
        throw (
          maybeAuthRequiredError(e, this.authMethods) ??
          RequestError.internalError({}, `pi did not report its session state: ${String((e as Error)?.message ?? e)}`)
        )
      }
      if (this.disposed) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile])
        throw RequestError.internalError({}, 'pi-acp agent is disposed')
      }

      const reportedId = typeof state?.sessionId === 'string' ? state.sessionId.trim() : ''
      const reportedFile = typeof state?.sessionFile === 'string' ? state.sessionFile.trim() : ''
      if (
        reportedId !== sessionId ||
        !reportedFile ||
        (stored.sessionFile && !sessionPathsEquivalent(reportedFile, stored.sessionFile))
      ) {
        // The child reported a different identity, so it may append to either
        // file. Gate every identity a later restore could reach it through:
        // otherwise a `session/load` for the *reported* id discovers that file
        // (findPiSession scans pi's own directory) and spawns a second writer
        // while this one is still escalating SIGTERM -> SIGKILL.
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile, reportedId, reportedFile])
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
          this.sessions.retireProcess(sessionId, proc, [stored.sessionFile])
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
        name: 'pi-acp',
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
    assertValidSessionCwd(params.cwd)
    assertNoMcpServers(params.mcpServers)
    assertNoAdditionalDirectories(params.additionalDirectories)

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
      this.cleanupFailedNewSession(session.sessionId)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.authRequired(
        { authMethods: this.authMethods },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr) {
      const authError = maybeAuthRequiredError(stateErr, this.authMethods)
      this.cleanupFailedNewSession(session.sessionId)
      if (authError) throw authError
      throw RequestError.internalError({}, String((stateErr as Error)?.message ?? stateErr))
    }

    const configOptions = await getSessionConfiguration(session.proc, {
      state,
      availableModels
    })
    session.seedSessionConfiguration(configOptions)

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
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    const response = {
      sessionId: session.sessionId,
      configOptions,
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
      try {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: 'cancelled' }
        }

        const response = await this.runPrompt(params, cancellationEpoch, signal)
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
      }
    })
  }

  private async runPrompt(
    params: PromptRequest,
    cancellationEpoch: number,
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

      if (BUILTIN_COMMAND_NAMES.has(cmd)) {
        // Adapter-handled commands share the session FIFO with ordinary
        // prompts: they wait for an active turn and hold later prompts back.
        // pi cannot abort an in-flight manual RPC, so a cancel fails closed by
        // quarantining the channel; the command then settles as cancelled and
        // the next request restores the session on a fresh pi subprocess.
        const response = await session.runCommand(ctx => this.runBuiltinCommand(session, cmd, args, ctx))
        return response ?? { stopReason: 'cancelled' }
      }
    }

    // Failures reject with an ACP error (session.PiAcpSession.failTurn);
    // successful turns resolve with a stable ACP stop reason.
    const stopReason: StopReason = await session.prompt(message, images)
    return { stopReason }
  }

  /**
   * Adapter-handled builtin slash commands (headless-friendly subset). Always
   * invoked through `session.runCommand`, so it is already serialized with the
   * session's prompt FIFO and settles as cancelled on `session/cancel`.
   *
   * Every publication goes through `ctx.sendSessionUpdate`, which drops
   * updates once the command is cancelled: cancellation quarantines the pi
   * channel, so an in-flight RPC rejects with an induced error that must never
   * surface as a command failure (or a late success).
   */
  private async runBuiltinCommand(
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
        await ctx.sendSessionUpdate({
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
        await ctx.sendSessionUpdate({
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

      await ctx.sendSessionUpdate({
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

      try {
        const raw = readFileSync(sessionFile, 'utf-8')
        if (raw.trim().length === 0) {
          await ctx.sendSessionUpdate({
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
        await ctx.sendSessionUpdate({
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
    const cwdFilter = params.cwd
    const filtered = cwdFilter ? all.filter(s => sessionCwdsEquivalent(s.cwd, cwdFilter)) : all

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

  /**
   * Deliver one replayed history update through the session's ordered update
   * queue, so replay and concurrent live updates share a single total order
   * instead of racing on the raw connection. Delivery failures still reject,
   * and the load generation is re-checked on both sides of the send.
   */
  private async sendLoadUpdate(
    session: PiAcpSession,
    generation: number,
    update: Parameters<AcpClient['sessionUpdate']>[0]
  ): Promise<void> {
    this.assertLoadActive(session.sessionId, generation)
    await session.sendSessionUpdate(update)
    this.assertLoadActive(session.sessionId, generation)
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    assertValidSessionCwd(params.cwd)
    assertNoMcpServers(params.mcpServers)
    assertNoAdditionalDirectories(params.additionalDirectories)

    // The request only had to name an equivalent directory; the recorded cwd
    // stays authoritative so an alias cannot rebind the session's workspace.
    const cwd = this.resolveStoredSessionCwd(params.sessionId, params.cwd)

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

      const enableSkillCommands = getEnableSkillCommands(cwd)
      const session = await this.restoreSession(params.sessionId, {
        cwd,
        mcpServers: params.mcpServers
      })
      try {
        this.assertLoadActive(params.sessionId, generation)
        const proc = session.proc
        const fileCommands = loadSlashCommands(cwd)

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
              await this.sendLoadUpdate(session, generation, {
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
                await this.sendLoadUpdate(session, generation, {
                  sessionId: session.sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: block.text }
                  }
                })
                continue
              }

              if (block.kind === 'thinking') {
                await this.sendLoadUpdate(session, generation, {
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
              await this.sendLoadUpdate(session, generation, {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: block.toolCallId,
                  title: isBash ? (bashCommand(block.rawInput) ?? block.toolName) : block.toolName,
                  kind: isBash ? 'execute' : toToolKind(block.toolName),
                  status: 'pending',
                  rawInput: block.rawInput,
                  ...(isBash && this.supportsTerminalOutputMeta
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
              await this.sendLoadUpdate(session, generation, {
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
                await this.sendLoadUpdate(session, generation, {
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
              await this.sendLoadUpdate(session, generation, {
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
              await this.sendLoadUpdate(session, generation, {
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
            await this.sendLoadUpdate(session, generation, {
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

            await this.sendLoadUpdate(session, generation, {
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
                      _meta: bashTerminalInfoMeta(toolCallId, cwd)
                    }
                  : {})
              }
            })

            await this.sendLoadUpdate(session, generation, {
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
          await this.sendLoadUpdate(session, generation, {
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

        const configOptions = await getSessionConfiguration(proc)
        this.assertLoadActive(params.sessionId, generation)
        session.seedSessionConfiguration(configOptions)

        const response = {
          configOptions,
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
          // A newer load already registered its own session under this id; this
          // one still has to be retired through the replacement barrier.
          this.sessions.retire(session)
        }
        throw error
      }
    })
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    assertValidSessionCwd(params.cwd)
    assertNoMcpServers(params.mcpServers)
    assertNoAdditionalDirectories(params.additionalDirectories)

    // The recorded cwd stays authoritative: an equivalent alias in the request
    // must not rebind where this session's pi subprocess runs or reads from.
    const cwd = this.resolveStoredSessionCwd(params.sessionId, params.cwd)

    const session = await this.restoreSessionAwaitingLoads(params.sessionId, {
      cwd,
      mcpServers: params.mcpServers
    })

    // Unlike session/load, resume MUST NOT replay conversation history.
    const configOptions = await getSessionConfiguration(session.proc)
    session.seedSessionConfiguration(configOptions)

    this.advertiseCommandsSoon(session, {
      fileCommands: loadSlashCommands(cwd),
      enableSkillCommands: getEnableSkillCommands(cwd)
    })

    const response = {
      configOptions,
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

  /**
   * Run the whole delete transaction under one admission marker, registered
   * synchronously so no restore can slip between the close and the unlink.
   * Concurrent deletes for the same session coalesce onto this promise, which
   * keeps the marker alive until the last one is done; a later retry after a
   * failure starts a fresh transaction.
   */
  private beginSessionDelete(sessionId: string): Promise<void> {
    const inProgress = this.deletingSessions.get(sessionId)
    if (inProgress) return inProgress

    const deleting = Promise.resolve()
      .then(async () => {
        // Close admission, cancel every prompt path, dispose at the normal
        // lifecycle point, and wait for the ACP responses to settle.
        await this.beginSessionClose(sessionId)

        // pi appends to its session file by path, reopening it per write, so a
        // child that is still exiting recreates a file deleted underneath it as
        // a stray stub. Wait (bounded, fail closed) for the retired child to
        // actually exit first; an expired wait leaves the session file and its
        // mapping intact rather than reporting a deletion that did not stick.
        // The file path is gated too, so a child retired under another identity
        // that may still append to this file also blocks the unlink.
        await this.sessions.waitForRetiredProcesses(
          [sessionId, ...this.knownSessionFiles(sessionId)],
          this.replacementTerminationTimeoutMs
        )

        // Only unlink a session file discovered by scanning pi's real session
        // directory whose recorded header matches this sessionId. The adapter's
        // session map is never trusted for deletion: a tampered map entry must
        // not let session/delete unlink arbitrary paths.
        const piSession = findPiSession(sessionId)
        if (piSession) {
          try {
            unlinkSync(piSession.sessionFile)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw RequestError.internalError(
                { code: (error as NodeJS.ErrnoException).code, path: piSession.sessionFile },
                `Failed to delete session: ${sessionId}`
              )
            }
          }
        }

        this.store.delete(sessionId)
      })
      .finally(() => {
        if (this.deletingSessions.get(sessionId) === deleting) {
          this.deletingSessions.delete(sessionId)
        }
      })
    this.deletingSessions.set(sessionId, deleting)
    return deleting
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    await this.beginSessionDelete(params.sessionId)

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

    // Only a failed discovery selects the legacy file-based fallback. A
    // delivery failure must not fall through to a second advertisement, which
    // would silently replace pi's richer command set with the legacy list.
    let availableCommands: AvailableCommand[]
    try {
      const pi = (await session.proc.getCommands()) as any
      const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
        enableSkillCommands: opts.enableSkillCommands,
        includeExtensionCommands: false
      })
      availableCommands = mergeCommands(commands, builtinAvailableCommands())
    } catch {
      // Fall back to file-based prompt templates (legacy behavior).
      availableCommands = mergeCommands(toAvailableCommands(opts.fileCommands), builtinAvailableCommands())
    }

    if (this.sessions.maybeGet(session.sessionId) !== session) return
    try {
      // Delivered through the session's ordered update chain: this deferred
      // notification must not overtake updates already queued for the client.
      // Sessions replaced under the same sessionId have independent chains, so
      // the identity check is repeated at delivery time -- a stale chain held by
      // a slow client must not land its commands after the replacement's.
      await session.sendSessionUpdate(
        {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands
          }
        },
        { isStale: () => this.sessions.maybeGet(session.sessionId) !== session }
      )
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

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const configId = String(params.configId)

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams({}, `Expected string value for config option: ${configId}`)
    }

    const value = params.value
    if (configId !== MODEL_CONFIG_ID && configId !== THOUGHT_LEVEL_CONFIG_ID) {
      throw RequestError.invalidParams({}, `Unknown config option: ${configId}`)
    }

    // Restore + check + write + verify + publish run as one exclusive mutation.
    // Restoring first preserves resource-not-found precedence and prevents
    // concurrent configuration mutations from interleaving.
    const configOptions = await this.runExclusiveConfigMutation(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId)
      if (configId === THOUGHT_LEVEL_CONFIG_ID && !isThinkingLevel(value)) {
        throw RequestError.invalidParams({}, `Unknown thinking level: ${value}`)
      }
      session.beginConfigurationMutation()
      try {
        if (configId === MODEL_CONFIG_ID) {
          const state = await applySessionModel(session.proc, value)
          const options = await emitConfigOptionsUpdate(session, session.sessionId, session.proc, { state })
          session.seedSessionConfiguration(options)
          return options
        }

        const state = await applyThinkingLevel(session.proc, value as ThinkingLevel)
        // Publish through the session queue: an event-driven sync may already
        // have a stale update in flight, and only shared ordering guarantees
        // this mutation's state is the last one on the wire.
        const options = await emitConfigOptionsUpdate(session, session.sessionId, session.proc, { state })
        session.seedSessionConfiguration(options)
        return options
      } finally {
        await session.endConfigurationMutation()
      }
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

function buildStartupInfo(opts: { cwd: string; updateNotice: string | null }): string {
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

      // Recursive SKILL.md under subdirectories. Symlinked skill directories
      // are common (a link into a checkout), so they are followed; recursion
      // is keyed by resolved identity instead, because a link cycle would
      // otherwise walk forever and hang session/new.
      const stack: string[] = []
      const visited = new Set<string>()
      const pushDir = (dir: string) => {
        let resolved: string
        try {
          resolved = realpathSync(dir)
        } catch {
          return
        }
        if (visited.has(resolved)) return
        visited.add(resolved)
        stack.push(dir)
      }

      pushDir(root)
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
            // stat, not lstat: a symlinked SKILL.md or skill directory is
            // still a skill, and the visited set makes following links safe.
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            pushDir(p)
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
