import {
  PROTOCOL_VERSION,
  RequestError,
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
} from '@agentclientprotocol/sdk/unstable'
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
  getSessionConfiguration,
  piModelsList
} from './session-config.js'
import { SessionStore } from './session-store.js'
import { SessionRepository } from './session-repository.js'
import { PiRpcProcess, PiRpcRequestTimeoutError } from '../pi-rpc/process.js'
import { piRecord } from '../pi-rpc/protocol.js'
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels.js'
import { promptToPiMessage } from './translate/prompt.js'
import { parseCommandArgs } from './slash-commands.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { assertValidSessionCwd, sessionCwdsEquivalent } from './session-cwd.js'
import { normalizeAdditionalDirectories, workspaceRootsEquivalent } from './workspace-roots.js'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk/unstable'

/**
 * pi supports MCP servers through its own configuration (user/project
 * `mcp.json`, extensions), but pi-acp does not yet bridge a client's
 * `mcpServers` into the session's pi configuration, so silently accepting
 * them would hand the client a session that is missing its requested tools.
 * Reject explicitly before any session side effects instead of degrading
 * silently.
 */
function assertNoMcpServers(mcpServers: readonly unknown[] | undefined): void {
  if (!mcpServers?.length) return
  throw RequestError.invalidParams(
    { reason: 'MCP_SERVERS_UNSUPPORTED' },
    `pi-acp does not bridge client-provided MCP servers into pi's configuration yet, ` +
      `so the ${mcpServers.length} requested MCP server(s) cannot be connected. ` +
      'Remove mcpServers from the session request. To use MCP tools with pi, configure them in pi itself ' +
      '(native mcp.json or an extension such as https://github.com/nicobailon/pi-mcp-adapter) instead.'
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
const LIST_PAGE_SIZE = 50
const LIST_SNAPSHOT_TTL_MS = 5 * 60_000
const MAX_LIST_SNAPSHOTS = 16

/** Restore request shape shared by load/resume/prompt/config callers. */
type SessionRestoreOpts = {
  cwd?: string
  additionalDirectories?: readonly string[]
  /**
   * Internal: the caller is a session/load whose own activeLoads tracking must
   * not be awaited inside the changed-root path (a load can never wait for
   * itself).
   */
  loadOwned?: boolean
  /**
   * Internal: arrival-ordinal baseline captured when a root-changing request
   * was admitted; only a *valid* load arriving after it supersedes these roots.
   */
  loadArrivalBaseline?: number
  /** Internal: close-admission fence; a close/delete admitted after it fails this mutation closed. */
  closeAdmission?: number
}

export class PiAcpAgent {
  private readonly conn: AcpClient
  // Declared before `sessions` so the shared store exists when the manager
  // field initializer runs (class fields initialize in declaration order).
  private readonly store = new SessionStore()
  private repository = new SessionRepository(this.store)
  private readonly sessions = new SessionManager(this.store)
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()
  private readonly cancellationEpochs = new Map<string, number>()
  private readonly loadGenerations = new Map<string, number>()
  /** Load arrival ordinals, issued synchronously before any await so ordering survives out-of-order validation. */
  private readonly loadArrivals = new Map<string, number>()
  /** Arrival ordinal of the most recently admitted *valid* load; invalid or still-pending loads never supersede. */
  private readonly validLoadArrivals = new Map<string, number>()
  /**
   * Whole admitted resume operations, registered synchronously at admission;
   * close/delete drain these before their final sweep so nothing survives the
   * acknowledged close/delete.
   */
  private readonly activeResumes = new Map<string, Set<Promise<void>>>()
  /**
   * Close admissions only; never cleaned up. Config mutations capture it
   * at admission so a close admitted after them invalidates their work.
   */
  private readonly closeAdmissionGenerations = new Map<string, number>()
  private readonly activePrompts = new Map<string, Set<Promise<void>>>()
  private readonly activeLoads = new Map<string, Set<Promise<void>>>()
  /**
   * In-flight load-admission validations, awaited by committers so a
   * validating load's fences land first. Resolved (never rejected) and
   * self-cleared so waiters never loop on a settled gate.
   */
  private readonly sessionValidations = new Map<string, Promise<void>>()
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
  private readonly listSnapshots = new Map<
    string,
    { cwd: string | null; sessions: SessionInfo[]; firstOffset: number; expiresAt: number }
  >()
  // Test seam: bound for the pre-spawn wait on a retired pi child's exit.
  private replacementTerminationTimeoutMs = REPLACEMENT_TERMINATION_TIMEOUT_MS
  private disposed = false

  // Negotiated at initialize: the auth methods this connection advertised.
  // `authenticate` accepts only these IDs, and auth-required errors raised
  // anywhere in this agent's sessions advertise exactly this set.
  private authMethods: AuthMethod[] = []
  private advertisedAuthMethodIds = new Set<string>()

  // Negotiated at initialize: `_meta.terminal_output` enables display-only
  // terminal rendering; clients without it get standard text/image content. Defaults are strict (off) so nothing
  // non-standard leaks before initialization.
  private supportsTerminalOutputMeta = false
  private supportsElicitationForm = false

  dispose(): void {
    // Marking disposed first lets every in-flight create/restore that crosses
    // its next await boundary dispose its fresh process instead of
    // registering it; disposeAll then closes everything already registered.
    this.disposed = true
    this.listSnapshots.clear()
    this.sessions.disposeAll()
  }

  /**
   * Final-shutdown variant of {@link dispose}: also waits (bounded) for the pi
   * children to terminate so the adapter cannot exit while a child is still
   * being escalated from SIGTERM to SIGKILL. Idempotent, like `dispose`.
   */
  async disposeAndWait(timeoutMs: number): Promise<void> {
    this.disposed = true
    this.listSnapshots.clear()
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
  ): Promise<{ cwd: string; sessionFile: string; additionalDirectories: readonly string[] } | null> {
    const session = await this.sessionRepository().find(sessionId, cwd)
    return session
      ? {
          cwd: session.cwd,
          sessionFile: session.sessionFile,
          additionalDirectories: session.additionalDirectories ?? []
        }
      : null
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

  /** Issues the session's next load-arrival ordinal synchronously (see loadArrivals). */
  private nextLoadArrival(sessionId: string): number {
    const arrival = (this.loadArrivals.get(sessionId) ?? 0) + 1
    this.loadArrivals.set(sessionId, arrival)
    return arrival
  }

  /**
   * Whether a *valid* load arriving after `baseline` has been admitted: the
   * only event that makes a root-changing request's committed roots stale.
   */
  private supersededByValidLoad(sessionId: string, baseline: number): boolean {
    return (this.validLoadArrivals.get(sessionId) ?? 0) > baseline
  }

  private bumpCloseAdmission(sessionId: string): void {
    this.closeAdmissionGenerations.set(sessionId, (this.closeAdmissionGenerations.get(sessionId) ?? 0) + 1)
  }

  /** Close fence for config mutations; `undefined` (every other restore caller) skips it. */
  private assertCloseAdmissionCurrent(sessionId: string, closeAdmission: number | undefined): void {
    if (closeAdmission === undefined) return
    if ((this.closeAdmissionGenerations.get(sessionId) ?? 0) !== closeAdmission) {
      throw RequestError.requestCancelled({}, `session closed while configuring: ${sessionId}`)
    }
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

  /** Tracks a whole resume operation from synchronous admission so close/delete drain it before their final sweep. */
  private trackResume<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(operation)
    const tracked = result.then(
      () => undefined,
      () => undefined
    )

    let active = this.activeResumes.get(sessionId)
    if (!active) {
      active = new Set()
      this.activeResumes.set(sessionId, active)
    }
    active.add(tracked)

    return result.finally(() => {
      active.delete(tracked)
      if (active.size === 0 && this.activeResumes.get(sessionId) === active) {
        this.activeResumes.delete(sessionId)
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

  private async waitForActiveResumes(sessionId: string): Promise<void> {
    while (true) {
      const active = this.activeResumes.get(sessionId)
      if (!active?.size) return
      await Promise.all([...active])
    }
  }

  /** Await a load's in-flight admission validation so a request about to commit observes its fences. */
  private async waitForSessionValidation(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.sessionValidations.get(sessionId)
      if (!pending) return
      await pending
    }
  }

  /**
   * Chains this load's validation/admission span on the session's gate tail,
   * synchronously at arrival: lookups serialize behind earlier spans, and
   * `settle` (called once the admission decision lands) is what gate waiters
   * observe before committing.
   */
  private beginLoadValidationSpan(
    sessionId: string,
    cwd: string
  ): {
    validation: Promise<{ cwd: string; sessionFile: string; additionalDirectories: readonly string[] } | null>
    settle: () => void
  } {
    const previous = this.sessionValidations.get(sessionId) ?? Promise.resolve()
    let settle!: () => void
    const spanSettled = new Promise<void>(resolve => {
      settle = resolve
    })
    const tail = previous.then(() => spanSettled)
    this.sessionValidations.set(sessionId, tail)
    void tail.then(() => {
      if (this.sessionValidations.get(sessionId) === tail) this.sessionValidations.delete(sessionId)
    })
    const validation = previous.then(() => this.findStoredSession(sessionId, cwd))
    return { validation, settle }
  }

  private async waitForConfigMutations(sessionId: string): Promise<void> {
    while (true) {
      const tail = this.configMutationQueues.get(sessionId)
      if (!tail) return
      await tail
    }
  }

  private beginSessionClose(sessionId: string): Promise<void> {
    const inProgress = this.closingSessions.get(sessionId)
    if (inProgress) return inProgress

    this.bumpCancellationEpoch(sessionId)
    this.bumpLoadGeneration(sessionId)
    this.bumpCloseAdmission(sessionId)

    const closing = Promise.resolve()
      .then(async () => {
        // Dispose anything already registered so in-flight load RPCs reject,
        // and a live resume parked on an RPC to its child unblocks through
        // that disposal instead of holding the close behind its own wait.
        await this.closeSessionResources(sessionId)
        // Whole admitted resumes drain after that first teardown and before
        // the final sweep: waiting for them earlier would deadlock behind the
        // same teardown, skipping them would acknowledge a close around a
        // resume that still spawns its child.
        await this.waitForActiveResumes(sessionId)
        await this.waitForActiveLoads(sessionId)
        // Config mutations are tracked as neither prompts nor loads; their
        // queue tail is the only record of pending writes, so drain it before
        // the final sweep: a write admitted before the close must not publish
        // or restore after it.
        await this.waitForConfigMutations(sessionId)
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

  /**
   * A root-changing request's roots are stale once a *valid* load that
   * arrived after its admission ordinal has been admitted: every re-entry
   * into the restore loop fails closed before acting on stale roots.
   */
  private assertRootMutationCurrent(sessionId: string, opts?: SessionRestoreOpts): void {
    if (opts?.loadArrivalBaseline === undefined) return
    if (this.supersededByValidLoad(sessionId, opts.loadArrivalBaseline)) {
      throw RequestError.requestCancelled({}, `session superseded by a newer load while restoring: ${sessionId}`)
    }
  }

  private async restoreSession(sessionId: string, opts?: SessionRestoreOpts): Promise<PiAcpSession> {
    this.assertNotDeleting(sessionId)

    // Additional workspace roots are child-start configuration. A caller that
    // supplies a replacement root list (load/resume) must not reuse a live
    // child configured with different roots; same roots reuse it.
    while (true) {
      // A root-supplying request must not commit past a validating load's
      // admission fences, which land when the validation settles.
      if (opts?.additionalDirectories !== undefined) await this.waitForSessionValidation(sessionId)
      // Re-entry follows an await (active-load wait or joining an in-flight
      // restore); a newer load may have taken over during it.
      this.assertRootMutationCurrent(sessionId, opts)
      // The validation wait can straddle a whole delete transaction with the
      // file still on disk: re-check instead of spawning a writer across it.
      this.assertNotDeleting(sessionId)
      const existing = this.sessions.maybeGet(sessionId)
      if (existing) {
        this.assertRequestedSessionCwd(existing.cwd, opts?.cwd)
        if (
          opts?.additionalDirectories === undefined ||
          workspaceRootsEquivalent(existing.additionalDirectories, opts.additionalDirectories)
        ) {
          return existing
        }
        // A live load's freshly restored child is provisional until that load
        // settles; wait instead of destroying it mid-flight. Loads themselves
        // never wait here (they would wait on their own tracking): they own
        // generation-guarded teardown of whatever survives their fencing.
        if (!opts?.loadOwned && this.activeLoads.has(sessionId)) {
          await this.waitForActiveLoads(sessionId)
          continue
        }
        // Retire the differently configured child through the normal teardown
        // (including its replacement barrier below) and restore a fresh one.
        return await this.restoreSessionReplacingChild(sessionId, opts)
      }

      const inFlight = this.restoringSessions.get(sessionId)
      if (inFlight) {
        const session = await inFlight
        this.assertRequestedSessionCwd(session.cwd, opts?.cwd)
        if (
          opts?.additionalDirectories === undefined ||
          workspaceRootsEquivalent(session.additionalDirectories, opts.additionalDirectories)
        ) {
          return session
        }
        continue
      }

      return await this.registeredRestore(sessionId, opts)
    }
  }

  /**
   * The registered restore spawn path shared by every restore: the store
   * read, retirement barrier, child spawn, identity check and registration
   * run as the session's in-flight restore, so concurrent consumers join it
   * and close/delete/load fence it.
   */
  private async registeredRestore(sessionId: string, opts?: SessionRestoreOpts): Promise<PiAcpSession> {
    const restorePromise = this.restoreFromStore(sessionId, opts)
    this.restoringSessions.set(sessionId, restorePromise)
    try {
      return await restorePromise
    } finally {
      if (this.restoringSessions.get(sessionId) === restorePromise) this.restoringSessions.delete(sessionId)
    }
  }

  /**
   * Fenced replacement of a live child whose additional roots differ from the
   * request. The teardown AND the fresh restore run as one registered
   * in-flight restore, so a close, delete or load admitted while the old child
   * is still settling fences this window instead of racing an invisible gap:
   * a close or delete fails it closed before the replacement spawns, and a
   * load awaits it, supersedes the fresh child and is never overridden -- this
   * window can never destroy a load's provisional child. New prompts join the
   * registration and continue on the fresh child.
   */
  private async restoreSessionReplacingChild(sessionId: string, opts: SessionRestoreOpts): Promise<PiAcpSession> {
    const observedEpoch = this.cancellationEpochs.get(sessionId) ?? 0
    const replacement = (async () => {
      // Retire the differently configured child. This mirrors the teardown in
      // closeSessionResources but never awaits in-flight restores (this window
      // is itself the registered restore; awaiting would self-join) and never
      // waits for active prompts: prompts arriving now join this registration
      // and continue on the fresh child, so waiting for them here would
      // deadlock on this very promise.
      const session = this.sessions.maybeGet(sessionId)
      if (session) {
        const shutdown = session.shutdown()
        this.sessions.close(sessionId)
        await shutdown
      }

      // A validating load's admission fences must land before this
      // replacement commits its (possibly stale) roots.
      if (opts.additionalDirectories !== undefined) await this.waitForSessionValidation(sessionId)

      // A close or delete admitted while the old child was settling owns the
      // session now; the replacement fails closed instead of overriding it
      // (respawning behind an acknowledged close, or recreating a deleted
      // session's file and store entry). The epoch bump also catches
      // admissions that already completed -- closing markers are cleared as
      // soon as their close finishes -- and a completed delete surfaces below
      // as resource-not-found because the fresh restore re-reads the store.
      this.assertNotDeleting(sessionId)
      if (this.closingSessions.has(sessionId) || (this.cancellationEpochs.get(sessionId) ?? 0) !== observedEpoch) {
        throw RequestError.requestCancelled(
          {},
          `session closed, cancelled, or superseded by a load while restoring: ${sessionId}`
        )
      }

      return this.restoreFromStore(sessionId, opts)
    })()
    this.restoringSessions.set(sessionId, replacement)
    try {
      return await replacement
    } finally {
      if (this.restoringSessions.get(sessionId) === replacement) this.restoringSessions.delete(sessionId)
    }
  }

  private async restoreFromStore(sessionId: string, opts?: SessionRestoreOpts): Promise<PiAcpSession> {
    const stored = await this.findStoredSession(sessionId, opts?.cwd)
    if (!stored) {
      throw RequestError.resourceNotFound(sessionId)
    }

    this.assertRequestedSessionCwd(stored.cwd, opts?.cwd)
    const cwd = stored.cwd
    const additionalDirectories = opts?.additionalDirectories ?? stored.additionalDirectories

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
        piCommand: process.env.PI_ACP_PI_COMMAND,
        ...(additionalDirectories.length ? { additionalDirectories } : {})
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
    let state: unknown
    try {
      state = await proc.getState()
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

    const reportedState = piRecord(state)
    const reportedId = typeof reportedState.sessionId === 'string' ? reportedState.sessionId.trim() : ''
    const reportedFile = typeof reportedState.sessionFile === 'string' ? reportedState.sessionFile.trim() : ''
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
      supportsElicitationForm: this.supportsElicitationForm,
      additionalDirectories
    })

    try {
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile, additionalDirectories })
    } catch (error) {
      if (this.sessions.maybeGet(sessionId) === session && session.proc === proc) {
        this.sessions.close(sessionId)
      } else {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile])
      }
      throw error
    }

    return session
  }

  /**
   * Restore for non-load consumers (resume, config mutations): a load's
   * freshly restored process is provisional until the load settles, so wait
   * for active loads first. A root-changing resume fails closed only when
   * superseded by a *valid* newer load; while an older load settles it waits
   * and retries so its newer roots replace the surviving child. Loads restore
   * directly and never wait on themselves.
   */
  private async restoreSessionAwaitingLoads(sessionId: string, opts?: SessionRestoreOpts): Promise<PiAcpSession> {
    while (true) {
      this.assertCloseAdmissionCurrent(sessionId, opts?.closeAdmission)
      await this.waitForActiveLoads(sessionId)
      // The load wait above can straddle a close admission.
      this.assertCloseAdmissionCurrent(sessionId, opts?.closeAdmission)
      // Root-less restores re-read surviving state each retry (per-iteration
      // baseline); a root-changing resume keeps its admission-time baseline.
      const baseline = opts?.loadArrivalBaseline ?? this.loadArrivals.get(sessionId) ?? 0
      const session = await this.restoreSession(sessionId, opts)

      // A validating load admitted mid-restore must land its fences before
      // these restored roots commit.
      if (opts?.additionalDirectories !== undefined) await this.waitForSessionValidation(sessionId)

      // A load can begin after the wait resolves but while restoration is in
      // flight. Never hand its provisional process to resume/config callers.
      if (!this.activeLoads.has(sessionId) && !this.supersededByValidLoad(sessionId, baseline)) {
        return session
      }
      if (opts?.additionalDirectories !== undefined) {
        // Stale roots the newer owner already replaced: fail closed instead
        // of re-applying them behind its back.
        if (this.supersededByValidLoad(sessionId, baseline)) {
          throw RequestError.requestCancelled({}, `session superseded by a newer load while restoring: ${sessionId}`)
        }
        // An older load is still settling: wait and retry so these newer
        // roots replace its surviving child.
        await this.waitForActiveLoads(sessionId)
        continue
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
    // Terminal auth methods are advertised only against the stable v1
    // `auth.terminal` capability; the optional `_meta["terminal-auth"]`
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
          delete: {},
          additionalDirectories: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    assertValidSessionCwd(params.cwd)
    assertNoMcpServers(params.mcpServers)
    const additionalDirectories = normalizeAdditionalDirectories(params.cwd, params.additionalDirectories)

    const session = await this.sessions.create({
      cwd: params.cwd,
      conn: this.conn,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
      authMethods: this.authMethods,
      supportsElicitationForm: this.supportsElicitationForm,
      additionalDirectories
    })

    let configOptions: Awaited<ReturnType<typeof getSessionConfiguration>>
    try {
      // Fetch state + models once (parallel) to reduce startup latency.
      const [stateResult, modelsResult] = await Promise.allSettled([
        session.proc.getState(),
        session.proc.getAvailableModels()
      ])

      const modelsAuthErr = maybeAuthRequiredError(
        modelsResult.status === 'rejected' ? modelsResult.reason : null,
        this.authMethods
      )
      if (modelsAuthErr) throw modelsAuthErr
      if (modelsResult.status === 'rejected') {
        throw RequestError.internalError({}, String((modelsResult.reason as Error)?.message ?? modelsResult.reason))
      }

      // If pi has no models available after spawning, it's effectively unauthenticated.
      if (piModelsList(modelsResult.value).length === 0) {
        throw RequestError.authRequired(
          { authMethods: this.authMethods },
          'Configure an API key or log in with an OAuth provider.'
        )
      }

      const stateAuthErr = maybeAuthRequiredError(
        stateResult.status === 'rejected' ? stateResult.reason : null,
        this.authMethods
      )
      if (stateAuthErr) throw stateAuthErr
      if (stateResult.status === 'rejected') {
        throw RequestError.internalError({}, String((stateResult.reason as Error)?.message ?? stateResult.reason))
      }

      configOptions = await getSessionConfiguration(session.proc, {
        state: stateResult.value,
        availableModels: modelsResult.value
      })
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

  /**
   * Whether the session is live in the manager (restorable without a store
   * read). The v2 chain checks this synchronously before admitting a prompt,
   * so a live session's admission happens in the request's own tick.
   */
  hasLiveSession(sessionId: string): boolean {
    return this.sessions.maybeGet(sessionId) !== undefined
  }

  /**
   * Whether the session is persisted and a prompt could restore it; false
   * for unknown sessions. Checked after {@link hasLiveSession}; the restore
   * itself stays authoritative for races.
   */
  async hasStoredSession(sessionId: string): Promise<boolean> {
    try {
      return (await this.findStoredSession(sessionId)) !== null
    } catch {
      return false
    }
  }

  prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
    const cancellationEpoch = this.cancellationEpochs.get(params.sessionId) ?? 0

    return this.trackPrompt(params.sessionId, async () => {
      // The exact session instance this prompt ran on. A late RPC timeout
      // must dispose that session only: while the timed-out command drains its
      // final client updates the old child can exit and a replacement can
      // register under the same session id, and that replacement is healthy.
      let ranSession: PiAcpSession | undefined
      try {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: 'cancelled' }
        }

        const response = await this.runPrompt(params, cancellationEpoch, signal, session => {
          ranSession = session
        })
        return this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)
          ? { ...response, stopReason: 'cancelled' }
          : response
      } catch (error) {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: 'cancelled' }
        }
        if (error instanceof PiRpcRequestTimeoutError) {
          // An adapter-handled command (compact, stats, export, ...) timed
          // out; the RPC layer already quarantined the channel. Evict this
          // session so the next request restores a fresh subprocess instead
          // of reusing the dead one. Only the exact original session is
          // disposed: `evictIfCurrent` keeps a registered replacement intact.
          if (ranSession) {
            ranSession.dispose({ expected: false })
            this.sessions.evictIfCurrent(params.sessionId, ranSession)
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
    signal?: AbortSignal,
    onRestored?: (session: PiAcpSession) => void
  ): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)
    onRestored?.(session)

    // Cancellation may arrive while restoreSession is spawning and registering
    // the pi subprocess. Do not let work started before that cancellation pass
    // the async restore boundary and reach pi.
    if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
      return { stopReason: 'cancelled' }
    }

    const requestOwner = Symbol()
    const onAbort = () => {
      void session
        .cancel(requestOwner)
        .then(() => {
          if (session.isUnavailable()) this.sessions.evictIfCurrent(params.sessionId, session)
        })
        .catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
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
          const completed = await session.runCommand(
            async ctx => ({
              response: await runBuiltinCommand(session, cmd, args, ctx, argsString),
              usage: await this.usageFor(session)
            }),
            requestOwner
          )
          if (!completed) return { stopReason: 'cancelled' }
          return { ...completed.response, usage: completed.usage }
        }
      }

      // Failures reject with an ACP error (session.PiAcpSession.failTurn);
      // successful turns resolve with a stable ACP stop reason.
      let usage
      const stopReason: StopReason = await session.prompt(
        message,
        images,
        async () => {
          usage = await this.usageFor(session)
        },
        requestOwner
      )
      return { stopReason, usage }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
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

    // Preserve path segments: collapsing `..` can conflate distinct paths through symlinks.
    // Continuations must compare cwd without filesystem metadata reads.
    const cwd = params.cwd == null ? null : params.cwd.replace(/\/+$/, '') || '/'
    const cursor = params.cursor
    let start = 0
    if (cursor != null) {
      const snapshotCursor = /^s:([A-Za-z0-9_-]{24}):(\d+)$/.exec(cursor)
      if (snapshotCursor) {
        const snapshot = this.listSnapshots.get(snapshotCursor[1]!)
        const now = Date.now()
        start = Number(snapshotCursor[2])
        if (
          !snapshot ||
          snapshot.expiresAt <= now ||
          snapshot.cwd !== cwd ||
          !Number.isSafeInteger(start) ||
          snapshotCursor[2] !== String(start) ||
          start < snapshot.firstOffset ||
          (start - snapshot.firstOffset) % LIST_PAGE_SIZE !== 0 ||
          start >= snapshot.sessions.length
        ) {
          if (snapshot && snapshot.expiresAt <= now) this.listSnapshots.delete(snapshotCursor[1]!)
          throw RequestError.invalidParams({}, `Invalid cursor: ${cursor}`)
        }
        const next = start + LIST_PAGE_SIZE
        return {
          sessions: snapshot.sessions.slice(start, next),
          nextCursor: next < snapshot.sessions.length ? `s:${snapshotCursor[1]}:${next}` : null,
          _meta: {}
        }
      }
      start = /^\d+$/.test(cursor) ? Number.parseInt(cursor, 10) : Number.NaN
      if (!Number.isSafeInteger(start)) {
        throw RequestError.invalidParams({}, `Invalid cursor: ${cursor}`)
      }
    }

    // No cursor (or a legacy numeric offset) discovers current sessions again.
    const filtered = await this.sessionRepository().list(params.cwd ?? undefined)
    const sessions: SessionInfo[] = filtered.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      additionalDirectories: [...(s.additionalDirectories ?? [])],
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const next = start + LIST_PAGE_SIZE
    if (next >= sessions.length) {
      return { sessions: sessions.slice(start, next), nextCursor: null, _meta: {} }
    }

    if (this.disposed) throw RequestError.internalError({}, 'pi-acp agent is disposed')
    const now = Date.now()
    for (const [token, snapshot] of this.listSnapshots) {
      if (snapshot.expiresAt <= now) this.listSnapshots.delete(token)
    }
    while (this.listSnapshots.size >= MAX_LIST_SNAPSHOTS) {
      this.listSnapshots.delete(this.listSnapshots.keys().next().value!)
    }
    let token: string
    do {
      token = randomBytes(18).toString('base64url')
    } while (this.listSnapshots.has(token))
    this.listSnapshots.set(token, { cwd, sessions, firstOffset: next, expiresAt: now + LIST_SNAPSHOT_TTL_MS })
    return { sessions: sessions.slice(start, next), nextCursor: `s:${token}:${next}`, _meta: {} }
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
    const additionalDirectories = normalizeAdditionalDirectories(params.cwd, params.additionalDirectories)

    const cwd = params.cwd
    // Admission fence, synchronous before any lookup: a close/delete in
    // flight owns the teardown, and one that acknowledged while this load sat
    // validating would otherwise admit a child after the acknowledged close.
    this.assertNotDeleting(params.sessionId)
    if (this.closingSessions.has(params.sessionId)) {
      throw RequestError.requestCancelled({}, `session is being closed: ${params.sessionId}`)
    }
    // Synchronous arrival ordinal (see loadArrivals).
    const arrival = this.nextLoadArrival(params.sessionId)

    // A wrong-but-valid cwd must reject before the destructive fencing below
    // (cancellation/load bumps and the teardown of the live session and its
    // in-flight prompts). A live session's cwd is authoritative (the child
    // actually runs it); without one the JSONL header is (repository.find
    // repairs the stale store mapping), so the load validates through the
    // repository before any bump. restoreFromStore remains the final
    // authority for races.
    const existing = this.sessions.maybeGet(params.sessionId)
    if (existing) {
      this.assertRequestedSessionCwd(existing.cwd, cwd)
    } else {
      const closeAdmission = this.closeAdmissionGenerations.get(params.sessionId) ?? 0
      // Publish the span on the gate chain before the first await: waiters
      // observe this load's fences, and a same-turn arrival cannot overwrite
      // the pending tail.
      const span = this.beginLoadValidationSpan(params.sessionId, cwd)
      try {
        const record = await span.validation
        if (!record) throw RequestError.resourceNotFound(params.sessionId)
        this.assertRequestedSessionCwd(record.cwd, cwd)
        // A close/delete that landed while this load validated owns the
        // session: fail closed instead of re-opening behind it.
        if (this.deletingSessions.has(params.sessionId)) {
          throw RequestError.requestCancelled({}, `session is being deleted: ${params.sessionId}`)
        }
        if ((this.closeAdmissionGenerations.get(params.sessionId) ?? 0) !== closeAdmission) {
          throw RequestError.requestCancelled(
            {},
            `session superseded by a concurrent load or close while loading: ${params.sessionId}`
          )
        }
        // A later valid load already admitted: this arrival is stale.
        if (this.supersededByValidLoad(params.sessionId, arrival)) {
          throw RequestError.requestCancelled(
            {},
            `session superseded by a newer load while loading: ${params.sessionId}`
          )
        }
      } finally {
        // Settles in the same synchronous block as the bumps below, so
        // waiters never see a settled tail without its fences.
        span.settle()
      }
    }

    this.bumpCancellationEpoch(params.sessionId)
    const generation = this.bumpLoadGeneration(params.sessionId)
    this.validLoadArrivals.set(params.sessionId, arrival)

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

      const session = await this.restoreSession(params.sessionId, {
        cwd,
        additionalDirectories,
        loadOwned: true
      })
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
        // loadable. A superseded load also cleans up nothing here: the newer
        // load's teardown owns the session, and evicting it would kill the
        // winner's fresh child.
        if (
          !this.supersededByValidLoad(params.sessionId, arrival) &&
          !this.sessions.evictIfCurrent(params.sessionId, session)
        ) {
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
    const additionalDirectories = normalizeAdditionalDirectories(params.cwd, params.additionalDirectories)

    const cwd = params.cwd
    // Admission fence, synchronous before any tracking or await: a close or
    // delete already in flight owns the teardown, so a NEW resume fails
    // closed instead of spawning behind the acknowledged completion.
    this.assertNotDeleting(params.sessionId)
    if (this.closingSessions.has(params.sessionId)) {
      throw RequestError.requestCancelled({}, `session is being closed: ${params.sessionId}`)
    }
    // Admission-time arrival baseline: only a valid load arriving after it
    // supersedes these roots (older or invalid loads never do).
    const loadArrivalBaseline = this.loadArrivals.get(params.sessionId) ?? 0

    // Tracked from admission so a later close/delete drains this whole
    // operation before acknowledging: an intentional same-tick resume+close
    // resolves, with the close reaping the resumed child.
    return this.trackResume(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId, {
        cwd,
        additionalDirectories,
        loadArrivalBaseline
      })

      // Unlike session/load, resume MUST NOT replay conversation history.
      const configOptions = await getSessionConfiguration(session.proc)
      session.seedSessionConfiguration(configOptions)

      this.advertiseCommandsSoon(session)

      return {
        configOptions,
        _meta: {
          piAcp: {
            startupInfo: null
          }
        }
      }
    })
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
   * been delivered. Some clients ignore notifications for a
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
      availableCommands = mergeCommands(builtinAvailableCommands(), commands)
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
    // concurrent mutations from interleaving; the close fence below keeps a
    // close/delete (admitted before or after) from restoring behind its back.
    if (this.closingSessions.has(params.sessionId) || this.deletingSessions.has(params.sessionId)) {
      throw RequestError.requestCancelled({}, `session closed while configuring: ${params.sessionId}`)
    }
    const closeAdmission = this.closeAdmissionGenerations.get(params.sessionId) ?? 0
    const configOptions = await this.runExclusiveConfigMutation(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId, { closeAdmission })
      // A close admitted while the restore was in flight must not have its
      // freshly restored child written to or published on.
      this.assertCloseAdmissionCurrent(params.sessionId, closeAdmission)
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

/** Normalize request cancellation after its owned prompt work and updates settle. */
export async function runPromptWithCancellation(
  agent: Pick<PiAcpAgent, 'prompt'>,
  params: PromptRequest,
  signal: AbortSignal
): Promise<PromptResponse> {
  try {
    const response = await agent.prompt(params, signal)
    return signal.aborted ? { ...response, stopReason: 'cancelled' } : response
  } catch (error) {
    if (signal.aborted) return { stopReason: 'cancelled' }
    throw error
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
