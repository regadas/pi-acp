import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Runner for the language-neutral golden fixtures in test/fixtures/golden/.
// The fixture format and execution contract are documented in
// test/fixtures/golden/README.md; that README is the portability spec a
// non-TypeScript implementation consumes, so behavior changes belong there.

type PromptStep = { op: 'prompt'; promptId: string; text: string }
type CancelStep = { op: 'cancel' }
type PiEventStep = { op: 'pi_event'; event: Record<string, unknown> }
type Step = PromptStep | CancelStep | PiEventStep

type PiEffect = { kind: 'prompt'; message: string } | { kind: 'abort' }
type AcpEffect =
  | { kind: 'session_update'; update: unknown }
  | { kind: 'stop'; promptId: string; stopReason: string }
  | { kind: 'error'; promptId: string; message: string }

type GoldenFixture = {
  formatVersion: number
  name: string
  description: string
  session: { sessionId: string; cwd: string; supportsTerminalOutputMeta?: boolean }
  steps: Step[]
  expected: { pi: unknown[]; acp: unknown[] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStep(raw: unknown, file: string, index: number): Step {
  if (!isRecord(raw)) throw new Error(`${file}: steps[${index}] must be an object`)
  switch (raw.op) {
    case 'prompt':
      if (typeof raw.promptId !== 'string' || typeof raw.text !== 'string') {
        throw new Error(`${file}: steps[${index}] prompt requires string promptId and text`)
      }
      return { op: 'prompt', promptId: raw.promptId, text: raw.text }
    case 'cancel':
      return { op: 'cancel' }
    case 'pi_event':
      if (!isRecord(raw.event)) {
        throw new Error(`${file}: steps[${index}] pi_event requires an object event`)
      }
      return { op: 'pi_event', event: raw.event }
    default:
      throw new Error(`${file}: steps[${index}] has unknown op ${JSON.stringify(raw.op)}`)
  }
}

function loadFixture(file: string, path: URL): GoldenFixture {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(raw)) throw new Error(`${file}: fixture must be a JSON object`)
  if (raw.formatVersion !== 1)
    throw new Error(`${file}: unsupported formatVersion ${JSON.stringify(raw.formatVersion)}`)
  if (typeof raw.name !== 'string' || !raw.name) throw new Error(`${file}: missing string name`)
  if (typeof raw.description !== 'string') throw new Error(`${file}: missing string description`)
  if (!isRecord(raw.session) || typeof raw.session.sessionId !== 'string' || typeof raw.session.cwd !== 'string') {
    throw new Error(`${file}: session requires string sessionId and cwd`)
  }
  const terminalMeta = raw.session.supportsTerminalOutputMeta
  if (terminalMeta !== undefined && typeof terminalMeta !== 'boolean') {
    throw new Error(`${file}: session.supportsTerminalOutputMeta must be a boolean when present`)
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${file}: steps must be a non-empty array`)
  if (!isRecord(raw.expected) || !Array.isArray(raw.expected.pi) || !Array.isArray(raw.expected.acp)) {
    throw new Error(`${file}: expected requires pi and acp arrays`)
  }
  return {
    formatVersion: raw.formatVersion,
    name: raw.name,
    description: raw.description,
    session: {
      sessionId: raw.session.sessionId,
      cwd: raw.session.cwd,
      supportsTerminalOutputMeta: terminalMeta
    },
    steps: raw.steps.map((step, index) => parseStep(step, file, index)),
    expected: { pi: raw.expected.pi, acp: raw.expected.acp }
  }
}

class RecordingConnection extends FakeAgentSideConnection {
  constructor(private readonly record: (msg: SessionNotification) => void) {
    super()
  }

  override async sessionUpdate(msg: SessionNotification): Promise<void> {
    this.record(msg)
    await super.sessionUpdate(msg)
  }
}

class RecordingPiRpcProcess extends FakePiRpcProcess {
  constructor(private readonly record: (effect: PiEffect) => void) {
    super()
  }

  override async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.record({ kind: 'prompt', message })
    await super.prompt(message, attachments)
  }

  override async abort(): Promise<void> {
    this.record({ kind: 'abort' })
    await super.abort()
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function runFixture(fixture: GoldenFixture): Promise<{ pi: PiEffect[]; acp: AcpEffect[] }> {
  const piLog: PiEffect[] = []
  const acpLog: AcpEffect[] = []

  const conn = new RecordingConnection(msg => {
    assert.equal(msg.sessionId, fixture.session.sessionId, 'every session/update must carry the fixture sessionId')
    acpLog.push({ kind: 'session_update', update: msg.update })
  })
  const proc = new RecordingPiRpcProcess(effect => piLog.push(effect))

  const session = new PiAcpSession({
    sessionId: fixture.session.sessionId,
    cwd: fixture.session.cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutputMeta: fixture.session.supportsTerminalOutputMeta ?? false
  })

  const settledPromptIds = new Set<string>()
  const seenPromptIds = new Set<string>()

  for (const step of fixture.steps) {
    switch (step.op) {
      case 'prompt': {
        assert.equal(seenPromptIds.has(step.promptId), false, `duplicate promptId ${step.promptId}`)
        seenPromptIds.add(step.promptId)
        void session.prompt(step.text).then(
          stopReason => {
            settledPromptIds.add(step.promptId)
            acpLog.push({ kind: 'stop', promptId: step.promptId, stopReason })
          },
          (err: unknown) => {
            settledPromptIds.add(step.promptId)
            acpLog.push({ kind: 'error', promptId: step.promptId, message: String(err) })
          }
        )
        break
      }
      case 'cancel':
        await session.cancel()
        break
      case 'pi_event':
        proc.emit(step.event)
        break
    }
    // Drain the event loop to quiescence after every step so effect order is
    // deterministic (the contract a non-TS runner must reproduce).
    await tick()
  }

  await tick()

  const unsettled = [...seenPromptIds].filter(promptId => !settledPromptIds.has(promptId))
  assert.deepEqual(unsettled, [], `prompt(s) never settled: ${unsettled.join(', ') || '(none)'}`)

  return { pi: piLog, acp: acpLog }
}

const goldenDir = new URL('../fixtures/golden/', import.meta.url)
const fixtureFiles = readdirSync(goldenDir)
  .filter(file => file.endsWith('.json'))
  .sort()

assert.ok(fixtureFiles.length > 0, `no golden fixtures found in ${fileURLToPath(goldenDir)}`)

for (const file of fixtureFiles) {
  const fixture = loadFixture(file, new URL(file, goldenDir))
  test(`golden: ${fixture.name}`, { timeout: 5000 }, async () => {
    const actual = await runFixture(fixture)
    // JSON round-trip drops undefined-valued fields so the comparison is
    // structural over plain JSON values, matching what a non-TS runner sees.
    assert.deepEqual(JSON.parse(JSON.stringify(actual.pi)), fixture.expected.pi, 'pi channel mismatch')
    assert.deepEqual(JSON.parse(JSON.stringify(actual.acp)), fixture.expected.acp, 'acp channel mismatch')
  })
}
