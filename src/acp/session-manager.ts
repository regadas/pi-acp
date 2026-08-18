import type { AuthMethod, McpServer } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { AcpClient } from './client.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { PiAcpSession } from './session.js'
import { toRequestError } from './session-errors.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AcpClient
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  /** Client negotiated Zed's `_meta.terminal_output` tool rendering convention. */
  supportsTerminalOutputMeta?: boolean
  /** Auth methods the owning agent advertised at initialize (for auth-required errors). */
  authMethods?: AuthMethod[]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  // Every pi child this manager is responsible for terminating, tracked from
  // the moment ownership starts until the child actually exits. This is the
  // single ownership record: a process is here whether it is registered under
  // a live session, still being validated by an in-flight create/restore,
  // disposed by a failure path, dropped as a registration race loser, or
  // closed earlier by an ACP connection abort. Final shutdown therefore waits
  // for all of them instead of exiting mid SIGTERM -> SIGKILL escalation.
  private readonly owned = new Set<PiRpcProcess>()
  // Spawn operations that have not settled yet. A pi child exists inside
  // `PiRpcProcess.spawn` before its promise resolves, so shutdown has to know
  // work is in flight even before it can see the process itself.
  private readonly pendingSpawns = new Set<Promise<void>>()
  // Children that have not exited yet, indexed by every identity through which
  // a later restore can reach the same persisted file: the sessionId it was
  // asked for, its session-file path, and (when pi reported a different
  // identity) the reported id and path. Disposal only starts the SIGTERM ->
  // SIGKILL escalation, so a replacement must wait here first: pi session files
  // have no writer coordination, and two live children would interleave their
  // history writes. One process is commonly registered under several keys.
  private readonly retiring = new Map<string, Set<PiRpcProcess>>()
  private readonly store: SessionStore
  private disposed = false

  /** The owning agent shares its store so both sides see one mapping. */
  constructor(store: SessionStore = new SessionStore()) {
    this.store = store
  }

  /**
   * Dispose all sessions and their underlying pi subprocesses and refuse any
   * later registration: an in-flight create/restore that finishes spawning
   * after teardown must dispose its fresh process instead of installing it.
   */
  disposeAll(): void {
    this.disposed = true
    for (const [id] of this.sessions) this.close(id)
  }

  /**
   * Dispose every session and every other owned pi child, then wait (bounded
   * by `timeoutMs`) for them to actually exit. Final adapter shutdown uses
   * this so a child that ignores SIGTERM is still SIGKILLed instead of being
   * orphaned when the adapter process exits.
   */
  async disposeAllAndWait(timeoutMs: number): Promise<void> {
    this.disposeAll()

    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, timeoutMs)
    })

    // A child can still appear while this waits: a spawn started before the
    // teardown may only now be creating -- or handing back -- its child. Drain
    // repeatedly until nothing is owned or pending, all under one deadline.
    // `handled` keeps the loop finite regardless of when a terminated child
    // drops out of `owned`.
    const handled = new Set<unknown>()
    try {
      while (!timedOut) {
        const procs = [...this.owned].filter(proc => !handled.has(proc))
        const spawns = [...this.pendingSpawns].filter(spawn => !handled.has(spawn))
        if (!procs.length && !spawns.length) return

        // Children owned outside a registered session (in-flight create/restore,
        // failure cleanup, race losers) are signalled here; disposal is
        // idempotent, so already-disposed children are unaffected.
        for (const proc of procs) {
          handled.add(proc)
          proc.dispose()
        }
        for (const spawn of spawns) handled.add(spawn)

        await Promise.race([Promise.all([...procs.map(proc => proc.whenTerminated()), ...spawns]), deadline])
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Take ownership of a pi child until it terminates. Idempotent: a process
   * handed back through {@link getOrCreate} is not tracked twice.
   */
  private own(proc: PiRpcProcess): void {
    if (this.owned.has(proc)) return
    this.owned.add(proc)
    void proc.whenTerminated().then(() => this.owned.delete(proc))

    // Ownership starting after teardown began must not leave a child running.
    // `disposeAllAndWait` still waits for its termination.
    if (this.disposed) proc.dispose()
  }

  /**
   * Spawn a pi subprocess owned by this manager. Ownership starts before the
   * caller (or a racing shutdown) can observe the child: `PiRpcProcess.spawn`
   * reports it through `onProcess` the moment the OS process exists, and the
   * operation itself is registered synchronously for the window before that.
   * Every later path -- validation failure, registration race, teardown during
   * the spawn -- is then covered by {@link disposeAllAndWait}.
   */
  spawnOwned(params: { cwd: string; sessionPath?: string; piCommand?: string }): Promise<PiRpcProcess> {
    // Refuse before a child exists. A caller can reach this point long after
    // teardown began -- a restore parked on {@link waitForRetiredProcesses} is
    // registered nowhere -- and by then `disposeAllAndWait` may already have
    // observed empty `owned`/`pendingSpawns` sets and returned, so the adapter
    // is free to exit. Spawning then would leave a child that nothing waits
    // for (nor escalates to SIGKILL). Guarding here covers every caller,
    // because this is the only path that starts a pi child.
    if (this.disposed) {
      return Promise.reject(RequestError.internalError({}, 'pi-acp session manager is disposed'))
    }

    const spawning = PiRpcProcess.spawn({ ...params, onProcess: proc => this.own(proc) })

    // Ownership is also taken on resolution: a spawn seam that never calls the
    // hook still hands its child over before the caller resumes. Failures and
    // hook errors settle this tracker without rejecting it, so shutdown only
    // ever waits on it.
    const tracked = spawning.then(proc => this.own(proc)).catch(() => {})
    this.pendingSpawns.add(tracked)
    void tracked.then(() => this.pendingSpawns.delete(tracked))

    return spawning
  }

  /**
   * Dispose a session and record its child for the replacement barrier. Public
   * because a caller that built a session which never became (or is no longer)
   * the registered one must retire it through the same path: the child already
   * opened that session's persisted file.
   */
  retire(session: PiAcpSession): void {
    this.trackRetired([session.sessionId], session.proc)
    try {
      session.dispose()
    } catch {
      // ignore
    }
  }

  /**
   * Retire a pi child that is not registered under a session but did open that
   * session's persisted file (restore validation failures, registration race
   * losers, teardown during a restore). Plain `proc.dispose()` only *starts*
   * the SIGTERM -> SIGKILL escalation, so skipping this lets the next restore
   * open the same file while this child can still append to it.
   */
  retireProcess(sessionId: string, proc: PiRpcProcess, aliases: readonly string[] = []): void {
    this.trackRetired([sessionId, ...aliases], proc)
    proc.dispose()
  }

  /**
   * Register `proc` under every supplied identity. `aliases` matter when pi
   * reported a different session than the one it was asked for: the child may
   * append to either file, so a later restore reaching it by *any* of those
   * identities has to wait for this child to exit.
   */
  private trackRetired(keys: readonly string[], proc: PiRpcProcess): void {
    let registered = false
    for (const key of new Set(keys)) {
      if (!key) continue
      let procs = this.retiring.get(key)
      if (!procs) {
        procs = new Set()
        this.retiring.set(key, procs)
      }
      procs.add(proc)
      registered = true
    }
    if (!registered) return

    // Sweep the live index rather than a captured key list: the same child can
    // pick up further aliases before it exits, and a leftover alias would gate
    // later restores forever. Deleting visited Map entries while iterating is
    // safe.
    const forget = () => {
      for (const [key, procs] of this.retiring) {
        procs.delete(proc)
        if (procs.size === 0) this.retiring.delete(key)
      }
    }
    void proc.whenTerminated().then(forget, forget)
  }

  /**
   * Bounded fail-closed barrier before a session is restored onto a new pi
   * child: resolve once every child previously retired for this session has
   * actually exited. Callers must not spawn a replacement before this settles,
   * and an expired wait rejects rather than opening the same session file
   * twice.
   */
  async waitForRetiredProcesses(keys: string | readonly string[], timeoutMs: number): Promise<void> {
    const wanted = [...new Set((typeof keys === 'string' ? [keys] : keys).filter(Boolean))]
    const sessionId = wanted[0] ?? ''
    // Every identity that can reach the same writer gates this caller, so a
    // restore keyed by a session id is still blocked by a child retired only
    // under that session's file path (or vice versa).
    const stillRetiring = (): Set<PiRpcProcess> => {
      const procs = new Set<PiRpcProcess>()
      for (const key of wanted) {
        for (const proc of this.retiring.get(key) ?? []) procs.add(proc)
      }
      return procs
    }
    if (!stillRetiring().size) return

    let timer: NodeJS.Timeout | undefined
    const expired = Symbol('expired')
    const deadline = new Promise<typeof expired>(resolve => {
      timer = setTimeout(() => resolve(expired), timeoutMs)
      timer.unref?.()
    })

    try {
      // A close racing this wait can retire another child for the same
      // session, so re-read the index instead of trusting one snapshot.
      // `awaited` keeps the loop finite regardless of when a terminated child
      // drops out of `retiring`.
      const awaited = new Set<PiRpcProcess>()
      while (true) {
        const pending = [...stillRetiring()].filter(proc => !awaited.has(proc))
        if (!pending.length) return
        for (const proc of pending) awaited.add(proc)

        const settled = await Promise.race([Promise.all(pending.map(proc => proc.whenTerminated())), deadline])
        if (settled === expired) break
      }
    } finally {
      if (timer) clearTimeout(timer)
    }

    throw RequestError.internalError(
      { sessionId },
      `The previous pi process for session ${sessionId} did not exit within ${timeoutMs}ms; ` +
        'refusing to start a second process on the same session file.'
    )
  }

  private assertNotDisposed(proc?: PiRpcProcess): void {
    if (!this.disposed) return
    proc?.dispose()
    throw RequestError.internalError({}, 'pi-acp session manager is disposed')
  }

  /** Get a registered, usable session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session?.isUnavailable()) return session

    this.retire(session)
    this.sessions.delete(sessionId)
    return undefined
  }

  /** Remove a session only if it is still the instance the caller observed. */
  evictIfCurrent(sessionId: string, expectedSession: PiAcpSession): boolean {
    if (this.sessions.get(sessionId) !== expectedSession) return false
    this.close(sessionId)
    return true
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.retire(session)
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    this.assertNotDisposed()

    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await this.spawnOwned({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }
    this.assertNotDisposed(proc)

    // The ACP sessionId must be pi's authoritative persisted session identity;
    // fabricating one would return an ID that can never be found, listed, or
    // loaded again. Any failure past this point owns the spawned process.
    // The two failures below happen before pi reported an authoritative
    // identity, so no sessionId can name this child's file: nothing can be
    // retried by sessionId, no store mapping exists, and `findPiSession` has no
    // id to match. A bare disposal is therefore correct -- the replacement
    // barrier is keyed by sessionId and would have nothing to key on.
    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch (e) {
      proc.dispose()
      throw maybeAuthRequiredError(e, params.authMethods) ?? toRequestError(e)
    }
    this.assertNotDisposed(proc)

    const sessionId = typeof state?.sessionId === 'string' && state.sessionId.trim() ? state.sessionId : null
    const sessionFile = typeof state?.sessionFile === 'string' && state.sessionFile.trim() ? state.sessionFile : null
    if (!sessionId || !sessionFile) {
      proc.dispose()
      throw RequestError.internalError(
        {},
        'pi did not report an authoritative sessionId/sessionFile for the new session'
      )
    }

    // pi creates its session directory lazily; ensure it exists up-front so
    // commands that read the session file (e.g. export_html) cannot fail on a
    // missing parent directory. Best-effort: pi itself creates it on write.
    try {
      mkdirSync(dirname(sessionFile), { recursive: true })
    } catch {
      // ignore
    }

    try {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    } catch (e) {
      // pi already created this session, and `findPiSession` discovers it by
      // scanning pi's own directory, so a later session/load can target the
      // file even though the adapter mapping was never written. Retire through
      // the barrier so that load cannot open it while this child still exits.
      this.retireProcess(sessionId, proc, [sessionFile])
      throw toRequestError(e)
    }

    let session: PiAcpSession
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        proc,
        conn: params.conn,
        fileCommands: params.fileCommands ?? [],
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods
      })
    } catch (error) {
      // The store mapping already exists, so a later session/load can target
      // this file: retire through the barrier instead of a bare dispose.
      this.retireProcess(sessionId, proc)
      throw error
    }

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const session = this.maybeGet(sessionId)
    if (!session) throw RequestError.resourceNotFound(sessionId)
    return session
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered. When a registered session wins the race,
   * the caller's freshly spawned losing process is disposed here so it can
   * never leak; after disposeAll the fresh process is disposed and the call
   * fails instead of registering.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    // Restores spawn through `spawnOwned`; take ownership anyway so a process
    // handed over by any other path is still awaited at shutdown.
    this.own(params.proc)
    if (this.disposed) {
      // This child already opened the session file, so it is retired (not just
      // disposed) even when registration is refused.
      this.retireProcess(sessionId, params.proc)
      throw RequestError.internalError({}, 'pi-acp session manager is disposed')
    }

    const existing = this.maybeGet(sessionId)
    if (existing) {
      if (existing.proc !== params.proc) this.retireProcess(sessionId, params.proc)
      return existing
    }

    let session: PiAcpSession
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        proc: params.proc,
        conn: params.conn,
        fileCommands: params.fileCommands ?? [],
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods
      })
    } catch (error) {
      this.retireProcess(sessionId, params.proc)
      throw error
    }

    this.sessions.set(sessionId, session)
    return session
  }
}
