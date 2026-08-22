import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Deadline } from '@deepseek-ai/dsh-timeout'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { SwarmRunError } from './errors.js'
import type { SwarmRunFailureKind } from './errors.js'
import { dependencyDeadlockCandidates } from './dag.js'
import { ATTEMPT_TIMEOUT_CODE, SubagentLauncher } from './launcher.js'
import type { LaunchedTask, Launcher, MaterializedTask, TaskCompletionOutcome } from './launcher.js'
import { buildChildPrompt } from './prompt.js'
import type { ResolvedDependencyPrompt } from './prompt.js'
import type {
  AgentSwarmToolValue,
  AttemptId,
  DependencyFailurePolicy,
  InvocationHandle,
  InvocationFailureMode,
  InvocationId,
  InvocationTaskResult,
  ResolvedConfig,
  RootInvocationInput,
  SwarmGoal,
  SwarmId,
  SwarmTaskId,
  SwarmTaskViewStatus,
  TaskFailure,
  TaskGoal,
  TaskReport,
  TrajectoryRecorderFactory,
  TrajectorySink,
} from './types.js'
import { assertRootArgsV02, boundedText, sanitizeDiagnostic } from './validation.js'

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
  readonly description: string
  readonly depth: 1
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
  phase: 'waiting' | 'ready' | 'starting' | 'running' | 'terminal'
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
  launched?: LaunchedTask
}

interface RunCancellation {
  readonly kind: SwarmRunFailureKind
  readonly message: string
}

interface InvocationPolicyStop {
  readonly reason: 'failed_fast' | 'quorum_reached'
  readonly message: string
}

type Command =
  | { readonly kind: 'schedule' }
  | { readonly kind: 'published'; readonly attemptId: AttemptId; readonly launched: LaunchedTask }
  | { readonly kind: 'launch-rejected'; readonly attemptId: AttemptId; readonly error: unknown }
  | { readonly kind: 'attempt-settled'; readonly attemptId: AttemptId; readonly outcome: TaskCompletionOutcome }
  | { readonly kind: 'cancel'; readonly cancellation: RunCancellation }

interface RunState {
  readonly id: SwarmId
  readonly invocationId: InvocationId
  readonly commandToken: ToolExecutionToken
  readonly rootAgent: Agent
  readonly goal: SwarmGoal
  readonly absoluteMaxDepth: number
  readonly taskIds: readonly SwarmTaskId[]
  readonly tasks: Map<SwarmTaskId, TaskState>
  readonly dependents: ReadonlyMap<SwarmTaskId, readonly SwarmTaskId[]>
  readonly ready: SwarmTaskId[]
  readonly activeAttempts: Map<AttemptId, ActiveAttempt>
  readonly completion: Deferred<AgentSwarmToolValue>
  readonly recorder: TrajectorySink
  readonly controller: AbortController
  readonly policyController: AbortController
  readonly swarmDeadline: Deadline
  readonly onAbort: () => void
  readonly commands: Command[]
  phase: 'running' | 'cancelling' | 'finished'
  readonly failureMode: InvocationFailureMode
  readonly quorum?: number
  terminalReason: AgentSwarmToolValue['terminalReason']
  policyStop?: InvocationPolicyStop
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

export class SwarmCoordinator {
  private readonly launcher: Launcher
  private readonly id: () => string
  private readonly now: () => number
  private readonly runs = new Map<SwarmId, RunState>()
  private readonly rootInvocationsByCommand = new Map<ToolExecutionToken, SwarmId>()
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
    const existingId = this.rootInvocationsByCommand.get(input.commandToken)
    if (existingId !== undefined) {
      const existing = this.runs.get(existingId)
      if (existing === undefined) throw new Error('agent_swarm command index references a released run')
      existing.handleCount++
      return this.createHandle(existing)
    }
    const provider = this.ctx.subagents.getProvider(this.config.provider)
    if (provider === undefined) throw new Error(`subagent provider "${this.config.provider}" is not registered`)
    if (!provider.capabilities.outputSchema || !provider.capabilities.depthLimit) {
      throw new Error(
        `subagent provider "${provider.name}" must support outputSchema and depthLimit for agent_swarm v0.2`,
      )
    }
    const rootDepth = delegationDepthOf(input.rootAgent)
    if (rootDepth !== 0) {
      throw new Error('agent_swarm v0.2 accepts only top-level callers; nested swarm is disabled')
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
    const taskIds = input.args.tasks.map(() => this.nextId<SwarmTaskId>('task'))
    const taskIdsByKey = new Map(input.args.tasks.map((source, index) => [source.key, taskIds[index] as SwarmTaskId]))
    const tasks = new Map<SwarmTaskId, TaskState>()
    input.args.tasks.forEach((source, index): void => {
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
        invocationId,
        description: source.description,
        depth: 1,
        dependencies,
        dependencyFailure: admitted.dependencyFailureByKey.get(source.key) ?? 'fail',
        taskGoal: {
          objective: source.objective,
          acceptanceCriteria: [...source.acceptance_criteria],
          expectedOutputs: [...(source.expected_outputs ?? [])],
        },
      }
      tasks.set(taskId, {
        spec,
        phase: dependencies.length === 0 ? 'ready' : 'waiting',
        viewStatus: dependencies.length === 0 ? 'ready' : 'waiting',
        unmetDependencies: dependencies.length,
        attemptNo: 0,
        ...dependencies.length === 0 ? { materializedDependencies: [] } : {},
      })
    })
    const mutableDependents = new Map<SwarmTaskId, SwarmTaskId[]>(taskIds.map(taskId => [taskId, []]))
    for (const task of tasks.values()) {
      for (const dependency of task.spec.dependencies) mutableDependents.get(dependency)?.push(task.spec.id)
    }
    const dependents = new Map([...mutableDependents].map(([taskId, values]) => [taskId, values as readonly SwarmTaskId[]]))

    const controller = new AbortController()
    const policyController = new AbortController()
    const upstream = AbortSignal.any([input.signal, controller.signal])
    const swarmDeadline = deadline(upstream, this.config.swarmTimeoutMs, SWARM_TIMEOUT_CODE)
    const completion = deferred<AgentSwarmToolValue>()
    // A rejection belongs to the returned Tool promise; prevent a synchronous
    // pre-consumer cancellation from becoming an unhandled rejection.
    void completion.promise.catch(() => {})
    const recorder = this.recorderFactory.create(input.rootAgent.session, swarmId)
    const run = {} as RunState
    const onAbort = (): void => {
      const cancellation: RunCancellation = timeoutOf(swarmDeadline.signal, SWARM_TIMEOUT_CODE) !== undefined
        ? { kind: 'deadline_exceeded', message: 'agent_swarm exceeded its swarm deadline' }
        : controller.signal.aborted && controller.signal.reason instanceof SwarmRunError
          ? {
              kind: controller.signal.reason.kind,
              message: controller.signal.reason.message,
            }
          : { kind: 'cancelled', message: 'agent_swarm was cancelled by its caller' }
      this.enqueue(run, { kind: 'cancel', cancellation })
    }
    Object.assign(run, {
      id: swarmId,
      invocationId,
      commandToken: input.commandToken,
      rootAgent: input.rootAgent,
      goal,
      absoluteMaxDepth,
      taskIds,
      tasks,
      dependents,
      ready: taskIds.filter(taskId => tasks.get(taskId)?.phase === 'ready'),
      activeAttempts: new Map<AttemptId, ActiveAttempt>(),
      completion,
      recorder,
      controller,
      policyController,
      swarmDeadline,
      onAbort,
      commands: [],
      phase: 'running',
      failureMode: admitted.failureMode,
      ...admitted.quorum === undefined ? {} : { quorum: admitted.quorum },
      terminalReason: 'all_tasks_settled',
      unfinishedTaskCount: taskIds.length,
      permitsInUse: 0,
      draining: false,
      handleCount: 1,
    } satisfies RunState)

    this.runs.set(swarmId, run)
    this.rootInvocationsByCommand.set(input.commandToken, swarmId)
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
    for (const taskId of taskIds) {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error('agent_swarm failed to register an admitted task')
      recorder.append('tool-agent-swarm/task-created', {
        swarmId,
        invocationId,
        taskId,
        key: boundedText(task.spec.key, 120),
        label: boundedText(task.spec.description, 200),
        objectiveSummary: boundedText(task.spec.taskGoal.objective, 500),
        acceptanceCriteriaSummary: task.spec.taskGoal.acceptanceCriteria.slice(0, 12)
          .map(value => boundedText(value, 240)),
        dependencies: task.spec.dependencies,
        depth: 1,
      })
    }
    swarmDeadline.signal.addEventListener('abort', onAbort, { once: true })
    if (swarmDeadline.signal.aborted) onAbort()
    else this.enqueue(run, { kind: 'schedule' })
    return this.createHandle(run)
  }

  dispose(): Promise<void> {
    this.accepting = false
    this.disposal ??= (async () => {
      const pending: Promise<unknown>[] = []
      for (const run of this.runs.values()) {
        if (run.phase !== 'finished') {
          this.enqueue(run, {
            kind: 'cancel',
            cancellation: { kind: 'plugin_disposed', message: 'agent_swarm plugin was disposed' },
          })
          pending.push(run.completion.promise.catch(() => undefined))
        }
      }
      await Promise.all(pending)
      this.rootInvocationsByCommand.clear()
      this.runs.clear()
    })()
    return this.disposal
  }

  private nextId<T extends string>(kind: string): T {
    return `${kind}-${this.id()}` as T
  }

  private createHandle(run: RunState): InvocationHandle {
    let disposed = false
    return {
      swarmId: run.id,
      invocationId: run.invocationId,
      result: run.completion.promise,
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
      this.cancelCommitted(run, {
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
        this.onLaunchRejected(run, command.attemptId, command.error)
        this.schedule(run, effects)
        return
      case 'attempt-settled':
        this.onAttemptSettled(run, command.attemptId, command.outcome)
        this.schedule(run, effects)
        return
      case 'cancel':
        this.cancelCommitted(run, command.cancellation, effects)
        return
    }
  }

  private schedule(run: RunState, effects: (() => void)[]): void {
    if (run.phase !== 'running' || run.policyStop !== undefined) return
    while (run.permitsInUse < this.config.maxConcurrency && run.ready.length > 0) {
      const taskId = run.ready.shift()
      if (taskId === undefined) break
      const task = run.tasks.get(taskId)
      if (task === undefined || task.phase !== 'ready') throw new Error(`ready queue references invalid task ${taskId}`)
      task.attemptNo++
      const attemptId = this.nextId<AttemptId>('attempt')
      task.currentAttemptId = attemptId
      this.transition(run, task, 'starting')
      const attemptDeadline = deadline(
        AbortSignal.any([run.swarmDeadline.signal, run.policyController.signal]),
        this.config.attemptTimeoutMs,
        ATTEMPT_TIMEOUT_CODE,
      )
      run.activeAttempts.set(attemptId, {
        id: attemptId,
        taskId,
        deadline: attemptDeadline,
      })
      run.permitsInUse++
      effects.push(() => { this.launch(run, task, attemptId, attemptDeadline.signal) })
    }
    this.auditIfStalled(run)
  }

  private launch(run: RunState, task: TaskState, attemptId: AttemptId, signal: AbortSignal): void {
    const materialized: MaterializedTask = {
      taskId: task.spec.id,
      attemptId,
      description: task.spec.description,
      prompt: buildChildPrompt(
        run.goal,
        task.spec.taskGoal,
        this.config.toolName,
        task.materializedDependencies ?? [],
      ),
      parentAgent: run.rootAgent,
      absoluteMaxDepth: run.absoluteMaxDepth,
      signal,
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
    run.recorder.append('tool-agent-swarm/attempt-start', {
      swarmId: run.id,
      taskId: task.spec.id,
      attemptId,
      attemptNo: task.attemptNo,
      childId: launched.childId,
      parentSessionId: run.rootAgent.session.id,
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
    if (attempt.deadline.signal.aborted) {
      effects.push(() => { void launched.dispose().catch(() => {}) })
    }
  }

  private onLaunchRejected(run: RunState, attemptId: AttemptId, error: unknown): void {
    const attempt = run.activeAttempts.get(attemptId)
    if (attempt === undefined) return
    const task = run.tasks.get(attempt.taskId)
    if (task === undefined || task.currentAttemptId !== attemptId || task.phase !== 'starting') return
    const signal = attempt.deadline.signal
    const failure = run.cancellation?.kind === 'deadline_exceeded'
      ? taskFailure(task.spec.id, attemptId, 'timeout', 'launch', 'swarm deadline elapsed before child publication', this.now)
      : timeoutOf(signal, ATTEMPT_TIMEOUT_CODE) !== undefined
      ? taskFailure(task.spec.id, attemptId, 'timeout', 'launch', 'child attempt timed out before publication', this.now)
      : run.policyStop !== undefined
        ? taskFailure(task.spec.id, attemptId, 'cancelled', 'launch', run.policyStop.message, this.now)
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
    run.permitsInUse--
    this.terminalTask(run, task, failure.kind === 'cancelled'
      ? { kind: 'aborted', failure }
      : { kind: 'failed', failure })
  }

  private onAttemptSettled(run: RunState, attemptId: AttemptId, outcome: TaskCompletionOutcome): void {
    const attempt = run.activeAttempts.get(attemptId)
    if (attempt === undefined) return
    const task = run.tasks.get(attempt.taskId)
    if (task === undefined || task.currentAttemptId !== attemptId || task.phase !== 'running') return
    attempt.deadline[Symbol.dispose]()
    run.activeAttempts.delete(attemptId)
    run.permitsInUse--
    const normalized = !outcome.ok && outcome.failure.kind === 'cancelled'
      && run.cancellation?.kind === 'deadline_exceeded'
      ? {
          ok: false as const,
          failure: {
            ...outcome.failure,
            kind: 'timeout' as const,
            message: 'swarm deadline elapsed before child quiescence',
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
      attemptId,
      outcome: attemptOutcome(terminal),
      ...terminal.kind === 'completed' ? {} : { failureKind: terminal.failure.kind },
    })
    this.terminalTask(run, task, terminal)
  }

  private cancelCommitted(run: RunState, cancellation: RunCancellation, effects: (() => void)[]): void {
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
      this.terminalTask(run, task, { kind: 'aborted', failure }, { evaluatePolicy: false, propagate: false })
    }
    for (const attempt of run.activeAttempts.values()) {
      if (attempt.launched !== undefined) {
        effects.push(() => { void attempt.launched?.dispose().catch(() => {}) })
      }
    }
  }

  private transition(run: RunState, task: TaskState, to: 'starting' | 'running'): void {
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
    options: { readonly evaluatePolicy?: boolean; readonly propagate?: boolean } = {},
  ): void {
    if (task.phase === 'terminal') return
    const from = task.viewStatus
    task.phase = 'terminal'
    task.terminal = terminal
    delete task.currentAttemptId
    task.viewStatus = eventTerminalStatus(terminal)
    run.unfinishedTaskCount--
    run.recorder.append('tool-agent-swarm/task-transition', {
      swarmId: run.id,
      taskId: task.spec.id,
      from,
      to: task.viewStatus,
      ...terminal.kind === 'completed' ? {} : { reason: terminal.failure.kind },
    })
    if (options.evaluatePolicy !== false && this.maybeStopByPolicy(run, terminal)) return
    if (options.propagate !== false && run.phase === 'running' && run.policyStop === undefined) {
      this.releaseDependents(run, task)
    }
  }

  private maybeStopByPolicy(run: RunState, terminal: TaskTerminal): boolean {
    if (run.phase !== 'running' || run.policyStop !== undefined || run.cancellation !== undefined) return false
    if (run.failureMode === 'fail_fast' && terminal.kind === 'failed') {
      this.stopByPolicy(run, {
        reason: 'failed_fast',
        message: 'agent_swarm stopped this invocation after the first task failure',
      })
      return true
    }
    if (run.failureMode === 'quorum' && terminal.kind === 'completed') {
      const completed = [...run.tasks.values()].filter(task => task.terminal?.kind === 'completed').length
      if (completed >= (run.quorum ?? Number.MAX_SAFE_INTEGER)) {
        this.stopByPolicy(run, {
          reason: 'quorum_reached',
          message: `agent_swarm invocation reached quorum (${completed}/${run.quorum})`,
        })
        return true
      }
    }
    return false
  }

  private stopByPolicy(run: RunState, stop: InvocationPolicyStop): void {
    if (run.policyStop !== undefined) return
    run.policyStop = stop
    run.terminalReason = stop.reason
    run.ready.splice(0)
    if (!run.policyController.signal.aborted) run.policyController.abort(stop)
    for (const task of run.tasks.values()) {
      if (task.phase !== 'ready' && task.phase !== 'waiting') continue
      const failure = taskFailure(
        task.spec.id,
        undefined,
        'cancelled',
        'scheduler',
        stop.message,
        this.now,
      )
      this.terminalTask(run, task, { kind: 'aborted', failure }, { evaluatePolicy: false, propagate: false })
    }
  }

  private releaseDependents(run: RunState, settled: TaskState): void {
    for (const dependentId of run.dependents.get(settled.spec.id) ?? []) {
      const dependent = run.tasks.get(dependentId)
      if (dependent === undefined || dependent.phase !== 'waiting') continue
      dependent.unmetDependencies--
      if (dependent.unmetDependencies < 0) {
        throw new Error(`task ${dependent.spec.id} dependency counter became negative`)
      }
      if (dependent.unmetDependencies === 0) this.resolveDependencies(run, dependent)
    }
  }

  private resolveDependencies(run: RunState, task: TaskState): void {
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
        : { kind: 'failed', failure })
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

  private auditIfStalled(run: RunState): void {
    if (run.phase !== 'running' || run.policyStop !== undefined || run.unfinishedTaskCount === 0
      || run.ready.length > 0 || run.activeAttempts.size > 0) return
    const stalledIds = dependencyDeadlockCandidates(
      [...run.tasks.values()].map(task => ({ id: task.spec.id, phase: task.phase })),
      run.ready.length,
      run.activeAttempts.size,
    )
    if (stalledIds.length === 0) throw new Error('scheduler stalled without ready, active, or waiting tasks')
    this.ctx.logger.warn(`agent_swarm dependency deadlock audit settled ${stalledIds.length} tasks in ${run.id}`)
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
      this.terminalTask(run, task, { kind: 'failed', failure }, { evaluatePolicy: false, propagate: false })
    }
  }

  private assertLedger(run: RunState): void {
    if (run.permitsInUse < 0 || run.permitsInUse > this.config.maxConcurrency) {
      throw new Error(`permitsInUse out of bounds: ${run.permitsInUse}`)
    }
    if (run.permitsInUse !== run.activeAttempts.size) {
      throw new Error(`permit/attempt mismatch: ${run.permitsInUse} != ${run.activeAttempts.size}`)
    }
    let unfinished = 0
    const queued = new Set(run.ready)
    if (queued.size !== run.ready.length) throw new Error('ready queue contains duplicate tasks')
    for (const task of run.tasks.values()) {
      if (task.phase !== 'terminal') unfinished++
      if (task.phase === 'terminal' && task.terminal === undefined) throw new Error(`terminal task ${task.spec.id} has no result`)
      if (task.phase !== 'terminal' && task.terminal !== undefined) throw new Error(`non-terminal task ${task.spec.id} has a result`)
      if (task.phase === 'waiting' && task.unmetDependencies <= 0) {
        throw new Error(`waiting task ${task.spec.id} has no unmet dependencies`)
      }
      if (task.phase === 'ready' && (task.unmetDependencies !== 0 || !queued.has(task.spec.id))) {
        throw new Error(`ready task ${task.spec.id} is inconsistent with its dependency or queue state`)
      }
      if (task.phase !== 'ready' && queued.has(task.spec.id)) {
        throw new Error(`ready queue references non-ready task ${task.spec.id}`)
      }
      if ((task.phase === 'starting' || task.phase === 'running') && task.currentAttemptId === undefined) {
        throw new Error(`active task ${task.spec.id} has no current attempt`)
      }
    }
    if (unfinished !== run.unfinishedTaskCount) {
      throw new Error(`unfinished task mismatch: ${run.unfinishedTaskCount} != ${unfinished}`)
    }
    if (run.tasks.size !== run.unfinishedTaskCount + [...run.tasks.values()].filter(task => task.terminal !== undefined).length) {
      throw new Error('task/result conservation failed')
    }
  }

  private finishIfComplete(run: RunState): void {
    if (run.phase === 'finished' || run.unfinishedTaskCount !== 0
      || run.activeAttempts.size !== 0 || run.permitsInUse !== 0) return
    run.phase = 'finished'
    run.swarmDeadline.signal.removeEventListener('abort', run.onAbort)
    run.swarmDeadline[Symbol.dispose]()
    const value = this.toolValue(run)
    const eventSummary = this.eventSummary(run)
    const status = run.cancellation === undefined
      ? value.summary.failed === 0 && value.summary.skipped === 0 && value.summary.aborted === 0 ? 'completed' : 'partial'
      : run.cancellation.kind === 'deadline_exceeded' ? 'timed_out'
        : run.cancellation.kind === 'state_corrupted' ? 'failed' : 'cancelled'
    run.recorder.append('tool-agent-swarm/invocation-end', {
      swarmId: run.id,
      invocationId: run.invocationId,
      status,
    })
    run.recorder.append('tool-agent-swarm/run-end', {
      swarmId: run.id,
      status,
      ...eventSummary,
    })
    if (run.cancellation === undefined) {
      run.completion.resolve(value)
    } else {
      run.completion.reject(new SwarmRunError(
        run.cancellation.kind,
        `${run.cancellation.message} (${eventSummary.completed} completed, ${eventSummary.cancelled + eventSummary.timedOut} cancelled)`,
      ))
    }
    this.releaseFinishedRun(run)
  }

  private toolValue(run: RunState): AgentSwarmToolValue {
    const tasks: InvocationTaskResult[] = run.taskIds.map((taskId) => {
      const task = run.tasks.get(taskId)
      if (task?.terminal === undefined) throw new Error(`cannot render unfinished task ${taskId}`)
      const base = {
        taskId,
        key: task.spec.key,
        attempts: task.attemptNo,
        ...task.currentChildId === undefined ? {} : { childId: task.currentChildId },
      }
      if (task.terminal.kind === 'completed') {
        return { ...base, status: 'completed' as const, report: task.terminal.report }
      }
      return {
        ...base,
        status: task.terminal.kind === 'aborted'
          ? 'aborted' as const
          : task.terminal.kind === 'skipped' ? 'skipped' as const : 'failed' as const,
        failure: {
          kind: task.terminal.failure.kind,
          message: task.terminal.failure.message,
        },
      }
    })
    const summary = {
      completed: tasks.filter(task => task.status === 'completed').length,
      failed: tasks.filter(task => task.status === 'failed').length,
      skipped: tasks.filter(task => task.status === 'skipped').length,
      aborted: tasks.filter(task => task.status === 'aborted').length,
      descendants: 0 as const,
      reportedAchieved: tasks.filter(task => task.report?.reported_status === 'achieved').length,
      reportedNotAchieved: tasks.filter(task => task.report?.reported_status === 'not_achieved').length,
      reportedBlocked: tasks.filter(task => task.report?.reported_status === 'blocked').length,
    }
    return {
      swarmId: run.id,
      invocationId: run.invocationId,
      kind: 'root',
      terminalReason: run.terminalReason,
      tasks,
      summary,
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
}

export async function settleInvocationHandle(handle: InvocationHandle): Promise<AgentSwarmToolValue> {
  const [execution, cleanup] = await Promise.allSettled([
    handle.result,
    handle.result.then(
      () => handle.dispose(),
      () => handle.dispose(),
    ),
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
