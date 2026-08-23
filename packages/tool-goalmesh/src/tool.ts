import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { GoalMeshRootArgsV02, GoalMeshToolValue, ResolvedConfig } from './types.js'
import { SwarmCoordinator, settleInvocationHandle } from './coordinator.js'
import { GOAL_MESH_OUTPUT_SCHEMA, ROOT_GOAL_MESH_PARAMETERS } from './schema.js'
import { assertRootArgsV02, boundedText } from './validation.js'

const ROOT_GOAL_MESH_DESCRIPTION =
  'Execute a bounded task DAG with child-agent concurrency. '
  + 'Each child receives the global goal plus one local objective and must return a structured TaskReport. '
  + 'Dependencies support fail, skip, or partial propagation; invocation policy supports collect-all, fail-fast, or quorum. '
  + 'The call preserves input order and returns settled partial results. Local children may attach nested calls when enabled.'

type ToolOutputValue = InferValue<typeof GOAL_MESH_OUTPUT_SCHEMA>

export function renderBounded(value: GoalMeshToolValue, maxChars: number): string {
  const serialized = JSON.stringify(value)
  if (serialized.length <= maxChars) return serialized
  const compact = {
    swarmId: value.swarmId,
    invocationId: value.invocationId,
    kind: value.kind,
    terminalReason: value.terminalReason,
    summary: value.summary,
    tasks: value.tasks.map(task => ({
      taskId: task.taskId,
      key: task.key,
      status: task.status,
      attempts: task.attempts,
      ...task.childId === undefined ? {} : { childId: task.childId },
      ...task.report === undefined ? {} : {
        report: {
          reported_status: task.report.reported_status,
          summary: boundedText(task.report.summary, 500),
        },
      },
      ...task.failure === undefined ? {} : { failure: task.failure },
    })),
    truncated: true,
  }
  return boundedText(JSON.stringify(compact), maxChars)
}

function callView(args: GoalMeshRootArgsV02): ToolCallView {
  return {
    card: 'generic',
    kind: 'execute',
    title: `goal_mesh: ${args.tasks.length} tasks`,
    rawInput: args.goal.statement,
  }
}

function resultView(
  args: GoalMeshRootArgsV02,
  result: { readonly isError: boolean; readonly meta?: unknown },
): ToolResultView {
  if (result.isError) return { card: 'generic', title: `goal_mesh: ${args.tasks.length} tasks failed` }
  const meta = result.meta
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const settled = (meta as { settled?: unknown }).settled
    const total = (meta as { total?: unknown }).total
    if (typeof settled === 'number' && typeof total === 'number') {
      return { card: 'generic', title: `goal_mesh: ${settled}/${total} settled` }
    }
  }
  return { card: 'generic', title: `goal_mesh: ${args.tasks.length}/${args.tasks.length} settled` }
}

export function registerRootGoalMeshTool(
  ctx: Context,
  coordinator: SwarmCoordinator,
  config: ResolvedConfig,
): () => void {
  return ctx.tools.register(defineTool({
    name: config.toolName,
    description: ROOT_GOAL_MESH_DESCRIPTION,
    parameters: ROOT_GOAL_MESH_PARAMETERS,
    output: {
      schema: GOAL_MESH_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderBounded(value as unknown as GoalMeshToolValue, config.maxRenderedResultChars),
      }],
      presentationMeta: (_args, value) => {
        const swarm = value as unknown as GoalMeshToolValue
        return {
          total: swarm.tasks.length,
          settled: swarm.tasks.length,
          completed: swarm.summary.completed,
          failed: swarm.summary.failed,
          skipped: swarm.summary.skipped,
          aborted: swarm.summary.aborted,
          terminalReason: swarm.terminalReason,
        }
      },
    },
    async execute(args, exec) {
      assertRootArgsV02(args as unknown as GoalMeshRootArgsV02, config.maxTasks, config.defaultFailureMode)
      const caller = exec.agent
      if (caller === undefined) throw new Error('goal_mesh requires a calling agent')
      const value = await settleInvocationHandle(coordinator.invokeRoot({
        rootAgent: caller,
        callId: exec.callId,
        commandToken: exec.token,
        args: args as unknown as GoalMeshRootArgsV02,
        signal: exec.signal,
      }))
      return value as unknown as ToolOutputValue
    },
    presentCall: args => callView(args as unknown as GoalMeshRootArgsV02),
    presentResult: (args, result) => resultView(args as unknown as GoalMeshRootArgsV02, result),
  }))
}
