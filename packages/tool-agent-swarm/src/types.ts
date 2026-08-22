import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { JsonValue, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionToken, ToolRestriction, ToolRunContext } from '@deepseek-ai/dsh-tools'

declare const swarmIdBrand: unique symbol
declare const invocationIdBrand: unique symbol
declare const swarmTaskIdBrand: unique symbol
declare const attemptIdBrand: unique symbol

export type SwarmId = string & { readonly [swarmIdBrand]: true }
export type InvocationId = string & { readonly [invocationIdBrand]: true }
export type SwarmTaskId = string & { readonly [swarmTaskIdBrand]: true }
export type AttemptId = string & { readonly [attemptIdBrand]: true }

export interface AgentSwarmTaskV01 {
  readonly key: string
  readonly description: string
  readonly objective: string
  readonly acceptance_criteria: readonly string[]
  readonly expected_outputs?: readonly string[]
}

export interface AgentSwarmRootArgsV01 {
  readonly goal: {
    readonly statement: string
    readonly success_criteria: readonly string[]
    readonly constraints?: readonly string[]
  }
  readonly tasks: readonly AgentSwarmTaskV01[]
}

export type DependencyFailurePolicy = 'fail' | 'skip' | 'partial'
export type InvocationFailureMode = 'collect_all' | 'fail_fast' | 'quorum'

export interface AgentSwarmTaskV02 extends AgentSwarmTaskV01 {
  readonly depends_on?: readonly string[]
  readonly dependency_failure?: DependencyFailurePolicy
}

export interface AgentSwarmRootArgsV02 extends Omit<AgentSwarmRootArgsV01, 'tasks'> {
  readonly tasks: readonly AgentSwarmTaskV02[]
  readonly failure_mode?: InvocationFailureMode
  readonly quorum?: number
}

export interface SwarmGoal {
  readonly version: 1
  readonly statement: string
  readonly successCriteria: readonly string[]
  readonly constraints: readonly string[]
}

export interface TaskGoal {
  readonly objective: string
  readonly acceptanceCriteria: readonly string[]
  readonly expectedOutputs: readonly string[]
}

export interface TaskReport {
  readonly reported_status: 'achieved' | 'not_achieved' | 'blocked'
  readonly summary: string
  readonly evidence: readonly {
    readonly claim: string
    readonly reference?: string
  }[]
  readonly output?: JsonValue
  readonly remaining_problems?: readonly string[]
}

export type TaskFailureKind =
  | 'launch_failed'
  | 'child_error'
  | 'max_tokens'
  | 'refusal'
  | 'timeout'
  | 'cancelled'
  | 'structured_result_missing'
  | 'structured_result_invalid'
  | 'structured_result_too_large'
  | 'dependency_failed'
  | 'dependency_deadlock'
  | 'cleanup_failed'
  | 'unknown'

export interface TaskFailure {
  readonly kind: TaskFailureKind
  readonly phase: 'launch' | 'running' | 'waiting' | 'finalizing' | 'scheduler'
  readonly scope: 'attempt' | 'task'
  readonly message: string
  readonly code?: string
  readonly taskId: SwarmTaskId
  readonly attemptId?: AttemptId
  readonly childId?: SessionId
  readonly occurredAt: number
  readonly cleanupDiagnostic?: string
}

export interface InvocationTaskResult {
  readonly taskId: SwarmTaskId
  readonly key: string
  readonly status: 'completed' | 'failed' | 'skipped' | 'aborted'
  readonly attempts: number
  readonly childId?: SessionId
  readonly report?: TaskReport
  readonly failure?: {
    readonly kind: string
    readonly message: string
  }
}

export interface AgentSwarmToolValue {
  readonly swarmId: SwarmId
  readonly invocationId: InvocationId
  readonly kind: 'root'
  readonly terminalReason: 'all_tasks_settled' | 'quorum_reached' | 'failed_fast'
  readonly tasks: readonly InvocationTaskResult[]
  readonly summary: {
    readonly completed: number
    readonly failed: number
    readonly skipped: number
    readonly aborted: number
    readonly descendants: 0
    readonly reportedAchieved: number
    readonly reportedNotAchieved: number
    readonly reportedBlocked: number
  }
}

export interface Config {
  readonly provider: string
  readonly toolName?: string
  readonly maxConcurrency?: number
  readonly maxTasks?: number
  readonly maxDepth?: number
  readonly swarmTimeoutMs?: number
  readonly attemptTimeoutMs?: number
  readonly maxTaskReportChars?: number
  readonly maxRenderedResultChars?: number
  readonly defaultFailureMode?: 'collect_all' | 'fail_fast'
  readonly nestedMode?: 'disabled'
  readonly childAgentOptions?: AgentOptions
  readonly childToolFilter?: ToolRestriction
}

export interface ResolvedConfig {
  readonly provider: string
  readonly toolName: string
  readonly maxConcurrency: number
  readonly maxTasks: number
  readonly maxDepth: number
  readonly swarmTimeoutMs: number
  readonly attemptTimeoutMs: number
  readonly maxTaskReportChars: number
  readonly maxRenderedResultChars: number
  readonly defaultFailureMode: 'collect_all' | 'fail_fast'
  readonly childAgentOptions?: AgentOptions
  readonly childToolFilter?: ToolRestriction
}

export type SwarmTaskViewStatus =
  | 'waiting'
  | 'ready'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timed_out'

export interface SwarmRunStartData {
  readonly swarmId: SwarmId
  readonly rootSessionId: SessionId
  readonly goalSummary: string
}

export interface SwarmInvocationStartData {
  readonly swarmId: SwarmId
  readonly invocationId: InvocationId
  readonly parentTaskId?: SwarmTaskId
  readonly callerSessionId: SessionId
}

export interface SwarmTaskCreatedData {
  readonly swarmId: SwarmId
  readonly invocationId: InvocationId
  readonly taskId: SwarmTaskId
  readonly key: string
  readonly label: string
  readonly objectiveSummary: string
  readonly acceptanceCriteriaSummary: readonly string[]
  readonly parentTaskId?: SwarmTaskId
  readonly dependencies: readonly SwarmTaskId[]
  readonly depth: number
}

export interface SwarmAttemptStartData {
  readonly swarmId: SwarmId
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly attemptNo: number
  readonly childId: SessionId
  readonly parentSessionId: SessionId
  readonly provider: string
  readonly local: boolean
  readonly requestedModel?: string
}

export interface SwarmTaskTransitionData {
  readonly swarmId: SwarmId
  readonly taskId: SwarmTaskId
  readonly from: SwarmTaskViewStatus
  readonly to: SwarmTaskViewStatus
  readonly reason?: string
}

export interface SwarmAttemptEndData {
  readonly swarmId: SwarmId
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  readonly failureKind?: TaskFailureKind
}

export interface SwarmInvocationEndData {
  readonly swarmId: SwarmId
  readonly invocationId: InvocationId
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
}

export interface SwarmRunEndData {
  readonly swarmId: SwarmId
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  readonly cancelled: number
  readonly timedOut: number
}

export interface RootInvocationInput {
  readonly rootAgent: Agent
  readonly callId: ToolRunContext['callId']
  readonly commandToken: ToolExecutionToken
  readonly args: AgentSwarmRootArgsV02
  readonly signal: AbortSignal
}

export interface InvocationHandle {
  readonly swarmId: SwarmId
  readonly invocationId: InvocationId
  readonly result: Promise<AgentSwarmToolValue>
  dispose(): Promise<void>
}

export interface TrajectorySink {
  append<T extends AgentSwarmEventType>(type: T, data: AgentSwarmEventMap[T]): void
}

export interface TrajectoryRecorderFactory {
  create(session: Session, swarmId: SwarmId): TrajectorySink
}

export interface AgentSwarmEventMap {
  'tool-agent-swarm/run-start': SwarmRunStartData
  'tool-agent-swarm/invocation-start': SwarmInvocationStartData
  'tool-agent-swarm/task-created': SwarmTaskCreatedData
  'tool-agent-swarm/attempt-start': SwarmAttemptStartData
  'tool-agent-swarm/task-transition': SwarmTaskTransitionData
  'tool-agent-swarm/attempt-end': SwarmAttemptEndData
  'tool-agent-swarm/invocation-end': SwarmInvocationEndData
  'tool-agent-swarm/run-end': SwarmRunEndData
}

export type AgentSwarmEventType = keyof AgentSwarmEventMap

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap extends AgentSwarmEventMap {}
}
