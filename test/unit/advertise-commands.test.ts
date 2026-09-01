import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
type FileSlashCommand = { name: string; description: string; content: string; source: string }
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// `available_commands_update` is advertised after the request response. Only a
// failed pi command *discovery* may select the legacy file-based fallback: a
// delivery failure must not fall through to a second, downgraded advertisement
// that silently replaces pi's richer command set. The notification also travels
// through the session's ordered update chain so it cannot overtake updates
// already queued for the client.

const FILE_COMMANDS: FileSlashCommand[] = [
  { name: 'legacy', description: 'legacy file template', content: 'body', source: '(user)' }
]

const PI_COMMANDS = {
  commands: [
    { name: 'pi-only', description: 'from pi get_commands', source: 'prompt', location: 'project' },
    { name: 'skill:demo', description: 'a skill', source: 'skill', location: 'user' }
  ]
}

class FakeSessions {
  constructor(private readonly session: PiAcpSession) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

/** Gates the first delivery only, so queue bypass becomes observable as reordering. */
class GatedConnection extends FakeAgentSideConnection {
  readonly attempts: string[] = []
  private gate: Promise<void> | null = null
  failOn: string | null = null

  gateNextUpdate(gate: Promise<void>): void {
    this.gate = gate
  }

  async sessionUpdate(msg: SessionNotification): Promise<void> {
    this.attempts.push(msg.update.sessionUpdate)
    const gate = this.gate
    if (gate) {
      this.gate = null
      await gate
    }
    if (this.failOn && msg.update.sessionUpdate === this.failOn) {
      throw new Error(`client rejected ${this.failOn}`)
    }
    return super.sessionUpdate(msg)
  }
}

function makeSession(conn: GatedConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: FILE_COMMANDS
  })
}

function advertiseWith(agent: PiAcpAgent, session: PiAcpSession): Promise<void> {
  return (agent as any).advertiseCommands(session, {
    fileCommands: FILE_COMMANDS,
    enableSkillCommands: true
  }) as Promise<void>
}

function makeAgent(proc: FakePiRpcProcess, conn: GatedConnection) {
  const session = makeSession(conn, proc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  return { agent, session, advertise: () => advertiseWith(agent, session) }
}

function piCommands(name: string) {
  return { commands: [{ name, description: name, source: 'prompt', location: 'project' }] }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function commandUpdates(conn: FakeAgentSideConnection): string[][] {
  return conn.updates.flatMap(update => {
    if (update.update.sessionUpdate !== 'available_commands_update') return []
    const commands = (update.update as { availableCommands?: Array<{ name?: unknown }> }).availableCommands ?? []
    return [commands.map(command => String(command.name))]
  })
}

test("advertiseCommands: pi's discovered commands are advertised once, behind already-queued updates", async () => {
  const conn = new GatedConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => PI_COMMANDS
  const { session, advertise } = makeAgent(proc, conn)

  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  conn.gateNextUpdate(gate)

  // An update already queued on the session's ordered chain, held by a slow client.
  const queued = session.sendSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier' } }
  })

  const advertised = advertise()
  release()
  await Promise.all([queued, advertised])

  assert.deepEqual(
    conn.updates.map(update => update.update.sessionUpdate),
    ['agent_message_chunk', 'available_commands_update'],
    'the deferred advertisement must not overtake updates already queued for the client'
  )

  const advertisements = commandUpdates(conn)
  assert.equal(advertisements.length, 1, 'exactly one advertisement is sent')
  assert.ok(advertisements[0]!.includes('pi-only'), "pi's discovered commands are advertised")
  assert.ok(advertisements[0]!.includes('compact'), 'adapter builtins are merged in')
  assert.ok(!advertisements[0]!.includes('legacy'), 'a successful discovery never mixes in the legacy list')
})

test('advertiseCommands: a delivery failure does not trigger a second downgraded advertisement', async () => {
  const conn = new GatedConnection()
  conn.failOn = 'available_commands_update'
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => PI_COMMANDS
  const { advertise } = makeAgent(proc, conn)

  await advertise()

  assert.deepEqual(
    conn.attempts,
    ['available_commands_update'],
    'delivery is attempted exactly once; a failed send must not select the legacy fallback'
  )
  assert.deepEqual(commandUpdates(conn), [], 'nothing was delivered')
})

test('advertiseCommands: a stale session chain cannot deliver commands after its replacement', async () => {
  const conn = new GatedConnection()
  const staleProc = new FakePiRpcProcess() as any
  const freshProc = new FakePiRpcProcess() as any
  staleProc.getCommands = async () => piCommands('stale-only')
  freshProc.getCommands = async () => piCommands('fresh-only')

  const staleSession = makeSession(conn, staleProc)
  const freshSession = makeSession(conn, freshProc)
  const agent = new PiAcpAgent(asAgentConn(conn))
  // session/load replaces the session registered under one sessionId.
  const sessions = { current: staleSession as PiAcpSession }
  ;(agent as any).sessions = {
    maybeGet: () => sessions.current,
    get: () => sessions.current
  } as any

  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  conn.gateNextUpdate(gate)

  // The old session's ordered chain is stuck on a slow client delivery, so its
  // advertisement waits behind it.
  const blocked = staleSession.sendSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old chain' } }
  })
  const staleAdvertisement = advertiseWith(agent, staleSession)
  await tick()

  // The replacement is registered and advertises on its own (unblocked) chain.
  sessions.current = freshSession
  await advertiseWith(agent, freshSession)

  release()
  await Promise.all([blocked, staleAdvertisement])

  const advertisements = commandUpdates(conn)
  assert.equal(advertisements.length, 1, 'the stale chain must not deliver its advertisement at all')
  assert.ok(advertisements[0]!.includes('fresh-only'), "the replacement's commands stay authoritative")
  assert.ok(!advertisements[0]!.includes('stale-only'))
  assert.deepEqual(
    conn.attempts,
    ['agent_message_chunk', 'available_commands_update'],
    'the stale publication is dropped inside the chain rather than sent late'
  )
})

test('advertiseCommands: failed pi discovery falls back only to adapter builtins', async () => {
  const conn = new GatedConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => {
    throw new Error('pi get_commands failed: unsupported')
  }
  const { advertise } = makeAgent(proc, conn)

  await advertise()

  const advertisements = commandUpdates(conn)
  assert.equal(advertisements.length, 1, 'the fallback is advertised exactly once')
  assert.ok(!advertisements[0]!.includes('legacy'), 'adapter never reads or advertises file templates')
  assert.ok(advertisements[0]!.includes('compact'), 'adapter builtins remain available')
  assert.ok(!advertisements[0]!.includes('pi-only'))
})
