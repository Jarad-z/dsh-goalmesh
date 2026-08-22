import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Deadline } from '@deepseek-ai/dsh-timeout'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { dependencyDeadlockCandidates } from './dag.js'
import { SwarmRunError } from './errors.js'
import type { SwarmRunFailureKind } from './errors.js'
import { ATTEMPT_TIMEOUT_CODE, SubagentLauncher } from './launcher.js'
import type { LaunchedTask, Launcher, MaterializedTask, TaskCompletionOutcome } from './launcher.js'
import type { ScopedSwarmLease } from './nested-tool.js'
import { buildChildPrompt } from './prompt.js'
import type { ResolvedDependencyPrompt } from './prompt.js'
import type {
  AgentSwarmTaskV02,
  AgentSwarmToolValue,
  AttemptId,
  DependencyFailurePolicy,
  InvocationHandle,
  InvocationFailureMode,
  InvocationId,
  InvocationTaskResult,
  LeaseToken,
  NestedInvocationInput,
  ResolvedConfig,
  RootInvocationInput,
  SwarmGoal,
  SwarmId,
  SwarmLease,
  SwarmTaskId,
  SwarmTaskViewStatus,
  TaskFailure,
  TaskGoal,
  TaskReport,
  TrajectoryRecorderFactory,
  TrajectorySink,
} from './types.js'
import type { ValidatedRootArgsV02 } from './validation.js'
import {
  assertNestedArgsV03,
  assertRootArgsV02,
  boundedText,
  sanitizeDiagnostic,
} from './validation.js'

export const SWARM_TIMEOUT_CODE = 'AGENT_SWARM_TIMEOUT'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface TaskSpec {
  readonly id: SwarmTaskId
  readonly key: string
  readonly invocationId: InvocationId
  readonly parentTaskId?: SwarmTaskId
  readonly description: string
  readonly depth: number
  readonly taskGoal: TaskGoal
  readonly dependencies: readonly SwarmTaskId[]
  readonly dependencyFailure: DependencyFailurePolicy
}

type TaskTerminal =
  | { readonly kind: 'completed'; readonly report: TaskReport }
  | { readonly kind: 'failed'; readonly failure: TaskFailure }
  | { readonly kind: 'skipped'; readonly failure: TaskFailure }
  | { readonly kind: 'aborted'; readonly failure: TaskFailure }

interface TaskState {
  readonly spec: TaskSpec
  readonly openChildInvocationIds: Set<InvocationId>
  phase: 'waiting' | 'ready' | 'starting' | 'running' | 'waiting_children' | 'ready_to_resume' | 'terminal'
  viewStatus: SwarmTaskViewStatus
  unmetDependencies: number
  attemptNo: number
  materializedDependencies?: readonly ResolvedDependencyPrompt[]
  currentAttemptId?: AttemptId
  currentChildId?: LaunchedTask['childId']
  terminal?: TaskTerminal
}

interface ActiveAttempt {
  readonly id: AttemptId
  readonly taskId: SwarmTaskId
  readonly deadline: Deadline
  readonly leaseToken?: LeaseToken
  launched?: LaunchedTask
  holdsPermit: boolean
  pendingOutcome?: TaskCompletionOutcome
}

interface RunCancellation {
  readonly kind: SwarmRunFailureKind
  readonly message: string
}

interface InvocationPolicyStop {
  readonly reason: 'failed_fast' | 'quorum_reached'
  readonly message: string
}

interface InvocationState {
  readonly id: InvocationId
  readonly commandToken: ToolExecutionToken
  readonly callerAgent: Agent
  readonly parentTaskId?: SwarmTaskId
  readonly taskIds: SwarmTaskId[]
  readonly remainingTaskIds: Set<SwarmTaskId>
  readonly completion: Deferred<AgentSwarmToolValue>
  readonly controller: AbortController
  readonly policyController: AbortController
  readonly abortSignal?: AbortSignal
  readonly onAbort?: () => void
  readonly failureMode: InvocationFailureMode
  readonly quorum?: number
  phase: 'open' | 'awaiting_resume' | 'settled'
  terminalReason: AgentSwarmToolValue['terminalReason']
  policyStop?: InvocationPolicyStop
  cancellation?: RunCancellation
}

interface LeaseRecord {
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  callerAgent?: Agent
}

type Command =
  | { readonly kind: 'schedule' }
  | { readonly kind: 'published'; readonly attemptId: AttemptId; readonly launched: LaunchedTask }
  | { readonly kind: 'launch-rejected'; readonly attemptId: AttemptId; readonly error: unknown }
  | { readonly kind: 'attempt-settled'; readonly attemptId: AttemptId; readonly outcome: TaskCompletionOutcome }
  | { readonly kind: 'cancel-run'; readonly cancellation: RunCancellation }
  | { readonly kind: 'cancel-invocation'; readonly invocationId: InvocationId; readonly cancellation: RunCancellation }
  | { readonly kind: 'lease-revoked'; readonly token: LeaseToken; readonly reason: string }

interface RunState {
  readonly id: SwarmId
  readonly commandToken: ToolExecutionToken
  readonly rootAgent: Agent
  readonly rootInvocationId: InvocationId
  readonly goal: SwarmGoal
  readonly absoluteMaxDepth: number
  readonly invocations: Map<InvocationId, InvocationState>
  readonly invocationsByCommand: Map<ToolExecutionToken, InvocationId>
  readonly tasks: Map<SwarmTaskId, TaskState>
  readonly dependents: Map<SwarmTaskId, SwarmTaskId[]>
  readonly ready: SwarmTaskId[]
  readonly readyToResume: SwarmTaskId[]
  readonly activeAttempts: Map<AttemptId, ActiveAttempt>
  readonly activeLeases: Map<LeaseToken, LeaseRecord>
  readonly recorder: TrajectorySink
  readonly controller: AbortController
  readonly swarmDeadline: Deadline
  readonly onAbort: () => void
  readonly commands: Command[]
  phase: 'running' | 'cancelling' | 'finished'
  cancellation?: RunCancellation
  unfinishedTaskCount: number
  permitsInUse: number
  draining: boolean
  handleCount: number
}

interface CoordinatorOptions {
  readonly launcher?: Launcher
  readonly id?: () => string
  readonly now?: () => number
}

function taskFailure(
  taskId: SwarmTaskId,
  attemptId: AttemptId | undefined,
  kind: TaskFailure['kind'],
  phase: TaskFailure['phase'],
  message: string,
  now: () => number,
  childId?: LaunchedTask['childId'],
  scope: TaskFailure['scope'] = attemptId === undefined ? 'task' : 'attempt',
): TaskFailure {
  return {
    kind,
    phase,
    scope,
    message,
    taskId,
    ...attemptId === undefined ? {} : { attemptId },
    ...childId === undefined ? {} : { childId },
    occurredAt: now(),
  }
}

function eventTerminalStatus(terminal: TaskTerminal): SwarmTaskViewStatus {
  if (terminal.kind === 'completed') return 'completed'
  if (terminal.kind === 'skipped') return 'skipped'
  if (terminal.failure.kind === 'timeout') return 'timed_out'
  if (terminal.kind === 'aborted') return 'cancelled'
  return 'failed'
}

function attemptOutcome(terminal: TaskTerminal): 'completed' | 'failed' | 'cancelled' | 'timed_out' {
  if (terminal.kind === 'completed') return 'completed'
  if (terminal.failure.kind === 'timeout') return 'timed_out'
  if (terminal.kind === 'aborted') return 'cancelled'
  return 'failed'
}

function invocationEventStatus(
  invocation: InvocationState,
  tasks: ReadonlyMap<SwarmTaskId, TaskState>,
): 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out' {
  if (invocation.cancellation?.kind === 'deadline_exceeded') return 'timed_out'
  if (invocation.cancellation !== undefined) return 'cancelled'
  const terminals = invocation.taskIds.map(taskId => tasks.get(taskId)?.terminal)
  return terminals.every(terminal => terminal?.kind === 'completed') ? 'completed' : 'partial'
}

export class SwarmCoordinator {
  private readonly launcher: Launcher
  private readonly id: () => string
  private readonly now: () => number
  private readonly runs = new Map<SwarmId, RunState>()
  private readonly rootInvocationsByCommand = new Map<ToolExecutionToken, {
    readonly swarmId: SwarmId
    readonly invocationId: InvocationId
  }>()
  private accepting = true
  private disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly recorderFactory: TrajectoryRecorderFactory,
    options: CoordinatorOptions = {},
  ) {
    this.launcher = options.launcher ?? new SubagentLauncher(ctx, config)
    this.id = options.id ?? randomUUID
    this.now = options.now ?? Date.now
  }

  invokeRoot(input: RootInvocationInput): InvocationHandle {
    if (!this.accepting) throw new Error('agent_swarm is shutting down and no longer accepts invocations')
    const admitted = assertRootArgsV02(input.args, this.config.maxTasks, this.config.defaultFailureMode)
    const existingRef = this.rootInvocationsByCommand.get(input.commandToken)
    if (existingRef !== undefined) {
      const existingRun = this.runs.get(existingRef.swarmId)
      const existingInvocation = existingRun?.invocations.get(existingRef.invocationId)
      if (existingRun === undefined || existingInvocation === undefined) {
        throw new Error('agent_swarm command index references a released invocation')
      }
      existingRun.handleCount++
      return this.createHandle(existingRun, existingInvocation)
    }
    const provider = this.ctx.subagents.getProvider(this.config.provider)
    if (provider === undefined) throw new Error(`subagent provider "${this.config.provider}" is not registered`)
    if (!provider.capabilities.outputSchema || !provider.capabilities.depthLimit) {
      throw new Error(
        `subagent provider "${provider.name}" must support outputSchema and depthLimit for agent_swarm v0.3`,
      )
    }
    if (this.config.nestedMode === 'local-only' && !provider.capabilities.scopedSetup) {
      throw new Error(`subagent provider "${provider.name}" must support scopedSetup for nestedMode "local-only"`)
    }
    const rootDepth = delegationDepthOf(input.rootAgent)
    if (rootDepth !== 0) {
      throw new Error('the global agent_swarm Tool accepts only top-level callers; nested callers require a scoped lease')
    }
    const absoluteMaxDepth = rootDepth + this.config.maxDepth
    if (!Number.isSafeInteger(absoluteMaxDepth)) throw new Error('agent_swarm absolute maxDepth exceeds safe integer range')

    const swarmId = this.nextId<SwarmId>('swarm')
    const invocationId = this.nextId<InvocationId>('invocation')
    const goal: SwarmGoal = {
      version: 1,
      statement: input.args.goal.statement,
      successCriteria: [...input.args.goal.success_criteria],
      constraints: [...(input.args.goal.constraints ?? [])],
    }
    const controller = new AbortController()
    const upstream = AbortSignal.any([input.signal, controller.signal])
    const swarmDeadline = deadline(upstream, this.config.swarmTimeoutMs, SWARM_TIMEOUT_CODE)
    const recorder = this.recorderFactory.create(input.rootAgent.session, swarmId)
    const rootInvocation = this.createInvocation({
      id: invocationId,
      commandToken: input.commandToken,
      callerAgent: input.rootAgent,
      admitted,
    })
    const run = {} as RunState
    const onAbort = (): void => {
      const cancellation: RunCancellation = timeoutOf(swarmDeadline.signal, SWARM_TIMEOUT_CODE) !== undefined
        ? { kind: 'deadline_exceeded', message: 'agent_swarm exceeded its swarm deadline' }
        : controller.signal.aborted && controller.signal.reason instanceof SwarmRunError
          ? { kind: controller.signal.reason.kind, message: controller.signal.reason.message }
          : { kind: 'cancelled', message: 'agent_swarm was cancelled by its caller' }
      this.enqueue(run, { kind: 'cancel-run', cancellation })
    }
    Object.assign(run, {
      id: swarmId,
      commandToken: input.commandToken,
      rootAgent: input.rootAgent,
      rootInvocationId: invocationId,
      goal,
      absoluteMaxDepth,
      invocations: new Map([[invocationId, rootInvocation]]),
      invocationsByCommand: new Map([[input.commandToken, invocationId]]),
      tasks: new Map<SwarmTaskId, TaskState>(),
      dependents: new Map<SwarmTaskId, SwarmTaskId[]>(),
      ready: [],
      readyToResume: [],
      activeAttempts: new Map<AttemptId, ActiveAttempt>(),
      activeLeases: new Map<LeaseToken, LeaseRecord>(),
      recorder,
      controller,
      swarmDeadline,
      onAbort,
      commands: [],
      phase: 'running',
      unfinishedTaskCount: 0,
      permitsInUse: 0,
      draining: false,
      handleCount: 1,
    } satisfies RunState)

    this.runs.set(swarmId, run)
    this.rootInvocationsByCommand.set(input.commandToken, { swarmId, invocationId })
    recorder.append('tool-agent-swarm/run-start', {
      swarmId,
      rootSessionId: input.rootAgent.session.id,
      goalSummary: boundedText(goal.statement, 500),
    })
    recorder.append('tool-agent-swarm/invocation-start', {
      swarmId,
      invocationId,
      callerSessionId: input.rootAgent.session.id,
    })
    this.registerTasks(run, rootInvocation, input.args.tasks, admitted, 1)
    swarmDeadline.signal.addEventListener('abort', onAbort, { once: true })
    if (swarmDeadline.signal.aborted) onAbort()
    else this.enqueue(run, { kind: 'schedule' })
    return this.createHandle(run, rootInvocation)
  }

  dispose(): Promise<void> {
    this.accepting = false
    this.disposal ??= (async () => {
      const pending: Promise<unknown>[] = []
      for (const run of this.runs.values()) {
        if (run.phase === 'finished') continue
        this.enqueue(run, {
          kind: 'cancel-run',
          cancellation: { kind: 'plugin_disposed', message: 'agent_swarm plugin was disposed' },
        })
        const root = run.invocations.get(run.rootInvocationId)
        if (root !== undefined) pending.push(root.completion.promise.catch(() => undefined))
      }
      await Promise.all(pending)
      this.rootInvocationsByCommand.clear()
      this.runs.clear()
    })()
    return this.disposal
  }

  private createInvocation(input: {
    readonly id: InvocationId
    readonly commandToken: ToolExecutionToken
    readonly callerAgent: Agent
    readonly parentTaskId?: SwarmTaskId
    readonly admitted: ValidatedRootArgsV02
    readonly abortSignal?: AbortSignal
    readonly onAbort?: () => void
  }): InvocationState {
    const completion = deferred<AgentSwarmToolValue>()
    void completion.promise.catch(() => {})
    return {
      id: input.id,
      commandToken: input.commandToken,
      callerAgent: input.callerAgent,
      ...input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId },
      taskIds: [],
      remainingTaskIds: new Set(),
      completion,
      controller: new AbortController(),
      policyController: new AbortController(),
      ...input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal },
      ...input.onAbort === undefined ? {} : { onAbort: input.onAbort },
      failureMode: input.admitted.failureMode,
      ...input.admitted.quorum === undefined ? {} : { quorum: input.admitted.quorum },
      phase: 'open',
      terminalReason: 'all_tasks_settled',
    }
  }

  private registerTasks(
    run: RunState,
    invocation: InvocationState,
    sources: readonly AgentSwarmTaskV02[],
    admitted: ValidatedRootArgsV02,
    depth: number,
    parentTaskId?: SwarmTaskId,
  ): void {
    const taskIds = sources.map(() => this.nextId<SwarmTaskId>('task'))
    const taskIdsByKey = new Map(sources.map((source, index) => [source.key, taskIds[index] as SwarmTaskId]))
    sources.forEach((source, index): void => {
      const taskId = taskIds[index]
      if (taskId === undefined) throw new Error('agent_swarm failed to allocate an admitted task')
      const dependencies = (admitted.dependenciesByKey.get(source.key) ?? []).map((key) => {
        const dependencyId = taskIdsByKey.get(key)
        if (dependencyId === undefined) throw new Error(`admitted dependency ${key} has no task ID`)
        return dependencyId
      })
      const spec: TaskSpec = {
        id: taskId,
        key: source.key,
        invocationId: invocation.id,
        ...parentTaskId === undefined ? {} : { parentTaskId },
        description: source.description,
        depth,
        dependencies,
        dependencyFailure: admitted.dependencyFailureByKey.get(source.key) ?? 'fail',
        taskGoal: {
          objective: source.objective,
          acceptanceCriteria: [...source.acceptance_criteria],
          expectedOutputs: [...(source.expected_outputs ?? [])],
        },
      }
      const task: TaskState = {
        spec,
        openChildInvocationIds: new Set(),
        phase: dependencies.length === 0 ? 'ready' : 'waiting',
        viewStatus: dependencies.length === 0 ? 'ready' : 'waiting',
        unmetDependencies: dependencies.length,
        attemptNo: 0,
        ...dependencies.length === 0 ? { materializedDependencies: [] } : {},
      }
      run.tasks.set(taskId, task)
      run.dependents.set(taskId, [])
      invocation.taskIds.push(taskId)
      invocation.remainingTaskIds.add(taskId)
      run.unfinishedTaskCount++
      if (task.phase === 'ready') run.ready.push(taskId)
    })
    for (const taskId of taskIds) {
      const task = run.tasks.get(taskId)
      if (task === undefined) throw new Error('agent_swarm failed to register an admitted task')
      for (const dependencyId of task.spec.dependencies) run.dependents.get(dependencyId)?.push(taskId)
      run.recorder.append('tool-agent-swarm/task-created', {
        swarmId: run.id,
        invocationId: invocation.id,
        taskId,
        key: boundedText(task.spec.key, 120),
        label: boundedText(task.spec.description, 200),
        objectiveSummary: boundedText(task.spec.taskGoal.objective, 500),
        acceptanceCriteriaSummary: task.spec.taskGoal.acceptanceCriteria.slice(0, 12)
          .map(value => boundedText(value, 240)),
        ...parentTaskId === undefined ? {} : { parentTaskId },
        dependencies: task.spec.dependencies,
        depth,
      })
    }
  }

  private invokeNested(swarmId: SwarmId, token: LeaseToken, input: NestedInvocationInput): InvocationHandle {
    if (!this.accepting) throw new Error('agent_swarm is shutting down and no longer accepts nested invocations')
    const run = this.runs.get(swarmId)
    if (run === undefined || run.phase === 'finished') throw new Error('nested agent_swarm lease references an inactive Swarm')
    const existingId = run.invocationsByCommand.get(input.commandToken)
    if (existingId !== undefined) {
      const existing = run.invocations.get(existingId)
      if (existing === undefined) throw new Error('nested command index references a released invocation')
      run.handleCount++
      return this.createHandle(run, existing)
    }
    const lease = run.activeLeases.get(token)
    if (lease === undefined) throw new Error('nested agent_swarm lease is revoked or unknown')
    if (lease.callerAgent !== input.callerAgent) throw new Error('nested agent_swarm caller does not match the leased child')
    const attempt = run.activeAttempts.get(lease.attemptId)
    const parentTask = run.tasks.get(lease.taskId)
    if (attempt === undefined || parentTask === undefined
      || parentTask.currentAttemptId !== lease.attemptId || attempt.taskId !== parentTask.spec.id) {
      throw new Error('nested agent_swarm lease failed attempt fencing')
    }
    if (parentTask.phase !== 'running' || !attempt.holdsPermit) {
      throw new Error(`nested agent_swarm parent task is ${parentTask.phase}, expected running with a permit`)
    }
    if (parentTask.spec.depth >= this.config.maxDepth) {
      throw new Error(`budget_exhausted: nested depth ${parentTask.spec.depth + 1} exceeds maxDepth ${this.config.maxDepth}`)
    }
    if (input.signal.aborted) throw new Error('nested agent_swarm was cancelled before admission')
    const remainingTasks = this.config.maxTasks - run.tasks.size
    const admitted = assertNestedArgsV03(input.args, remainingTasks, this.config.defaultFailureMode)
    const invocationId = this.nextId<InvocationId>('invocation')
    const abortSignal = AbortSignal.any([input.signal, attempt.deadline.signal])
    const onAbort = (): void => {
      const parentTimedOut = timeoutOf(attempt.deadline.signal, ATTEMPT_TIMEOUT_CODE) !== undefined
      const swarmTimedOut = timeoutOf(run.swarmDeadline.signal, SWARM_TIMEOUT_CODE) !== undefined
      const cancellation: RunCancellation = parentTimedOut || swarmTimedOut
        ? {
            kind: 'deadline_exceeded',
            message: parentTimedOut
              ? 'parent attempt timed out while nested work was active'
              : 'agent_swarm exceeded its swarm deadline while nested work was active',
          }
        : { kind: 'cancelled', message: 'nested agent_swarm invocation was cancelled' }
      this.enqueue(run, { kind: 'cancel-invocation', invocationId, cancellation })
    }
    const invocation = this.createInvocation({
      id: invocationId,
      commandToken: input.commandToken,
      callerAgent: input.callerAgent,
      parentTaskId: parentTask.spec.id,
      admitted,
      abortSignal,
      onAbort,
    })
    abortSignal.addEventListener('abort', onAbort, { once: true })
    run.invocations.set(invocationId, invocation)
    run.invocationsByCommand.set(input.commandToken, invocationId)
    run.handleCount++
    parentTask.openChildInvocationIds.add(invocationId)
    attempt.holdsPermit = false
    run.permitsInUse--
    this.transition(run, parentTask, 'waiting_children')
    run.recorder.append('tool-agent-swarm/invocation-start', {
      swarmId: run.id,
      invocationId,
      parentTaskId: parentTask.spec.id,
      callerSessionId: input.callerAgent.session.id,
    })
    this.registerTasks(run, invocation, input.args.tasks, admitted, parentTask.spec.depth + 1, parentTask.spec.id)
    this.assertLedger(run)
    if (abortSignal.aborted) onAbort()
    else this.enqueue(run, { kind: 'schedule' })
    return this.createHandle(run, invocation)
  }

  private issueLease(run: RunState, task: TaskState, attemptId: AttemptId): ScopedSwarmLease {
    const token = Symbol('agent-swarm-lease') as LeaseToken
    const lease: SwarmLease = Object.freeze({
      token,
      swarmId: run.id,
      parentTaskId: task.spec.id,
      attemptId,
      goalVersion: run.goal.version,
      invokeNested: (input: NestedInvocationInput) => this.invokeNested(run.id, token, input),
    })
    const binding: ScopedSwarmLease = Object.freeze({
      lease,
      bindCaller: (agent: Agent): void => { this.bindLease(run.id, token, agent) },
      revoke: (reason: string): void => { this.enqueue(run, { kind: 'lease-revoked', token, reason }) },
    })
    run.activeLeases.set(token, { taskId: task.spec.id, attemptId })
    return binding
  }

  private bindLease(swarmId: SwarmId, token: LeaseToken, agent: Agent): void {
    const run = this.runs.get(swarmId)
    const record = run?.activeLeases.get(token)
    if (run === undefined || record === undefined || run.phase === 'finished') {
      throw new Error('cannot bind a revoked AgentSwarm lease')
    }
    if (record.callerAgent !== undefined && record.callerAgent !== agent) {
      throw new Error('AgentSwarm lease is already bound to a different child')
    }
    record.callerAgent = agent
  }

  private nextId<T extends string>(kind: string): T {
    return `${kind}-${this.id()}` as T
  }

  private createHandle(run: RunState, invocation: InvocationState): InvocationHandle {
    let disposed = false
    return {
      swarmId: run.id,
      invocationId: invocation.id,
      result: invocation.completion.promise,
      dispose: async (): Promise<void> => {
        if (disposed) return
        disposed = true
        run.handleCount--
        if (run.handleCount < 0) {
          run.handleCount = 0
          throw new Error('agent_swarm invocation handle released more than once')
        }
        this.releaseFinishedRun(run)
      },
    }
  }

  private releaseFinishedRun(run: RunState): void {
    if (run.phase !== 'finished' || run.handleCount !== 0) return
    this.rootInvocationsByCommand.delete(run.commandToken)
    this.runs.delete(run.id)
  }

  private enqueue(run: RunState, command: Command): void {
    if (run.phase === 'finished') {
      if (command.kind === 'published') void command.launched.dispose().catch(() => {})
      return
    }
    run.commands.push(command)
    if (run.draining) return
    run.draining = true
    queueMicrotask(() => { this.drain(run) })
  }

  private drain(run: RunState): void {
    const effects: (() => void)[] = []
    try {
      while (run.commands.length > 0 && run.phase !== 'finished') {
        const command = run.commands.shift()
        if (command === undefined) break
        this.reduce(run, command, effects)
        this.assertLedger(run)
        this.finishIfComplete(run)
      }
    } catch (error: unknown) {
      this.ctx.logger.error(`agent_swarm state corruption in ${run.id}: ${sanitizeDiagnostic(error)}`)
      this.cancelRunCommitted(run, {
        kind: 'state_corrupted',
        message: `agent_swarm state corrupted: ${sanitizeDiagnostic(error)}`,
      }, effects)
      this.finishIfComplete(run)
    } finally {
      run.draining = false
    }
    for (const effect of effects) effect()
    if (run.commands.length > 0 && run.phase !== 'finished') {
      run.draining = true
      queueMicrotask(() => { this.drain(run) })
    }
  }

  private reduce(run: RunState, command: Command, effects: (() => void)[]): void {
    switch (command.kind) {
      case 'schedule':
        this.schedule(run, effects)
        return
      case 'published':
        this.onPublished(run, command.attemptId, command.launched, effects)
        return
      case 'launch-rejected':
        this.onLaunchRejected(run, command.attemptId, command.error, effects)
        this.schedule(run, effects)
        return
      case 'attempt-settled':
        this.onAttemptSettled(run, command.attemptId, command.outcome, effects)
        this.schedule(run, effects)
        return
      case 'cancel-run':
        this.cancelRunCommitted(run, command.cancellation, effects)
        return
      case 'cancel-invocation':
        this.cancelInvocationCommitted(run, command.invocationId, command.cancellation, effects)
        this.schedule(run, effects)
        return
      case 'lease-revoked':
        this.revokeLeaseCommitted(run, command.token, command.reason, effects)
        return
    }
  }

  private schedule(run: RunState, effects: (() => void)[]): void {
    if (run.phase !== 'running') return
    while (run.permitsInUse < this.config.maxConcurrency && run.readyToResume.length > 0) {
      const taskId = run.readyToResume.shift()
      if (taskId === undefined) break
      const task = run.tasks.get(taskId)
      const attempt = task?.currentAttemptId === undefined ? undefined : run.activeAttempts.get(task.currentAttemptId)
      if (task === undefined || task.phase !== 'ready_to_resume' || attempt === undefined) continue
      if (attempt.pendingOutcome !== undefined || attempt.deadline.signal.aborted) {
        if (attempt.pendingOutcome !== undefined && task.openChildInvocationIds.size === 0) {
          this.settleAttempt(run, attempt, attempt.pendingOutcome, effects)
        }
        continue
      }
      attempt.holdsPermit = true
      run.permitsInUse++
      this.transition(run, task, 'running')
      for (const invocation of run.invocations.values()) {
        if (invocation.parentTaskId === taskId && invocation.phase === 'awaiting_resume') {
          this.settleInvocation(run, invocation)
        }
      }
    }
    while (run.permitsInUse < this.config.maxConcurrency && run.ready.length > 0) {
      const taskId = run.ready.shift()
      if (taskId === undefined) break
      const task = run.tasks.get(taskId)
      if (task === undefined || task.phase !== 'ready') throw new Error(`ready queue references invalid task ${taskId}`)
      const invocation = run.invocations.get(task.spec.invocationId)
      if (invocation === undefined || invocation.cancellation !== undefined || invocation.policyStop !== undefined) {
        throw new Error(`ready task ${taskId} belongs to an unavailable invocation`)
      }
      task.attemptNo++
      const attemptId = this.nextId<AttemptId>('attempt')
      task.currentAttemptId = attemptId
      this.transition(run, task, 'starting')
      const attemptDeadline = deadline(
        AbortSignal.any([
          run.swarmDeadline.signal,
          invocation.controller.signal,
          invocation.policyController.signal,
        ]),
        this.config.attemptTimeoutMs,
        ATTEMPT_TIMEOUT_CODE,
      )
      const lease = this.config.nestedMode === 'local-only' && task.spec.depth < this.config.maxDepth
        ? this.issueLease(run, task, attemptId)
        : undefined
      run.activeAttempts.set(attemptId, {
        id: attemptId,
        taskId,
        deadline: attemptDeadline,
        ...lease === undefined ? {} : { leaseToken: lease.lease.token },
        holdsPermit: true,
      })
      run.permitsInUse++
      effects.push(() => { this.launch(run, task, attemptId, attemptDeadline.signal, lease) })
    }
    this.auditIfStalled(run)
  }

  private launch(
    run: RunState,
    task: TaskState,
    attemptId: AttemptId,
    signal: AbortSignal,
    lease?: ScopedSwarmLease,
  ): void {
    const invocation = run.invocations.get(task.spec.invocationId)
    if (invocation === undefined) {
      this.enqueue(run, { kind: 'launch-rejected', attemptId, error: new Error('task invocation disappeared') })
      return
    }
    const nesting = this.config.nestedMode !== 'local-only'
      ? 'disabled' as const
      : lease === undefined ? 'depth-exhausted' as const : 'available' as const
    const materialized: MaterializedTask = {
      taskId: task.spec.id,
      attemptId,
      description: task.spec.description,
      prompt: buildChildPrompt(
        run.goal,
        task.spec.taskGoal,
        this.config.toolName,
        task.materializedDependencies ?? [],
        nesting,
      ),
      parentAgent: invocation.callerAgent,
      absoluteMaxDepth: run.absoluteMaxDepth,
      signal,
      ...lease === undefined ? {} : { lease },
    }
    void this.launcher.start(materialized).then(
      launched => this.enqueue(run, { kind: 'published', attemptId, launched }),
      error => this.enqueue(run, { kind: 'launch-rejected', attemptId, error }),
    )
  }

  private onPublished(run: RunState, attemptId: AttemptId, launched: LaunchedTask, effects: (() => void)[]): void {
    const attempt = run.activeAttempts.get(attemptId)
    const task = attempt === undefined ? undefined : run.tasks.get(attempt.taskId)
    if (attempt === undefined || task === undefined || task.currentAttemptId !== attemptId || task.phase !== 'starting') {
      effects.push(() => { void launched.dispose().catch(() => {}) })
      return
    }
    attempt.launched = launched
    task.currentChildId = launched.childId
    const invocation = run.invocations.get(task.spec.invocationId)
    if (invocation === undefined) throw new Error(`published task ${task.spec.id} lost its invocation`)
    run.recorder.append('tool-agent-swarm/attempt-start', {
      swarmId: run.id,
      taskId: task.spec.id,
      attemptId,
      attemptNo: task.attemptNo,
      childId: launched.childId,
      parentSessionId: invocation.callerAgent.session.id,
      provider: this.config.provider,
      local: launched.local,
      ...launched.requestedModel === undefined ? {} : { requestedModel: launched.requestedModel },
    })
    this.transition(run, task, 'running')
    effects.push(() => {
      void launched.settled.then(
        outcome => this.enqueue(run, { kind: 'attempt-settled', attemptId, outcome }),
        error => this.enqueue(run, {
          kind: 'attempt-settled',
          attemptId,
          outcome: {
            ok: false,
            failure: taskFailure(
              task.spec.id,
              attemptId,
              'unknown',
              'scheduler',
              `launcher settlement failed: ${sanitizeDiagnostic(error)}`,
              this.now,
              launched.childId,
            ),
          },
        }),
      )
    })
    if (attempt.deadline.signal.aborted) effects.push(() => { void launched.dispose().catch(() => {}) })
  }

  private onLaunchRejected(
    run: RunState,
    attemptId: AttemptId,
    error: unknown,
    effects: (() => void)[],
  ): void {
    const attempt = run.activeAttempts.get(attemptId)
    if (attempt === undefined) return
    const task = run.tasks.get(attempt.taskId)
    if (task === undefined || task.currentAttemptId !== attemptId || task.phase !== 'starting') return
    const signal = attempt.deadline.signal
    const invocation = run.invocations.get(task.spec.invocationId)
    const failure = run.cancellation?.kind === 'deadline_exceeded'
      ? taskFailure(task.spec.id, attemptId, 'timeout', 'launch', 'swarm deadline elapsed before child publication', this.now)
      : timeoutOf(signal, ATTEMPT_TIMEOUT_CODE) !== undefined
        ? taskFailure(task.spec.id, attemptId, 'timeout', 'launch', 'child attempt timed out before publication', this.now)
        : invocation?.policyStop !== undefined
          ? taskFailure(task.spec.id, attemptId, 'cancelled', 'launch', invocation.policyStop.message, this.now)
          : signal.aborted
            ? taskFailure(task.spec.id, attemptId, 'cancelled', 'launch', 'child start was cancelled before publication', this.now)
            : taskFailure(
                task.spec.id,
                attemptId,
                'launch_failed',
                'launch',
                `child start failed: ${sanitizeDiagnostic(error)}`,
                this.now,
              )
    attempt.deadline[Symbol.dispose]()
    run.activeAttempts.delete(attemptId)
    if (attempt.holdsPermit) run.permitsInUse--
    if (attempt.leaseToken !== undefined) this.revokeLeaseCommitted(run, attempt.leaseToken, 'child launch rejected', effects)
    this.terminalTask(run, task, failure.kind === 'cancelled'
      ? { kind: 'aborted', failure }
      : { kind: 'failed', failure }, effects)
  }

  private onAttemptSettled(
    run: RunState,
    attemptId: AttemptId,
    outcome: TaskCompletionOutcome,
    effects: (() => void)[],
  ): void {
    const attempt = run.activeAttempts.get(attemptId)
    if (attempt === undefined) return
    const task = run.tasks.get(attempt.taskId)
    if (task === undefined || task.currentAttemptId !== attemptId || task.phase === 'terminal') return
    if (task.phase === 'waiting_children' || task.phase === 'ready_to_resume') {
      attempt.pendingOutcome ??= outcome
      if (attempt.leaseToken !== undefined) {
        this.revokeLeaseCommitted(run, attempt.leaseToken, 'parent attempt settled while nested work was open', effects)
      }
      if (task.openChildInvocationIds.size === 0) this.settleAttempt(run, attempt, attempt.pendingOutcome, effects)
      return
    }
    if (task.phase !== 'running') return
    this.settleAttempt(run, attempt, outcome, effects)
  }

  private settleAttempt(
    run: RunState,
    attempt: ActiveAttempt,
    outcome: TaskCompletionOutcome,
    effects: (() => void)[],
  ): void {
    const task = run.tasks.get(attempt.taskId)
    if (task === undefined || task.currentAttemptId !== attempt.id || task.openChildInvocationIds.size !== 0) return
    const attemptTimedOut = timeoutOf(attempt.deadline.signal, ATTEMPT_TIMEOUT_CODE) !== undefined
    attempt.deadline[Symbol.dispose]()
    run.activeAttempts.delete(attempt.id)
    if (attempt.holdsPermit) run.permitsInUse--
    this.removeFromQueue(run.readyToResume, task.spec.id)
    if (attempt.leaseToken !== undefined) this.revokeLeaseCommitted(run, attempt.leaseToken, 'attempt settled', effects)
    const normalized = !outcome.ok && outcome.failure.kind === 'cancelled'
      && (run.cancellation?.kind === 'deadline_exceeded' || attemptTimedOut)
      ? {
          ok: false as const,
          failure: {
            ...outcome.failure,
            kind: 'timeout' as const,
            message: run.cancellation?.kind === 'deadline_exceeded'
              ? 'swarm deadline elapsed before child quiescence'
              : 'child attempt timed out before quiescence',
          },
        }
      : outcome
    const terminal: TaskTerminal = normalized.ok
      ? { kind: 'completed', report: normalized.report }
      : normalized.failure.kind === 'cancelled'
        ? { kind: 'aborted', failure: normalized.failure }
        : { kind: 'failed', failure: normalized.failure }
    run.recorder.append('tool-agent-swarm/attempt-end', {
      swarmId: run.id,
      taskId: task.spec.id,
      attemptId: attempt.id,
      outcome: attemptOutcome(terminal),
      ...terminal.kind === 'completed' ? {} : { failureKind: terminal.failure.kind },
    })
    this.terminalTask(run, task, terminal, effects)
  }

  private cancelRunCommitted(run: RunState, cancellation: RunCancellation, effects: (() => void)[]): void {
    if (run.cancellation !== undefined) return
    run.cancellation = cancellation
    run.phase = 'cancelling'
    if (!run.controller.signal.aborted) run.controller.abort(new SwarmRunError(cancellation.kind, cancellation.message))
    run.ready.splice(0)
    for (const task of run.tasks.values()) {
      if (task.phase !== 'ready' && task.phase !== 'waiting') continue
      const failure = taskFailure(
        task.spec.id,
        undefined,
        cancellation.kind === 'deadline_exceeded' ? 'timeout' : 'cancelled',
        'scheduler',
        cancellation.message,
        this.now,
      )
      this.terminalTask(run, task, { kind: 'aborted', failure }, effects, {
        evaluatePolicy: false,
        propagate: false,
      })
    }
    for (const token of run.activeLeases.keys()) {
      this.revokeLeaseCommitted(run, token, cancellation.message, effects)
    }
    for (const attempt of run.activeAttempts.values()) {
      if (attempt.launched !== undefined) effects.push(() => { void attempt.launched?.dispose().catch(() => {}) })
    }
  }

  private cancelInvocationCommitted(
    run: RunState,
    invocationId: InvocationId,
    cancellation: RunCancellation,
    effects: (() => void)[],
  ): void {
    if (invocationId === run.rootInvocationId) {
      this.cancelRunCommitted(run, cancellation, effects)
      return
    }
    const invocation = run.invocations.get(invocationId)
    if (invocation === undefined || invocation.phase === 'settled' || invocation.cancellation !== undefined) return
    invocation.cancellation = cancellation
    if (!invocation.controller.signal.aborted) invocation.controller.abort(cancellation)
    for (const taskId of invocation.taskIds) {
      const task = run.tasks.get(taskId)
      if (task === undefined || (task.phase !== 'ready' && task.phase !== 'waiting')) continue
      this.removeFromQueue(run.ready, taskId)
      const failure = taskFailure(
        taskId,
        undefined,
        cancellation.kind === 'deadline_exceeded' ? 'timeout' : 'cancelled',
        'scheduler',
        cancellation.message,
        this.now,
      )
      this.terminalTask(run, task, { kind: 'aborted', failure }, effects, {
        evaluatePolicy: false,
        propagate: false,
      })
    }
    for (const attempt of run.activeAttempts.values()) {
      const task = run.tasks.get(attempt.taskId)
      if (task?.spec.invocationId === invocationId && attempt.launched !== undefined) {
        effects.push(() => { void attempt.launched?.dispose().catch(() => {}) })
      }
    }
    this.maybeCompleteInvocation(run, invocation, effects)
  }

  private revokeLeaseCommitted(
    run: RunState,
    token: LeaseToken,
    reason: string,
    effects: (() => void)[],
  ): void {
    const record = run.activeLeases.get(token)
    if (record === undefined) return
    run.activeLeases.delete(token)
    const task = run.tasks.get(record.taskId)
    if (task === undefined) return
    for (const invocationId of task.openChildInvocationIds) {
      this.cancelInvocationCommitted(run, invocationId, {
        kind: 'cancelled',
        message: `nested AgentSwarm lease was revoked: ${boundedText(reason, 300)}`,
      }, effects)
    }
  }

  private transition(
    run: RunState,
    task: TaskState,
    to: 'starting' | 'running' | 'waiting_children' | 'ready_to_resume',
  ): void {
    const from = task.viewStatus
    task.phase = to
    task.viewStatus = to
    run.recorder.append('tool-agent-swarm/task-transition', {
      swarmId: run.id,
      taskId: task.spec.id,
      from,
      to,
    })
  }

  private terminalTask(
    run: RunState,
    task: TaskState,
    terminal: TaskTerminal,
    effects: (() => void)[],
    options: { readonly evaluatePolicy?: boolean; readonly propagate?: boolean } = {},
  ): void {
    if (task.phase === 'terminal') return
    if (task.openChildInvocationIds.size !== 0) {
      throw new Error(`task ${task.spec.id} cannot become terminal with open nested invocations`)
    }
    const from = task.viewStatus
    task.phase = 'terminal'
    task.terminal = terminal
    delete task.currentAttemptId
    task.viewStatus = eventTerminalStatus(terminal)
    run.unfinishedTaskCount--
    const invocation = run.invocations.get(task.spec.invocationId)
    if (invocation === undefined || !invocation.remainingTaskIds.delete(task.spec.id)) {
      throw new Error(`task ${task.spec.id} is absent from its invocation barrier`)
    }
    run.recorder.append('tool-agent-swarm/task-transition', {
      swarmId: run.id,
      taskId: task.spec.id,
      from,
      to: task.viewStatus,
      ...terminal.kind === 'completed' ? {} : { reason: terminal.failure.kind },
    })
    if (options.evaluatePolicy !== false && this.maybeStopByPolicy(run, invocation, terminal, effects)) return
    if (options.propagate !== false && run.phase === 'running'
      && invocation.policyStop === undefined && invocation.cancellation === undefined) {
      this.releaseDependents(run, task, effects)
    }
    this.maybeCompleteInvocation(run, invocation, effects)
  }

  private maybeStopByPolicy(
    run: RunState,
    invocation: InvocationState,
    terminal: TaskTerminal,
    effects: (() => void)[],
  ): boolean {
    if (run.phase !== 'running' || invocation.policyStop !== undefined || invocation.cancellation !== undefined) return false
    if (invocation.failureMode === 'fail_fast' && terminal.kind === 'failed') {
      this.stopByPolicy(run, invocation, {
        reason: 'failed_fast',
        message: 'agent_swarm stopped this invocation after the first task failure',
      }, effects)
      return true
    }
    if (invocation.failureMode === 'quorum' && terminal.kind === 'completed') {
      const completed = invocation.taskIds
        .filter(taskId => run.tasks.get(taskId)?.terminal?.kind === 'completed').length
      if (completed >= (invocation.quorum ?? Number.MAX_SAFE_INTEGER)) {
        this.stopByPolicy(run, invocation, {
          reason: 'quorum_reached',
          message: `agent_swarm invocation reached quorum (${completed}/${invocation.quorum})`,
        }, effects)
        return true
      }
    }
    return false
  }

  private stopByPolicy(
    run: RunState,
    invocation: InvocationState,
    stop: InvocationPolicyStop,
    effects: (() => void)[],
  ): void {
    if (invocation.policyStop !== undefined) return
    invocation.policyStop = stop
    invocation.terminalReason = stop.reason
    if (!invocation.policyController.signal.aborted) invocation.policyController.abort(stop)
    for (const taskId of invocation.taskIds) {
      const task = run.tasks.get(taskId)
      if (task === undefined || (task.phase !== 'ready' && task.phase !== 'waiting')) continue
      this.removeFromQueue(run.ready, taskId)
      const failure = taskFailure(taskId, undefined, 'cancelled', 'scheduler', stop.message, this.now)
      this.terminalTask(run, task, { kind: 'aborted', failure }, effects, {
        evaluatePolicy: false,
        propagate: false,
      })
    }
  }

  private releaseDependents(run: RunState, settled: TaskState, effects: (() => void)[]): void {
    for (const dependentId of run.dependents.get(settled.spec.id) ?? []) {
      const dependent = run.tasks.get(dependentId)
      if (dependent === undefined || dependent.phase !== 'waiting') continue
      dependent.unmetDependencies--
      if (dependent.unmetDependencies < 0) {
        throw new Error(`task ${dependent.spec.id} dependency counter became negative`)
      }
      if (dependent.unmetDependencies === 0) this.resolveDependencies(run, dependent, effects)
    }
  }

  private resolveDependencies(run: RunState, task: TaskState, effects: (() => void)[]): void {
    const dependencies = task.spec.dependencies.map((dependencyId): ResolvedDependencyPrompt => {
      const dependency = run.tasks.get(dependencyId)
      if (dependency?.terminal === undefined) throw new Error(`task ${task.spec.id} resolved before dependency ${dependencyId}`)
      const terminal = dependency.terminal
      if (terminal.kind === 'completed') {
        return {
          key: dependency.spec.key,
          status: 'completed',
          reportedStatus: terminal.report.reported_status,
          summary: terminal.report.summary,
        }
      }
      return {
        key: dependency.spec.key,
        status: terminal.kind === 'skipped' ? 'skipped' : terminal.kind === 'aborted' ? 'aborted' : 'failed',
        failureKind: terminal.failure.kind,
      }
    })
    const missing = dependencies.filter(dependency => dependency.status !== 'completed')
    task.materializedDependencies = dependencies
    if (missing.length > 0 && task.spec.dependencyFailure !== 'partial') {
      const message = boundedText(
        `dependency inputs unavailable: ${missing.map(dependency => dependency.key).join(', ')}`,
        500,
      )
      const failure = taskFailure(task.spec.id, undefined, 'dependency_failed', 'waiting', message, this.now)
      this.terminalTask(run, task, task.spec.dependencyFailure === 'skip'
        ? { kind: 'skipped', failure }
        : { kind: 'failed', failure }, effects)
      return
    }
    const from = task.viewStatus
    task.phase = 'ready'
    task.viewStatus = 'ready'
    run.ready.push(task.spec.id)
    run.recorder.append('tool-agent-swarm/task-transition', {
      swarmId: run.id,
      taskId: task.spec.id,
      from,
      to: 'ready',
      ...missing.length === 0 ? {} : { reason: 'partial_dependencies' },
    })
  }

  private maybeCompleteInvocation(
    run: RunState,
    invocation: InvocationState,
    effects: (() => void)[],
  ): void {
    if (invocation.remainingTaskIds.size !== 0 || invocation.phase === 'settled'
      || invocation.id === run.rootInvocationId) return
    invocation.phase = 'awaiting_resume'
    const parentTask = invocation.parentTaskId === undefined ? undefined : run.tasks.get(invocation.parentTaskId)
    if (parentTask === undefined) throw new Error(`nested invocation ${invocation.id} lost its parent task`)
    parentTask.openChildInvocationIds.delete(invocation.id)
    if (parentTask.openChildInvocationIds.size !== 0) return
    const attempt = parentTask.currentAttemptId === undefined
      ? undefined
      : run.activeAttempts.get(parentTask.currentAttemptId)
    if (attempt === undefined || attempt.pendingOutcome !== undefined || attempt.deadline.signal.aborted
      || run.phase !== 'running') {
      this.settleInvocation(run, invocation)
      if (attempt?.pendingOutcome !== undefined) this.settleAttempt(run, attempt, attempt.pendingOutcome, effects)
      return
    }
    if (parentTask.phase !== 'waiting_children') {
      throw new Error(`nested invocation ${invocation.id} completed while parent task was ${parentTask.phase}`)
    }
    this.transition(run, parentTask, 'ready_to_resume')
    run.readyToResume.push(parentTask.spec.id)
  }

  private settleInvocation(run: RunState, invocation: InvocationState): void {
    if (invocation.phase === 'settled') return
    if (invocation.remainingTaskIds.size !== 0) {
      throw new Error(`invocation ${invocation.id} cannot settle with unfinished direct tasks`)
    }
    invocation.phase = 'settled'
    if (invocation.abortSignal !== undefined && invocation.onAbort !== undefined) {
      invocation.abortSignal.removeEventListener('abort', invocation.onAbort)
    }
    const status = invocationEventStatus(invocation, run.tasks)
    run.recorder.append('tool-agent-swarm/invocation-end', {
      swarmId: run.id,
      invocationId: invocation.id,
      status,
    })
    const value = this.toolValue(run, invocation)
    if (invocation.cancellation === undefined) invocation.completion.resolve(value)
    else invocation.completion.reject(new SwarmRunError(invocation.cancellation.kind, invocation.cancellation.message))
  }

  private auditIfStalled(run: RunState): void {
    if (run.phase !== 'running' || run.unfinishedTaskCount === 0 || run.ready.length > 0
      || run.readyToResume.length > 0 || run.activeAttempts.size > 0) return
    const stalledIds = dependencyDeadlockCandidates(
      [...run.tasks.values()].map(task => ({ id: task.spec.id, phase: task.phase })),
      run.ready.length,
      run.activeAttempts.size,
    )
    if (stalledIds.length === 0) throw new Error('scheduler stalled without ready, resumable, active, or waiting tasks')
    this.ctx.logger.warn(`agent_swarm dependency deadlock audit settled ${stalledIds.length} tasks in ${run.id}`)
    const effects: (() => void)[] = []
    for (const taskId of stalledIds) {
      const task = run.tasks.get(taskId)
      if (task === undefined || task.phase !== 'waiting') continue
      const failure = taskFailure(
        task.spec.id,
        undefined,
        'dependency_deadlock',
        'waiting',
        `dependency deadlock audit found ${task.unmetDependencies} unresolved dependencies`,
        this.now,
      )
      this.terminalTask(run, task, { kind: 'failed', failure }, effects, {
        evaluatePolicy: false,
        propagate: false,
      })
    }
    for (const effect of effects) effect()
  }

  private assertLedger(run: RunState): void {
    if (run.permitsInUse < 0 || run.permitsInUse > this.config.maxConcurrency) {
      throw new Error(`permitsInUse out of bounds: ${run.permitsInUse}`)
    }
    const heldPermits = [...run.activeAttempts.values()].filter(attempt => attempt.holdsPermit).length
    if (run.permitsInUse !== heldPermits) {
      throw new Error(`permit/attempt mismatch: ${run.permitsInUse} != ${heldPermits}`)
    }
    let unfinished = 0
    const queued = new Set(run.ready)
    const resumable = new Set(run.readyToResume)
    if (queued.size !== run.ready.length) throw new Error('ready queue contains duplicate tasks')
    if (resumable.size !== run.readyToResume.length) throw new Error('resume queue contains duplicate tasks')
    for (const task of run.tasks.values()) {
      if (task.phase !== 'terminal') unfinished++
      if (task.phase === 'terminal' && task.terminal === undefined) throw new Error(`terminal task ${task.spec.id} has no result`)
      if (task.phase !== 'terminal' && task.terminal !== undefined) throw new Error(`non-terminal task ${task.spec.id} has a result`)
      if (task.phase === 'terminal' && task.openChildInvocationIds.size !== 0) {
        throw new Error(`terminal task ${task.spec.id} retains nested invocations`)
      }
      if (task.phase === 'waiting' && task.unmetDependencies <= 0) {
        throw new Error(`waiting task ${task.spec.id} has no unmet dependencies`)
      }
      if (task.phase === 'ready' && (task.unmetDependencies !== 0 || !queued.has(task.spec.id))) {
        throw new Error(`ready task ${task.spec.id} is inconsistent with its queue state`)
      }
      if (task.phase !== 'ready' && queued.has(task.spec.id)) throw new Error(`ready queue references non-ready task ${task.spec.id}`)
      if (task.phase === 'ready_to_resume' && !resumable.has(task.spec.id)) {
        throw new Error(`resumable task ${task.spec.id} is absent from its queue`)
      }
      if (task.phase !== 'ready_to_resume' && resumable.has(task.spec.id)) {
        throw new Error(`resume queue references non-resumable task ${task.spec.id}`)
      }
      if (['starting', 'running', 'waiting_children', 'ready_to_resume'].includes(task.phase)
        && task.currentAttemptId === undefined) {
        throw new Error(`active task ${task.spec.id} has no current attempt`)
      }
      const attempt = task.currentAttemptId === undefined ? undefined : run.activeAttempts.get(task.currentAttemptId)
      if ((task.phase === 'starting' || task.phase === 'running') && attempt?.holdsPermit !== true) {
        throw new Error(`executing task ${task.spec.id} does not hold a permit`)
      }
      if ((task.phase === 'waiting_children' || task.phase === 'ready_to_resume') && attempt?.holdsPermit !== false) {
        throw new Error(`waiting parent task ${task.spec.id} still holds a permit`)
      }
    }
    for (const invocation of run.invocations.values()) {
      const expected = invocation.taskIds.filter(taskId => run.tasks.get(taskId)?.phase !== 'terminal')
      if (expected.length !== invocation.remainingTaskIds.size
        || expected.some(taskId => !invocation.remainingTaskIds.has(taskId))) {
        throw new Error(`invocation ${invocation.id} barrier is inconsistent`)
      }
      if (invocation.phase === 'settled' && invocation.remainingTaskIds.size !== 0) {
        throw new Error(`settled invocation ${invocation.id} retains tasks`)
      }
    }
    for (const lease of run.activeLeases.values()) {
      const attempt = run.activeAttempts.get(lease.attemptId)
      if (attempt === undefined || attempt.taskId !== lease.taskId) throw new Error('active lease failed attempt ownership')
    }
    if (unfinished !== run.unfinishedTaskCount) {
      throw new Error(`unfinished task mismatch: ${run.unfinishedTaskCount} != ${unfinished}`)
    }
    const terminalCount = [...run.tasks.values()].filter(task => task.terminal !== undefined).length
    if (run.tasks.size !== run.unfinishedTaskCount + terminalCount) throw new Error('task/result conservation failed')
  }

  private finishIfComplete(run: RunState): void {
    if (run.phase === 'finished' || run.unfinishedTaskCount !== 0 || run.activeAttempts.size !== 0
      || run.permitsInUse !== 0 || run.activeLeases.size !== 0) return
    const root = run.invocations.get(run.rootInvocationId)
    if (root === undefined || root.remainingTaskIds.size !== 0) return
    const openNested = [...run.invocations.values()]
      .filter(invocation => invocation.id !== run.rootInvocationId && invocation.phase !== 'settled')
    if (openNested.length > 0) return
    run.phase = 'finished'
    run.swarmDeadline.signal.removeEventListener('abort', run.onAbort)
    run.swarmDeadline[Symbol.dispose]()
    root.phase = 'settled'
    const value = this.toolValue(run, root)
    const eventSummary = this.eventSummary(run)
    const status = run.cancellation === undefined
      ? value.summary.failed === 0 && value.summary.skipped === 0 && value.summary.aborted === 0 ? 'completed' : 'partial'
      : run.cancellation.kind === 'deadline_exceeded' ? 'timed_out'
        : run.cancellation.kind === 'state_corrupted' ? 'failed' : 'cancelled'
    run.recorder.append('tool-agent-swarm/invocation-end', {
      swarmId: run.id,
      invocationId: root.id,
      status,
    })
    run.recorder.append('tool-agent-swarm/run-end', {
      swarmId: run.id,
      status,
      ...eventSummary,
    })
    if (run.cancellation === undefined) root.completion.resolve(value)
    else {
      root.completion.reject(new SwarmRunError(
        run.cancellation.kind,
        `${run.cancellation.message} (${eventSummary.completed} completed, ${eventSummary.cancelled + eventSummary.timedOut} cancelled)`,
      ))
    }
    this.releaseFinishedRun(run)
  }

  private toolValue(run: RunState, invocation: InvocationState): AgentSwarmToolValue {
    const tasks: InvocationTaskResult[] = invocation.taskIds.map((taskId) => {
      const task = run.tasks.get(taskId)
      if (task?.terminal === undefined) throw new Error(`cannot render unfinished task ${taskId}`)
      const base = {
        taskId,
        key: task.spec.key,
        attempts: task.attemptNo,
        ...task.currentChildId === undefined ? {} : { childId: task.currentChildId },
      }
      if (task.terminal.kind === 'completed') return { ...base, status: 'completed' as const, report: task.terminal.report }
      return {
        ...base,
        status: task.terminal.kind === 'aborted'
          ? 'aborted' as const
          : task.terminal.kind === 'skipped' ? 'skipped' as const : 'failed' as const,
        failure: { kind: task.terminal.failure.kind, message: task.terminal.failure.message },
      }
    })
    const direct = new Set(invocation.taskIds)
    const descendants = [...run.tasks.values()].filter((candidate) => {
      let parentId = candidate.spec.parentTaskId
      while (parentId !== undefined) {
        if (direct.has(parentId)) return true
        parentId = run.tasks.get(parentId)?.spec.parentTaskId
      }
      return false
    }).length
    return {
      swarmId: run.id,
      invocationId: invocation.id,
      kind: invocation.id === run.rootInvocationId ? 'root' : 'nested',
      terminalReason: invocation.terminalReason,
      tasks,
      summary: {
        completed: tasks.filter(task => task.status === 'completed').length,
        failed: tasks.filter(task => task.status === 'failed').length,
        skipped: tasks.filter(task => task.status === 'skipped').length,
        aborted: tasks.filter(task => task.status === 'aborted').length,
        descendants,
        reportedAchieved: tasks.filter(task => task.report?.reported_status === 'achieved').length,
        reportedNotAchieved: tasks.filter(task => task.report?.reported_status === 'not_achieved').length,
        reportedBlocked: tasks.filter(task => task.report?.reported_status === 'blocked').length,
      },
    }
  }

  private eventSummary(run: RunState): {
    completed: number
    failed: number
    skipped: number
    cancelled: number
    timedOut: number
  } {
    const terminals = [...run.tasks.values()].map(task => task.terminal)
    return {
      completed: terminals.filter(terminal => terminal?.kind === 'completed').length,
      failed: terminals.filter(terminal => terminal?.kind === 'failed' && terminal.failure.kind !== 'timeout').length,
      skipped: terminals.filter(terminal => terminal?.kind === 'skipped').length,
      cancelled: terminals.filter(terminal => terminal?.kind === 'aborted' && terminal.failure.kind !== 'timeout').length,
      timedOut: terminals.filter(terminal => terminal?.kind !== 'completed' && terminal?.failure.kind === 'timeout').length,
    }
  }

  private removeFromQueue(queue: SwarmTaskId[], taskId: SwarmTaskId): void {
    const index = queue.indexOf(taskId)
    if (index >= 0) queue.splice(index, 1)
  }
}

export async function settleInvocationHandle(handle: InvocationHandle): Promise<AgentSwarmToolValue> {
  const [execution, cleanup] = await Promise.allSettled([
    handle.result,
    handle.result.then(() => handle.dispose(), () => handle.dispose()),
  ])
  if (execution.status === 'rejected') {
    if (cleanup.status === 'rejected') {
      throw new AggregateError([execution.reason, cleanup.reason], 'agent_swarm invocation and handle cleanup failed')
    }
    throw execution.reason
  }
  if (cleanup.status === 'rejected') throw cleanup.reason
  return execution.value
}
