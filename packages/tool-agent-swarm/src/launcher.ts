import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { TASK_REPORT_JSON_SCHEMA } from './schema.js'
import { installChildAgentSwarmTool } from './nested-tool.js'
import type { ScopedSwarmLease } from './nested-tool.js'
import type {
  AttemptId,
  ResolvedConfig,
  SwarmTaskId,
  TaskFailure,
  TaskReport,
} from './types.js'
import { sanitizeDiagnostic, validateTaskReport } from './validation.js'

export const ATTEMPT_TIMEOUT_CODE = 'AGENT_SWARM_ATTEMPT_TIMEOUT'

export interface MaterializedTask {
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly description: string
  readonly prompt: string
  readonly parentAgent: Agent
  readonly absoluteMaxDepth: number
  readonly signal: AbortSignal
  readonly lease?: ScopedSwarmLease
}

export type TaskCompletionOutcome =
  | { readonly ok: true; readonly report: TaskReport }
  | { readonly ok: false; readonly failure: TaskFailure }

export interface LaunchedTask {
  readonly childId: SessionId
  readonly local: boolean
  readonly requestedModel?: string
  readonly settled: Promise<TaskCompletionOutcome>
  dispose(): Promise<void>
}

export interface Launcher {
  start(task: MaterializedTask): Promise<LaunchedTask>
}

function failure(
  task: MaterializedTask,
  kind: TaskFailure['kind'],
  phase: TaskFailure['phase'],
  message: string,
  childId?: SessionId,
): TaskCompletionOutcome {
  return {
    ok: false,
    failure: {
      kind,
      phase,
      scope: 'attempt',
      message,
      taskId: task.taskId,
      attemptId: task.attemptId,
      ...childId === undefined ? {} : { childId },
      occurredAt: Date.now(),
    },
  }
}

function mapResult(
  task: MaterializedTask,
  result: SubagentResult,
  childId: SessionId,
  maxTaskReportChars: number,
): TaskCompletionOutcome {
  switch (result.stopReason) {
    case 'completed': {
      if (result.structured === undefined) {
        return failure(task, 'structured_result_missing', 'running', 'child completed without a structured TaskReport', childId)
      }
      const checked = validateTaskReport(result.structured, maxTaskReportChars)
      return checked.ok
        ? { ok: true, report: checked.report }
        : failure(task, checked.kind, 'running', checked.message, childId)
    }
    case 'aborted':
      return failure(task, 'cancelled', 'running', 'child run was cancelled', childId)
    case 'error':
      return failure(task, 'child_error', 'running', 'child run failed', childId)
    case 'max-tokens':
      return failure(task, 'max_tokens', 'running', 'child hit its token limit before submitting a TaskReport', childId)
    case 'refusal':
      return failure(task, 'refusal', 'running', 'child refused the task', childId)
    default:
      return failure(task, 'unknown', 'running', `child ended abnormally (${String(result.stopReason)})`, childId)
  }
}

function cancellationOutcome(task: MaterializedTask, childId: SessionId): TaskCompletionOutcome | undefined {
  if (!task.signal.aborted) return undefined
  return timeoutOf(task.signal, ATTEMPT_TIMEOUT_CODE) !== undefined
    ? failure(task, 'timeout', 'running', 'child attempt exceeded its deadline', childId)
    : failure(task, 'cancelled', 'running', 'child attempt was cancelled', childId)
}

function withCleanup(
  task: MaterializedTask,
  childId: SessionId,
  outcome: TaskCompletionOutcome,
  cleanupError: unknown,
): TaskCompletionOutcome {
  const diagnostic = sanitizeDiagnostic(cleanupError)
  if (outcome.ok) return failure(task, 'cleanup_failed', 'finalizing', `child cleanup failed: ${diagnostic}`, childId)
  return {
    ok: false,
    failure: {
      ...outcome.failure,
      cleanupDiagnostic: diagnostic,
    },
  }
}

export class SubagentLauncher implements Launcher {
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(task: MaterializedTask): Promise<LaunchedTask> {
    const lease = task.lease
    const run: SubagentRun = await this.ctx.subagents.start(this.config.provider, {
      label: task.description,
      prompt: [{ type: 'text', text: task.prompt }],
      parent: task.parentAgent,
      signal: task.signal,
      outputSchema: TASK_REPORT_JSON_SCHEMA,
      maxDepth: task.absoluteMaxDepth,
      ...this.config.childAgentOptions === undefined ? {} : { agentOptions: this.config.childAgentOptions },
      ...this.config.childToolFilter === undefined ? {} : { toolFilter: this.config.childToolFilter },
      ...lease === undefined ? {} : {
        scopedSetup: (childCtx: Context) => { installChildAgentSwarmTool(childCtx, lease, this.config) },
      },
    })

    if (lease !== undefined && run.localAgent === undefined) {
      lease.revoke('provider returned a non-local child for local-only nested mode')
      await run.dispose()
      throw new Error(`subagent provider "${this.config.provider}" did not publish a local child for nestedMode "local-only"`)
    }

    let disposal: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposal ??= Promise.resolve().then(() => run.dispose())
      return disposal
    }
    const onAbort = (): void => {
      void dispose().catch(() => {})
    }
    task.signal.addEventListener('abort', onAbort, { once: true })
    if (task.signal.aborted) onAbort()

    const settled = (async (): Promise<TaskCompletionOutcome> => {
      let outcome: TaskCompletionOutcome
      try {
        outcome = mapResult(task, await run.result, run.id, this.config.maxTaskReportChars)
      } catch (error: unknown) {
        outcome = failure(task, 'child_error', 'running', `child result failed: ${sanitizeDiagnostic(error)}`, run.id)
      }
      const cleanup = await Promise.allSettled([dispose()])
      task.signal.removeEventListener('abort', onAbort)
      const cancelled = cancellationOutcome(task, run.id)
      if (cancelled !== undefined) return cancelled
      const cleanupResult = cleanup[0]
      return cleanupResult?.status === 'rejected'
        ? withCleanup(task, run.id, outcome, cleanupResult.reason)
        : outcome
    })()

    return {
      childId: run.id,
      local: run.localAgent !== undefined,
      ...this.config.childAgentOptions?.model === undefined
        ? {}
        : { requestedModel: this.config.childAgentOptions.model },
      settled,
      dispose,
    }
  }
}
