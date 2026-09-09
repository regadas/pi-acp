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
  type StopReason
} from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { getAuthMethods } from './auth.js'
import type { PiAcpSession } from './session.js'
import { builtinAvailableCommands, runBuiltinCommand } from './builtin-commands.js'
import { replaySessionHistory } from './history-replay.js'
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
import { SessionRepository } from './session-repository.js'
import { PiRpcProcess, PiRpcRequestTimeoutError } from '../pi-rpc/process.js'
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels.js'
import { promptToPiMessage } from './translate/prompt.js'
import { parseCommandArgs } from './slash-commands.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { assertValidSessionCwd, sessionCwdsEquivalent } from './session-cwd.js'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'

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
import { fileURLToPath } from 'node:url'

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
  private repository = new SessionRepository(this.store)
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
  private supportsElicitationForm = false

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

  private sessionRepository(): SessionRepository {
    if (this.repository.store !== this.store) this.repository = new SessionRepository(this.store)
    return this.repository
  }

  private async cleanupFailedNewSession(sessionId: string): Promise<void> {
    const aliases = this.knownSessionFiles(sessionId)
    const cleanup = Promise.resolve()
      .then(async () => {
        this.sessions.close(sessionId)
        await this.sessions.waitForRetiredProcesses([sessionId, ...aliases], this.replacementTerminationTimeoutMs)
        if (aliases.length) await this.sessionRepository().delete(sessionId)
        else this.sessionRepository().tombstone(sessionId)
      })
      .finally(() => {
        if (this.deletingSessions.get(sessionId) === cleanup) this.deletingSessions.delete(sessionId)
        this.cleanupCancellationEpoch(sessionId)
      })
    this.deletingSessions.set(sessionId, cleanup)
    await cleanup.catch(() => {})
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

  private async findStoredSession(
    sessionId: string,
    cwd?: string
  ): Promise<{ cwd: string; sessionFile: string } | null> {
    const session = await this.sessionRepository().find(sessionId, cwd)
    return session ? { cwd: session.cwd, sessionFile: session.sessionFile } : null
  }

  private assertRequestedSessionCwd(recordedCwd: string, requestedCwd?: string): void {
    if (!requestedCwd || sessionCwdsEquivalent(recordedCwd, requestedCwd)) return
    throw RequestError.invalidParams(
      {},
      `cwd does not match the session's recorded cwd (${recordedCwd}): ${requestedCwd}`
    )
  }

  private bumpCancellationEpoch(sessionId: string): void {
    this.cancellationEpochs.set(sessionId, (this.cancellationEpochs.get(sessionId) ?? 0) + 1)
  }

  private cleanupCancellationEpoch(sessionId: string): void {
    if (
      !this.activePrompts.has(sessionId) &&
      !this.activeLoads.has(sessionId) &&
      !this.restoringSessions.has(sessionId) &&
      !this.closingSessions.has(sessionId) &&
      !this.deletingSessions.has(sessionId)
    ) {
      this.cancellationEpochs.delete(sessionId)
    }
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
      this.cleanupCancellationEpoch(sessionId)
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
      this.cleanupCancellationEpoch(sessionId)
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
        this.cleanupCancellationEpoch(sessionId)
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

  private async restoreSession(sessionId: string, opts?: { cwd?: string }): Promise<PiAcpSession> {
    this.assertNotDeleting(sessionId)

    const existing = this.sessions.maybeGet(sessionId)
    if (existing) {
      this.assertRequestedSessionCwd(existing.cwd, opts?.cwd)
      return existing
    }

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) {
      const session = await inFlight
      this.assertRequestedSessionCwd(session.cwd, opts?.cwd)
      return session
    }

    const restorePromise = (async () => {
      const stored = await this.findStoredSession(sessionId, opts?.cwd)
      if (!stored) {
        throw RequestError.resourceNotFound(sessionId)
      }

      this.assertRequestedSessionCwd(stored.cwd, opts?.cwd)
      const cwd = stored.cwd

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
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'PiRpcSpawnError') {
          throw RequestError.internalError({ code: (e as Error & { code?: string }).code }, e.message)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
      let state: any = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
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

      // getOrCreate refuses registration after teardown and disposes `proc`
      // itself when a concurrently registered session wins the race.
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        conn: this.conn,
        proc,
        supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
        authMethods: this.authMethods,
        supportsElicitationForm: this.supportsElicitationForm
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
  private async restoreSessionAwaitingLoads(sessionId: string, opts?: { cwd?: string }): Promise<PiAcpSession> {
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
          elicitation?: { form?: unknown } | null
          _meta?: Record<string, unknown> | null
        }
      | null
      | undefined
    this.supportsTerminalOutputMeta = clientCapabilities?._meta?.['terminal_output'] === true
    this.supportsElicitationForm = clientCapabilities?.elicitation?.form != null
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
          embeddedContext: true
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

    const session = await this.sessions.create({
      cwd: params.cwd,
      conn: this.conn,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
      authMethods: this.authMethods,
      supportsElicitationForm: this.supportsElicitationForm
    })

    let configOptions: Awaited<ReturnType<typeof getSessionConfiguration>>
    try {
      // Fetch state + models once (parallel) to reduce startup latency.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
      let state: any = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
      let availableModels: any = null
      let stateErr: unknown = null
      let availableModelsErr: unknown = null

      await Promise.all([
        session.proc
          .getState()
          .then(s => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
            state = s as any
          })
          .catch(err => {
            stateErr = err
            state = null
          }),
        session.proc
          .getAvailableModels()
          .then(m => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
            availableModels = m as any
          })
          .catch(err => {
            availableModelsErr = err
            availableModels = null
          })
      ])

      const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr, this.authMethods)
      if (availableModelsAuthErr) throw availableModelsAuthErr
      if (availableModelsErr) {
        throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
      }

      // If pi has no models available after spawning, it's effectively unauthenticated.
      if (!Array.isArray(availableModels?.models) || availableModels.models.length === 0) {
        throw RequestError.authRequired(
          { authMethods: this.authMethods },
          'Configure an API key or log in with an OAuth provider.'
        )
      }

      if (stateErr) {
        const authError = maybeAuthRequiredError(stateErr, this.authMethods)
        if (authError) throw authError
        throw RequestError.internalError({}, String((stateErr as Error)?.message ?? stateErr))
      }

      configOptions = await getSessionConfiguration(session.proc, { state, availableModels })
      session.seedSessionConfiguration(configOptions)
    } catch (error) {
      await this.cleanupFailedNewSession(session.sessionId)
      throw error
    }

    const response = {
      sessionId: session.sessionId,
      configOptions,
      _meta: { piAcp: { startupInfo: null } }
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
    this.advertiseCommandsSoon(session)

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

  private async usageFor(session: PiAcpSession) {
    return typeof session.publishUsageAndGet === 'function' ? session.publishUsageAndGet() : undefined
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
        const completed = await session.runCommand(async ctx => ({
          response: await runBuiltinCommand(session, cmd, args, ctx),
          usage: await this.usageFor(session)
        }))
        if (!completed) return { stopReason: 'cancelled' }
        return { ...completed.response, usage: completed.usage }
      }
    }

    // Failures reject with an ACP error (session.PiAcpSession.failTurn);
    // successful turns resolve with a stable ACP stop reason.
    let usage
    const stopReason: StopReason = await session.prompt(message, images, async () => {
      usage = await this.usageFor(session)
    })
    return { stopReason, usage }
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
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId)
    const observable =
      session ||
      this.activePrompts.has(params.sessionId) ||
      this.activeLoads.has(params.sessionId) ||
      this.restoringSessions.has(params.sessionId) ||
      this.closingSessions.has(params.sessionId) ||
      this.deletingSessions.has(params.sessionId)
    if (!observable) return

    this.bumpCancellationEpoch(params.sessionId)
    if (session) {
      await session.cancel()
      if (session.isUnavailable()) this.sessions.evictIfCurrent(params.sessionId, session)
    }
    this.cleanupCancellationEpoch(params.sessionId)
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (params.cwd != null && !isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`)
    }

    // Stable ACP semantics: no cwd filter means all known sessions.
    const filtered = await this.sessionRepository().list(params.cwd ?? undefined)

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

    const cwd = params.cwd

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

      const session = await this.restoreSession(params.sessionId, { cwd })
      try {
        this.assertLoadActive(params.sessionId, generation)
        const proc = session.proc

        await replaySessionHistory({
          session,
          cwd,
          supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
          assertActive: () => this.assertLoadActive(params.sessionId, generation),
          sendUpdate: update => this.sendLoadUpdate(session, generation, update)
        })

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
        this.advertiseCommandsSoon(session)

        return response
      } catch (error) {
        // Any post-restore load failure (get_entries, malformed snapshot, replay
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

    const cwd = params.cwd

    const session = await this.restoreSessionAwaitingLoads(params.sessionId, { cwd })

    // Unlike session/load, resume MUST NOT replay conversation history.
    const configOptions = await getSessionConfiguration(session.proc)
    session.seedSessionConfiguration(configOptions)

    this.advertiseCommandsSoon(session)

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

        try {
          await this.sessionRepository().delete(sessionId)
        } catch (error) {
          throw RequestError.internalError(
            { code: (error as NodeJS.ErrnoException).code },
            `Failed to delete session: ${sessionId}`
          )
        }
      })
      .finally(() => {
        if (this.deletingSessions.get(sessionId) === deleting) {
          this.deletingSessions.delete(sessionId)
        }
        this.cleanupCancellationEpoch(sessionId)
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

  private advertiseCommandsSoon(session: PiAcpSession): void {
    this.scheduleDeferred(() => {
      void this.advertiseCommands(session)
      if (typeof session.publishUsageAndGet === 'function') {
        void session.publishUsageAndGet({
          isStale: () => this.sessions.maybeGet(session.sessionId) !== session
        })
      }
    })
  }

  private async advertiseCommands(session: PiAcpSession): Promise<void> {
    if (this.sessions.maybeGet(session.sessionId) !== session) return

    let availableCommands: AvailableCommand[]
    try {
      const pi = await session.proc.getCommands()
      const { commands } = toAvailableCommandsFromPiGetCommands(pi)
      availableCommands = mergeCommands(commands, builtinAvailableCommands())
    } catch {
      availableCommands = builtinAvailableCommands()
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
        const json = JSON.parse(readFileSync(p, 'utf-8')) as {
          name?: unknown
          version?: unknown
        } | null
        return {
          name: typeof json?.name === 'string' ? json.name : undefined,
          version: typeof json?.version === 'string' ? json.version : undefined
        }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
