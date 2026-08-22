import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './types.js'

const PACKAGE_NAME = 'dsh-tool-agent-swarm'
const EVENT_TYPES = new Set([
  'tool-agent-swarm/run-start',
  'tool-agent-swarm/invocation-start',
  'tool-agent-swarm/task-created',
  'tool-agent-swarm/attempt-start',
  'tool-agent-swarm/task-transition',
  'tool-agent-swarm/attempt-end',
  'tool-agent-swarm/invocation-end',
  'tool-agent-swarm/run-end',
])
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'skipped', 'cancelled', 'timed_out'])
const ALLOWED_TRANSITIONS = new Set([
  'ready>starting',
  'ready>cancelled',
  'ready>timed_out',
  'starting>running',
  'starting>failed',
  'starting>cancelled',
  'starting>timed_out',
  'running>completed',
  'running>failed',
  'running>cancelled',
  'running>timed_out',
])

export const name = 'agent-swarm-invariant'
export const inject = ['invariants']

interface InvocationTrace {
  ended: boolean
  readonly tasks: Set<string>
}

interface TaskTrace {
  readonly invocationId: string
  status: string
  currentAttemptId?: string
}

interface AttemptTrace {
  readonly taskId: string
  ended: boolean
}

interface RunTrace {
  ended: boolean
  readonly invocations: Map<string, InvocationTrace>
  readonly tasks: Map<string, TaskTrace>
  readonly attempts: Map<string, AttemptTrace>
}

type TrajectoryTrace = Map<string, RunTrace>

function isSwarmEvent(event: SessionEvent): boolean {
  return event.type.startsWith('tool-agent-swarm/')
}

function recordOf(event: SessionEvent, fail: InvariantFailure): Record<string, unknown> {
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${event.type} data must be a JSON object`)
  }
  return data as Record<string, unknown>
}

function stringId(value: unknown, label: string, fail: InvariantFailure): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function openRun(trace: TrajectoryTrace, runId: string, eventType: string, fail: InvariantFailure): RunTrace {
  const run = trace.get(runId)
  if (run === undefined) fail(`${eventType} has no matching run-start for swarm ${runId}`)
  if (run.ended) fail(`${eventType} appears after run-end for swarm ${runId}`)
  return run
}

function cloneTrace(source: TrajectoryTrace, event: SessionEvent, fail: InvariantFailure): TrajectoryTrace {
  const trace = new Map(source)
  if (event.type === 'tool-agent-swarm/run-start') return trace
  const data = recordOf(event, fail)
  const swarmId = stringId(data.swarmId, `${event.type} swarmId`, fail)
  const sourceRun = source.get(swarmId)
  if (sourceRun !== undefined) {
    trace.set(swarmId, {
      ended: sourceRun.ended,
      invocations: new Map([...sourceRun.invocations].map(([id, invocation]) => [
        id,
        { ended: invocation.ended, tasks: new Set(invocation.tasks) },
      ])),
      tasks: new Map([...sourceRun.tasks].map(([id, task]) => [id, { ...task }])),
      attempts: new Map([...sourceRun.attempts].map(([id, attempt]) => [id, { ...attempt }])),
    })
  }
  return trace
}

export function applyTrajectoryEvent(
  trace: TrajectoryTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (!EVENT_TYPES.has(event.type)) fail(`unknown AgentSwarm trajectory event type ${event.type}`)
  if (event.ignorable !== true) fail(`${event.type} must carry ignorable: true`)
  const data = recordOf(event, fail)
  const swarmId = stringId(data.swarmId, `${event.type} swarmId`, fail)

  switch (event.type) {
    case 'tool-agent-swarm/run-start': {
      if (trace.has(swarmId)) fail(`run-start repeats swarm ${swarmId}`)
      stringId(data.rootSessionId, 'run-start rootSessionId', fail)
      if (typeof data.goalSummary !== 'string') fail('run-start goalSummary must be a string')
      trace.set(swarmId, {
        ended: false,
        invocations: new Map(),
        tasks: new Map(),
        attempts: new Map(),
      })
      return
    }
    case 'tool-agent-swarm/invocation-start': {
      const run = openRun(trace, swarmId, event.type, fail)
      const invocationId = stringId(data.invocationId, 'invocation-start invocationId', fail)
      stringId(data.callerSessionId, 'invocation-start callerSessionId', fail)
      if (data.parentTaskId !== undefined) stringId(data.parentTaskId, 'invocation-start parentTaskId', fail)
      if (run.invocations.has(invocationId)) fail(`invocation-start repeats invocation ${invocationId}`)
      run.invocations.set(invocationId, { ended: false, tasks: new Set() })
      return
    }
    case 'tool-agent-swarm/task-created': {
      const run = openRun(trace, swarmId, event.type, fail)
      const invocationId = stringId(data.invocationId, 'task-created invocationId', fail)
      const invocation = run.invocations.get(invocationId)
      if (invocation === undefined || invocation.ended) {
        fail(`task-created references missing or ended invocation ${invocationId}`)
      }
      const taskId = stringId(data.taskId, 'task-created taskId', fail)
      if (run.tasks.has(taskId)) fail(`task-created repeats task ${taskId}`)
      if (data.parentTaskId !== undefined) stringId(data.parentTaskId, 'task-created parentTaskId', fail)
      if (!Array.isArray(data.dependencies)) fail('task-created dependencies must be an array')
      for (const dependency of data.dependencies) stringId(dependency, 'task-created dependency', fail)
      run.tasks.set(taskId, { invocationId, status: 'ready' })
      invocation.tasks.add(taskId)
      return
    }
    case 'tool-agent-swarm/attempt-start': {
      const run = openRun(trace, swarmId, event.type, fail)
      const taskId = stringId(data.taskId, 'attempt-start taskId', fail)
      const task = run.tasks.get(taskId)
      if (task === undefined) fail(`attempt-start has no created task ${taskId}`)
      if (task.status !== 'starting') fail(`attempt-start task ${taskId} is ${task.status}, expected starting`)
      const attemptId = stringId(data.attemptId, 'attempt-start attemptId', fail)
      if (run.attempts.has(attemptId)) fail(`attempt-start repeats attempt ${attemptId}`)
      if (task.currentAttemptId !== undefined) fail(`attempt-start repeats task attempt for ${taskId}`)
      stringId(data.childId, 'attempt-start childId', fail)
      run.attempts.set(attemptId, { taskId, ended: false })
      task.currentAttemptId = attemptId
      return
    }
    case 'tool-agent-swarm/task-transition': {
      const run = openRun(trace, swarmId, event.type, fail)
      const taskId = stringId(data.taskId, 'task-transition taskId', fail)
      const task = run.tasks.get(taskId)
      if (task === undefined) fail(`task-transition has no created task ${taskId}`)
      if (typeof data.from !== 'string' || typeof data.to !== 'string') {
        fail('task-transition from/to must be strings')
      }
      if (task.status !== data.from) {
        fail(`task-transition for ${taskId} starts at ${String(data.from)}, expected ${task.status}`)
      }
      if (TERMINAL_TASK_STATES.has(task.status)) fail(`task-transition updates terminal task ${taskId}`)
      if (!ALLOWED_TRANSITIONS.has(`${data.from}>${data.to}`)) {
        fail(`task-transition ${String(data.from)}>${String(data.to)} is invalid`)
      }
      const attempt = task.currentAttemptId === undefined
        ? undefined
        : run.attempts.get(task.currentAttemptId)
      if (data.to === 'running' && (attempt === undefined || attempt.ended)) {
        fail(`task-transition starting>running for ${taskId} has no open attempt`)
      }
      if (data.from === 'running' && TERMINAL_TASK_STATES.has(data.to as string)
        && (attempt === undefined || !attempt.ended)) {
        fail(`terminal task-transition for ${taskId} precedes attempt-end`)
      }
      task.status = data.to
      return
    }
    case 'tool-agent-swarm/attempt-end': {
      const run = openRun(trace, swarmId, event.type, fail)
      const attemptId = stringId(data.attemptId, 'attempt-end attemptId', fail)
      const attempt = run.attempts.get(attemptId)
      if (attempt === undefined) fail(`attempt-end has no matching attempt-start ${attemptId}`)
      if (attempt.ended) fail(`attempt-end repeats attempt ${attemptId}`)
      const taskId = stringId(data.taskId, 'attempt-end taskId', fail)
      if (attempt.taskId !== taskId) fail(`attempt-end ${attemptId} changed task identity`)
      const task = run.tasks.get(taskId)
      if (task?.status !== 'running') fail(`attempt-end task ${taskId} is not running`)
      if (task.currentAttemptId !== attemptId) fail(`attempt-end ${attemptId} is not current for task ${taskId}`)
      attempt.ended = true
      return
    }
    case 'tool-agent-swarm/invocation-end': {
      const run = openRun(trace, swarmId, event.type, fail)
      const invocationId = stringId(data.invocationId, 'invocation-end invocationId', fail)
      const invocation = run.invocations.get(invocationId)
      if (invocation === undefined) fail(`invocation-end has no matching invocation-start ${invocationId}`)
      if (invocation.ended) fail(`invocation-end repeats invocation ${invocationId}`)
      const unfinished = [...invocation.tasks].filter(taskId => {
        const task = run.tasks.get(taskId)
        return task === undefined || !TERMINAL_TASK_STATES.has(task.status)
      })
      if (unfinished.length > 0) fail(`invocation-end leaves tasks open: ${unfinished.join(', ')}`)
      const openAttempts = [...run.attempts]
        .filter(([, attempt]) => invocation.tasks.has(attempt.taskId) && !attempt.ended)
        .map(([id]) => id)
      if (openAttempts.length > 0) fail(`invocation-end leaves attempts open: ${openAttempts.join(', ')}`)
      invocation.ended = true
      return
    }
    case 'tool-agent-swarm/run-end': {
      const run = openRun(trace, swarmId, event.type, fail)
      const openInvocations = [...run.invocations].filter(([, invocation]) => !invocation.ended).map(([id]) => id)
      if (openInvocations.length > 0) fail(`run-end leaves invocations open: ${openInvocations.join(', ')}`)
      const openAttempts = [...run.attempts].filter(([, attempt]) => !attempt.ended).map(([id]) => id)
      if (openAttempts.length > 0) fail(`run-end leaves attempts open: ${openAttempts.join(', ')}`)
      const unfinished = [...run.tasks].filter(([, task]) => !TERMINAL_TASK_STATES.has(task.status)).map(([id]) => id)
      if (unfinished.length > 0) fail(`run-end leaves tasks open: ${unfinished.join(', ')}`)
      run.ended = true
      return
    }
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, TrajectoryTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: TrajectoryTrace }>()
  const seed = (session: Session): TrajectoryTrace => {
    const trace: TrajectoryTrace = new Map()
    for (const event of session.events.filter(isSwarmEvent)) applyTrajectoryEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }

  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', session => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isSwarmEvent(event)) return
    const trace = cloneTrace(traces.get(session) ?? seed(session), event, fail)
    applyTrajectoryEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!isSwarmEvent(event)) return
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching AgentSwarm trajectory validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
