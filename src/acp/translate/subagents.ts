import type { SessionUpdate, StateUpdate, SubagentUpdate } from '@agentclientprotocol/sdk/unstable'

/**
 * pi-subagents async-status widget snapshots (see the extension's
 * `src/runs/shared/async-status-projection.ts`). The widget payload is
 * untrusted wire data: every field is validated before use and malformed
 * inputs are dropped silently, matching the lifecycle widget handler.
 */
const SNAPSHOT_WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
const SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot'
const SNAPSHOT_VERSION = 1
// The stock bounds depth at 3; untrusted payloads get a hard cycle guard.
const MAX_TREE_DEPTH = 32

type SubagentNodeState = 'queued' | 'running' | 'complete' | 'failed' | 'partial' | 'paused' | 'stopped' | 'rejected'

type SubagentNodeKind = 'subagent' | 'workflow' | 'step' | 'host-step'

type SubagentSnapshotNode = {
  id: string
  kind: SubagentNodeKind
  label: string
  state: SubagentNodeState
  agent?: string
  model?: string
  thinking?: string
  activity?: { state?: string; currentTool?: string }
  children?: SubagentSnapshotNode[]
}

type SubagentSnapshotOmitted = { runs: number; children: number; byteLimitExceeded: boolean }

type DecodedSubagentSnapshot = {
  runs: SubagentSnapshotNode[]
  omitted?: SubagentSnapshotOmitted
}

type SubagentChild = {
  id: string
  kind: 'subagent' | 'workflow' | 'step'
  parentId: string | null
  label: string
  description: string
  state: StateUpdate
}

const NODE_STATES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'complete',
  'failed',
  'partial',
  'paused',
  'stopped',
  'rejected'
])
const isNodeState = (value: string): value is SubagentNodeState => NODE_STATES.has(value)
const isNodeKind = (value: string): value is SubagentNodeKind =>
  value === 'subagent' || value === 'workflow' || value === 'step' || value === 'host-step'

/**
 * Decode the `subagent-async` widget lines. Absent or stringless lines mean
 * the widget was cleared (an empty snapshot); a present payload that carries
 * no snapshot prefix or fails validation returns null so the caller keeps its
 * current tracking untouched.
 */
export function decodeSubagentSnapshotWidget(widgetLines: unknown): DecodedSubagentSnapshot | null {
  const lines = Array.isArray(widgetLines) ? widgetLines.filter(line => typeof line === 'string') : []
  const encoded = lines.find(line => line.startsWith(SNAPSHOT_WIDGET_PREFIX))
  if (encoded === undefined) return lines.length ? null : { runs: [] }
  try {
    const parsed = JSON.parse(encoded.slice(SNAPSHOT_WIDGET_PREFIX.length)) as Record<string, unknown>
    if (parsed.kind !== SNAPSHOT_KIND || parsed.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.runs)) return null
    const runs = parsed.runs
      .map(node => parseSnapshotNode(node, 0))
      .filter((node): node is SubagentSnapshotNode => node !== null)
    return { runs, omitted: parseSnapshotOmitted(parsed.omitted) }
  } catch {
    return null
  }
}

function parseSnapshotOmitted(source: unknown): SubagentSnapshotOmitted | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  if (
    typeof record.runs !== 'number' ||
    typeof record.children !== 'number' ||
    typeof record.byteLimitExceeded !== 'boolean'
  )
    return undefined
  return { runs: record.runs, children: record.children, byteLimitExceeded: record.byteLimitExceeded }
}

function parseSnapshotNode(source: unknown, depth: number): SubagentSnapshotNode | null {
  if (typeof source !== 'object' || source === null || depth > MAX_TREE_DEPTH) return null
  const record = source as Record<string, unknown>
  const { id, kind, state } = record
  if (
    typeof id !== 'string' ||
    !id ||
    typeof kind !== 'string' ||
    !isNodeKind(kind) ||
    typeof state !== 'string' ||
    !isNodeState(state)
  )
    return null
  const activity = parseNodeActivity(record.activity)
  const node: SubagentSnapshotNode = {
    id,
    kind,
    label: typeof record.label === 'string' && record.label ? record.label : id,
    state
  }
  if (typeof record.agent === 'string' && record.agent) node.agent = record.agent
  if (typeof record.model === 'string' && record.model) node.model = record.model
  if (typeof record.thinking === 'string' && record.thinking) node.thinking = record.thinking
  if (activity) node.activity = activity
  if (Array.isArray(record.children)) {
    const children = record.children
      .map(child => parseSnapshotNode(child, depth + 1))
      .filter((child): child is SubagentSnapshotNode => child !== null)
    if (children.length) node.children = children
  }
  return node
}

function parseNodeActivity(source: unknown): SubagentSnapshotNode['activity'] | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const activity: NonNullable<SubagentSnapshotNode['activity']> = {}
  if (typeof record.state === 'string' && record.state) activity.state = record.state
  if (typeof record.currentTool === 'string' && record.currentTool) activity.currentTool = record.currentTool
  return activity.state || activity.currentTool ? activity : undefined
}

/**
 * Flatten the snapshot tree into ACP child sessions: every `subagent`,
 * `workflow` and `step` node in order, parents before children. `host-step`
 * nodes are the enclosing host run's own monitors, not child sessions, so
 * their whole subtree is skipped.
 */
export function collectSubagentChildren(runs: readonly SubagentSnapshotNode[]): SubagentChild[] {
  const children: SubagentChild[] = []
  const visit = (nodes: readonly SubagentSnapshotNode[], parentId: string | null): void => {
    for (const node of nodes) {
      if (node.kind === 'host-step') continue
      children.push({
        id: node.id,
        kind: node.kind,
        parentId,
        label: node.label,
        description: describeSubagentNode(node),
        state: subagentStateFor(node.state)
      })
      if (node.children) visit(node.children, node.id)
    }
  }
  visit(runs, null)
  return children
}

function subagentStateFor(state: SubagentNodeState): StateUpdate {
  switch (state) {
    case 'complete':
      return { state: 'idle', stopReason: 'end_turn' }
    case 'failed':
    case 'partial':
    case 'rejected':
      return { state: 'idle', stopReason: 'error' }
    case 'stopped':
      return { state: 'idle', stopReason: 'cancelled' }
    default:
      return { state: 'running' }
  }
}

function describeSubagentNode(node: SubagentSnapshotNode): string {
  const parts: string[] = [node.kind]
  if (node.agent) parts.push(node.agent)
  if (node.model) parts.push(node.model)
  if (node.thinking) parts.push(`thinking ${node.thinking}`)
  if (node.activity?.currentTool) parts.push(`tool ${node.activity.currentTool}`)
  else if (node.activity?.state) parts.push(node.activity.state)
  return parts.join(' · ')
}

/**
 * The per-snapshot child announcement. `capabilities` stays empty: pi-acp
 * cannot cancel an individual child, so `cancel` is never advertised.
 * `_meta.piSubagents` exposes the node kind, its enclosing node and the
 * snapshot's own omission counters.
 */
export function subagentUpdateFor(child: SubagentChild, omitted?: SubagentSnapshotOmitted): SessionUpdate {
  const update: SubagentUpdate & { sessionUpdate: 'subagent_update' } = {
    sessionUpdate: 'subagent_update',
    sessionId: child.id,
    title: child.label,
    description: child.description,
    capabilities: {},
    state: child.state,
    _meta: {
      piSubagents: {
        kind: child.kind,
        parentId: child.parentId,
        ...(omitted ? { omitted } : {})
      }
    }
  }
  return update
}

/** Final snapshot when a child's activity became unobservable (turn settled or child disappeared). */
export function subagentUnknownUpdate(sessionId: string): SessionUpdate {
  return { sessionUpdate: 'subagent_update', sessionId, state: { state: 'unknown' } }
}

/** The single parent-to-child message announcing a child to the client. */
export function subagentAnnouncementMessage(
  messageId: string,
  parentSessionId: string,
  child: SubagentChild
): SessionUpdate {
  return {
    sessionUpdate: 'session_message',
    messageId,
    senderSessionId: parentSessionId,
    recipientSessionId: child.id,
    content: [{ type: 'text', text: child.label }]
  }
}
