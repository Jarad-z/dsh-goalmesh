import type {
  ChatConversationViewNode,
  ConversationEventInput,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AgentSwarmEventMap,
  AgentSwarmEventType,
  SwarmTaskViewStatus,
} from 'dsh-tool-agent-swarm'

const ROOT_PARENT = '$root'
export const MAX_PROJECTED_TREE_DEPTH = 32

export type SwarmTrajectoryStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'

export type SwarmProjectedTaskStatus = SwarmTaskViewStatus
  | 'waiting_children'
  | 'ready_to_resume'
  | 'interrupted'
export type SwarmTreeDiagnostic = 'orphan' | 'cycle' | 'depth-cap' | 'dependency-deadlock'

export interface SwarmTimelineEntry {
  readonly seq: number
  readonly time: number
  readonly type: AgentSwarmEventType
  readonly summary: string
}

export interface SwarmAttemptData {
  readonly attemptId: string
  readonly attemptNo: number
  readonly childId: SessionId
  readonly parentSessionId: SessionId
  readonly provider: string
  readonly local: boolean
  readonly requestedModel?: string
  readonly startSeq: number
  readonly startedAt: number
  readonly endSeq?: number
  readonly endedAt?: number
  readonly outcome?: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  readonly failureKind?: string
}

interface SwarmTaskState {
  readonly taskId: string
  readonly invocationId: string
  readonly key: string
  readonly label: string
  readonly objectiveSummary: string
  readonly acceptanceCriteriaSummary: readonly string[]
  readonly parentTaskId?: string
  readonly dependencies: readonly string[]
  readonly depth: number
  readonly createdSeq: number
  readonly createdAt: number
  readonly status: SwarmTaskViewStatus
  readonly timeline: readonly SwarmTimelineEntry[]
}

interface SwarmInvocationState {
  readonly invocationId: string
  readonly parentTaskId?: string
  readonly callerSessionId: SessionId
  readonly status?: AgentSwarmEventMap['tool-agent-swarm/invocation-end']['status']
}

export interface SwarmTrajectoryState {
  readonly swarmId: string
  readonly rootSessionId: SessionId
  readonly goalSummary: string
  readonly tasksById: ReadonlyMap<string, SwarmTaskState>
  readonly taskOrder: readonly string[]
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>
  readonly attemptsByTask: ReadonlyMap<string, readonly SwarmAttemptData[]>
  readonly invocationsById: ReadonlyMap<string, SwarmInvocationState>
  readonly runEnd?: AgentSwarmEventMap['tool-agent-swarm/run-end']
  readonly warnings: readonly string[]
  readonly revision: number
}

export interface SwarmTaskNodeData {
  readonly taskId: string
  readonly invocationId: string
  readonly key: string
  readonly label: string
  readonly objectiveSummary: string
  readonly acceptanceCriteriaSummary: readonly string[]
  readonly parentTaskId?: string
  readonly dependencies: readonly string[]
  readonly dependents: readonly string[]
  readonly depth: number
  readonly status: SwarmProjectedTaskStatus
  readonly createdAt: number
  readonly attempts: readonly SwarmAttemptData[]
  readonly timeline: readonly SwarmTimelineEntry[]
  readonly diagnostics: readonly SwarmTreeDiagnostic[]
  readonly children: readonly SwarmTaskNodeData[]
}

export interface SwarmTrajectoryChatData {
  readonly swarmId: string
  readonly goalSummary: string
  readonly status: SwarmTrajectoryStatus
  readonly settled: number
  readonly total: number
  readonly roots: readonly SwarmTaskNodeData[]
  readonly unlinked: readonly SwarmTaskNodeData[]
  readonly warnings: readonly string[]
  readonly incomplete: boolean
  readonly revision: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'agent-swarm-trajectory': SwarmTrajectoryChatData
  }
}

type SwarmUpdateEventType = Exclude<AgentSwarmEventType, 'tool-agent-swarm/run-start'>

/** Closed recognition of the seven durable trajectory update events. */
export function isSwarmUpdateEvent(event: SessionEvent): event is SessionEvent<SwarmUpdateEventType> {
  switch (event.type) {
    case 'tool-agent-swarm/invocation-start':
    case 'tool-agent-swarm/task-created':
    case 'tool-agent-swarm/attempt-start':
    case 'tool-agent-swarm/task-transition':
    case 'tool-agent-swarm/attempt-end':
    case 'tool-agent-swarm/invocation-end':
    case 'tool-agent-swarm/run-end':
      return true
    default:
      return false
  }
}

function locationClosed(location: ConversationLocation): boolean {
  if (location.kind === 'step') {
    return location.step.status === 'closed' || location.turn.status === 'closed'
  }
  return location.kind === 'turn' && location.turn.status === 'closed'
}

function timeline(event: SessionEvent<SwarmUpdateEventType>, summary: string): SwarmTimelineEntry {
  return { seq: event.seq, time: event.time, type: event.type, summary }
}

function warning(state: SwarmTrajectoryState, message: string): SwarmTrajectoryState {
  return { ...state, warnings: [...state.warnings, message], revision: state.revision + 1 }
}

function updateTask(
  state: SwarmTrajectoryState,
  taskId: string,
  update: (task: SwarmTaskState) => SwarmTaskState,
): SwarmTrajectoryState {
  const task = state.tasksById.get(taskId)
  if (task === undefined) return warning(state, `update references missing task ${taskId}`)
  const tasksById = new Map(state.tasksById)
  tasksById.set(taskId, update(task))
  return { ...state, tasksById, revision: state.revision + 1 }
}

function foldEvent(state: SwarmTrajectoryState, event: SessionEvent<SwarmUpdateEventType>): SwarmTrajectoryState {
  switch (event.type) {
    case 'tool-agent-swarm/invocation-start': {
      const invocationsById = new Map(state.invocationsById)
      invocationsById.set(String(event.data.invocationId), {
        invocationId: String(event.data.invocationId),
        callerSessionId: event.data.callerSessionId,
        ...event.data.parentTaskId === undefined ? {} : { parentTaskId: String(event.data.parentTaskId) },
      })
      return { ...state, invocationsById, revision: state.revision + 1 }
    }
    case 'tool-agent-swarm/task-created': {
      const taskId = String(event.data.taskId)
      const parentTaskId = event.data.parentTaskId === undefined ? undefined : String(event.data.parentTaskId)
      const tasksById = new Map(state.tasksById)
      tasksById.set(taskId, {
        taskId,
        invocationId: String(event.data.invocationId),
        key: event.data.key,
        label: event.data.label,
        objectiveSummary: event.data.objectiveSummary,
        acceptanceCriteriaSummary: event.data.acceptanceCriteriaSummary,
        ...parentTaskId === undefined ? {} : { parentTaskId },
        dependencies: event.data.dependencies.map(String),
        depth: event.data.depth,
        createdSeq: event.seq,
        createdAt: event.time,
        status: event.data.dependencies.length === 0 ? 'ready' : 'waiting',
        timeline: [timeline(event, 'created')],
      })
      const childrenByParent = new Map(state.childrenByParent)
      const parentKey = parentTaskId ?? ROOT_PARENT
      childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), taskId])
      const attemptsByTask = new Map(state.attemptsByTask)
      attemptsByTask.set(taskId, [])
      return {
        ...state,
        tasksById,
        taskOrder: [...state.taskOrder, taskId],
        childrenByParent,
        attemptsByTask,
        revision: state.revision + 1,
      }
    }
    case 'tool-agent-swarm/attempt-start': {
      const taskId = String(event.data.taskId)
      if (!state.tasksById.has(taskId)) return warning(state, `attempt-start references missing task ${taskId}`)
      const attemptsByTask = new Map(state.attemptsByTask)
      attemptsByTask.set(taskId, [...(attemptsByTask.get(taskId) ?? []), {
        attemptId: String(event.data.attemptId),
        attemptNo: event.data.attemptNo,
        childId: event.data.childId,
        parentSessionId: event.data.parentSessionId,
        provider: event.data.provider,
        local: event.data.local,
        ...event.data.requestedModel === undefined ? {} : { requestedModel: event.data.requestedModel },
        startSeq: event.seq,
        startedAt: event.time,
      }])
      const next = updateTask(state, taskId, task => ({
        ...task,
        timeline: [...task.timeline, timeline(event, `attempt ${event.data.attemptNo} started`)],
      }))
      return { ...next, attemptsByTask }
    }
    case 'tool-agent-swarm/task-transition': {
      const taskId = String(event.data.taskId)
      return updateTask(state, taskId, task => ({
        ...task,
        status: event.data.to,
        timeline: [...task.timeline, timeline(
          event,
          `${event.data.from} → ${event.data.to}${event.data.reason === undefined ? '' : ` (${event.data.reason})`}`,
        )],
      }))
    }
    case 'tool-agent-swarm/attempt-end': {
      const taskId = String(event.data.taskId)
      const attempts = state.attemptsByTask.get(taskId)
      if (attempts === undefined) return warning(state, `attempt-end references missing task ${taskId}`)
      const attemptId = String(event.data.attemptId)
      let found = false
      const attemptsByTask = new Map(state.attemptsByTask)
      attemptsByTask.set(taskId, attempts.map((attempt) => {
        if (attempt.attemptId !== attemptId) return attempt
        found = true
        return {
          ...attempt,
          endSeq: event.seq,
          endedAt: event.time,
          outcome: event.data.outcome,
          ...event.data.failureKind === undefined ? {} : { failureKind: event.data.failureKind },
        }
      }))
      if (!found) return warning(state, `attempt-end references missing attempt ${attemptId}`)
      const next = updateTask(state, taskId, task => ({
        ...task,
        timeline: [...task.timeline, timeline(event, `attempt ended: ${event.data.outcome}`)],
      }))
      return { ...next, attemptsByTask }
    }
    case 'tool-agent-swarm/invocation-end': {
      const invocationId = String(event.data.invocationId)
      const current = state.invocationsById.get(invocationId)
      if (current === undefined) return warning(state, `invocation-end references missing invocation ${invocationId}`)
      const invocationsById = new Map(state.invocationsById)
      invocationsById.set(invocationId, { ...current, status: event.data.status })
      return { ...state, invocationsById, revision: state.revision + 1 }
    }
    case 'tool-agent-swarm/run-end':
      return { ...state, runEnd: event.data, revision: state.revision + 1 }
  }
  return state
}

function projectedStatus(task: SwarmTaskState, interrupted: boolean): SwarmProjectedTaskStatus {
  if (!interrupted) return task.status
  return ['completed', 'failed', 'skipped', 'cancelled', 'timed_out'].includes(task.status)
    ? task.status
    : 'interrupted'
}

function buildForest(state: SwarmTrajectoryState, interrupted: boolean): {
  roots: SwarmTaskNodeData[]
  unlinked: SwarmTaskNodeData[]
  warnings: string[]
} {
  const visited = new Set<string>()
  const warnings: string[] = []

  const markDescendants = (taskId: string): void => {
    const queue = [...(state.childrenByParent.get(taskId) ?? [])]
    while (queue.length > 0) {
      const childId = queue.shift()
      if (childId === undefined || visited.has(childId)) continue
      visited.add(childId)
      queue.push(...(state.childrenByParent.get(childId) ?? []))
    }
  }

  const build = (
    taskId: string,
    path: ReadonlySet<string>,
    level: number,
    initialDiagnostics: readonly SwarmTreeDiagnostic[] = [],
  ): SwarmTaskNodeData | undefined => {
    const task = state.tasksById.get(taskId)
    if (task === undefined) return undefined
    const dependents = state.taskOrder.filter(candidateId =>
      state.tasksById.get(candidateId)?.dependencies.includes(taskId) === true)
    const diagnostics = new Set(initialDiagnostics)
    if (task.timeline.some(entry => entry.summary.includes('(dependency_deadlock)'))) {
      diagnostics.add('dependency-deadlock')
    }
    if (path.has(taskId)) {
      diagnostics.add('cycle')
      warnings.push(`cycle detected at task ${taskId}`)
      return {
        ...task,
        status: projectedStatus(task, interrupted),
        attempts: state.attemptsByTask.get(taskId) ?? [],
        dependents,
        diagnostics: [...diagnostics],
        children: [],
      }
    }
    visited.add(taskId)
    if (level >= MAX_PROJECTED_TREE_DEPTH) {
      diagnostics.add('depth-cap')
      warnings.push(`tree depth capped at task ${taskId}`)
      markDescendants(taskId)
      return {
        ...task,
        status: projectedStatus(task, interrupted),
        attempts: state.attemptsByTask.get(taskId) ?? [],
        dependents,
        diagnostics: [...diagnostics],
        children: [],
      }
    }
    const nextPath = new Set(path)
    nextPath.add(taskId)
    const children = (state.childrenByParent.get(taskId) ?? [])
      .map(childId => build(childId, nextPath, level + 1))
      .filter((child): child is SwarmTaskNodeData => child !== undefined)
    return {
      ...task,
      status: projectedStatus(task, interrupted),
      attempts: state.attemptsByTask.get(taskId) ?? [],
      dependents,
      diagnostics: [...diagnostics],
      children,
    }
  }

  const roots = (state.childrenByParent.get(ROOT_PARENT) ?? [])
    .map(taskId => build(taskId, new Set(), 0))
    .filter((task): task is SwarmTaskNodeData => task !== undefined)
  const unlinked: SwarmTaskNodeData[] = []
  for (const taskId of state.taskOrder) {
    if (visited.has(taskId)) continue
    const task = state.tasksById.get(taskId)
    if (task === undefined) continue
    const diagnostic: SwarmTreeDiagnostic = task.parentTaskId !== undefined
      && !state.tasksById.has(task.parentTaskId) ? 'orphan' : 'cycle'
    warnings.push(`${diagnostic} task ${taskId}`)
    const projected = build(taskId, new Set(), 0, [diagnostic])
    if (projected !== undefined) unlinked.push(projected)
  }
  return { roots, unlinked, warnings }
}

function projectTrajectory(
  context: ConversationNodeContext<SwarmTrajectoryState>,
  location: ConversationLocation,
): SwarmTrajectoryChatData {
  const state = context.state as SwarmTrajectoryState
  const interrupted = state.runEnd === undefined && locationClosed(location)
  const forest = buildForest(state, interrupted)
  const statuses = state.taskOrder.map(taskId => state.tasksById.get(taskId))
    .filter((task): task is SwarmTaskState => task !== undefined)
    .map(task => projectedStatus(task, interrupted))
  const settled = statuses.filter(status =>
    ['completed', 'failed', 'skipped', 'cancelled', 'timed_out', 'interrupted'].includes(status)).length
  const warnings = [...state.warnings, ...forest.warnings]
  return {
    swarmId: state.swarmId,
    goalSummary: state.goalSummary,
    status: state.runEnd?.status ?? (interrupted ? 'interrupted' : 'running'),
    settled,
    total: state.taskOrder.length,
    roots: forest.roots,
    unlinked: forest.unlinked,
    warnings,
    incomplete: interrupted || warnings.length > 0,
    revision: state.revision,
  }
}

/** Durable Agent Swarm event family folded into one keyed Chat node. */
export const swarmTrajectoryDefinition: ConversationNodeDefinition<SwarmTrajectoryState> = {
  kind: 'agent-swarm-trajectory',
  target: 'chat',
  match(event: ConversationEventInput['event']) {
    if (event.type === 'tool-agent-swarm/run-start') {
      return { id: String(event.data.swarmId), role: 'start' }
    }
    if (isSwarmUpdateEvent(event)) return { id: String(event.data.swarmId), role: 'update' }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'tool-agent-swarm/run-start') {
      throw new Error('agent-swarm-trajectory start requires tool-agent-swarm/run-start')
    }
    return {
      swarmId: String(match.event.data.swarmId),
      rootSessionId: match.event.data.rootSessionId,
      goalSummary: match.event.data.goalSummary,
      tasksById: new Map(),
      taskOrder: [],
      childrenByParent: new Map(),
      attemptsByTask: new Map(),
      invocationsById: new Map(),
      warnings: [],
      revision: 0,
    }
  },
  update(context, match) {
    const state = context.state as SwarmTrajectoryState
    return isSwarmUpdateEvent(match.event) ? foldEvent(state, match.event) : state
  },
  buildViewNode(context): ChatConversationViewNode | null {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'agent-swarm-trajectory',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: projectTrajectory(context, context.start.location),
    }
  },
}
