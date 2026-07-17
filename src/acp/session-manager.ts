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

  isDisposed(): boolean {
    return this.disposed
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

    session.dispose()
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
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.dispose()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    this.assertNotDisposed()

    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
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
      proc.dispose()
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
      proc.dispose()
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
    this.assertNotDisposed(params.proc)

    const existing = this.maybeGet(sessionId)
    if (existing) {
      if (existing.proc !== params.proc) params.proc.dispose()
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
      params.proc.dispose()
      throw error
    }

    this.sessions.set(sessionId, session)
    return session
  }
}
