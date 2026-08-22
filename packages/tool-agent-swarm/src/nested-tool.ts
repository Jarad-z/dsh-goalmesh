import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { AGENT_SWARM_OUTPUT_SCHEMA, NESTED_AGENT_SWARM_PARAMETERS } from './schema.js'
import type {
  AgentSwarmNestedArgsV03,
  AgentSwarmToolValue,
  ResolvedConfig,
  SwarmLease,
} from './types.js'
import { assertNestedArgsV03, boundedText } from './validation.js'

const NESTED_PROMPT_ORDER = 116.61
const NESTED_AGENT_SWARM_DESCRIPTION =
  'Split this local task into a bounded child-agent DAG attached to the current Agent Swarm. '
  + 'Pass tasks only: the immutable global goal and exact parent identity come from this child-scoped capability. '
  + 'The call waits for every direct nested task and resumes only after the parent reacquires an execution permit.'

type NestedToolOutputValue = InferValue<typeof AGENT_SWARM_OUTPUT_SCHEMA>

/** Internal lifecycle wrapper around the model-facing narrow lease. */
export interface ScopedSwarmLease {
  readonly lease: SwarmLease
  bindCaller(agent: Agent): void
  revoke(reason: string): void
}

function renderNested(value: AgentSwarmToolValue, maxChars: number): string {
  return boundedText(JSON.stringify(value), maxChars)
}

function callView(args: AgentSwarmNestedArgsV03): ToolCallView {
  return {
    card: 'generic',
    kind: 'execute',
    title: `agent_swarm: ${args.tasks.length} nested tasks`,
    rawInput: args.tasks.map(task => task.description).join('\n'),
  }
}

function resultView(
  args: AgentSwarmNestedArgsV03,
  result: { readonly isError: boolean; readonly meta?: unknown },
): ToolResultView {
  if (result.isError) return { card: 'generic', title: `agent_swarm: ${args.tasks.length} nested tasks failed` }
  return { card: 'generic', title: `agent_swarm: ${args.tasks.length}/${args.tasks.length} nested tasks settled` }
}

async function settleLeaseInvocation(lease: SwarmLease, input: Parameters<SwarmLease['invokeNested']>[0]) {
  const handle = lease.invokeNested(input)
  const [execution, cleanup] = await Promise.allSettled([
    handle.result,
    handle.result.then(() => handle.dispose(), () => handle.dispose()),
  ])
  if (execution.status === 'rejected') {
    if (cleanup.status === 'rejected') {
      throw new AggregateError([execution.reason, cleanup.reason], 'nested agent_swarm invocation and cleanup failed')
    }
    throw execution.reason
  }
  if (cleanup.status === 'rejected') throw cleanup.reason
  return execution.value
}

/** Install the exact-lease nested Tool during the child Agent creation transaction. */
export function installChildAgentSwarmTool(
  childCtx: Context,
  binding: ScopedSwarmLease,
  config: ResolvedConfig,
): void {
  const caller = childCtx.agent as Agent
  binding.bindCaller(caller)
  const disposers: (() => void)[] = []
  try {
    disposers.push(childCtx.systemPrompt.section({
      name: `tool:${config.toolName}`,
      order: NESTED_PROMPT_ORDER,
      text: `Use ${config.toolName} without a goal when this local task needs further independent decomposition. `
        + 'The call remains attached to the same immutable global goal and waits for all nested work.',
    }))
    disposers.push(childCtx.tools.register(defineTool({
      name: config.toolName,
      description: NESTED_AGENT_SWARM_DESCRIPTION,
      parameters: NESTED_AGENT_SWARM_PARAMETERS,
      output: {
        schema: AGENT_SWARM_OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: renderNested(value as unknown as AgentSwarmToolValue, config.maxRenderedResultChars),
        }],
        presentationMeta: (_args, value) => {
          const swarm = value as unknown as AgentSwarmToolValue
          return {
            total: swarm.tasks.length,
            settled: swarm.tasks.length,
            terminalReason: swarm.terminalReason,
          }
        },
      },
      async execute(args, exec) {
        assertNestedArgsV03(args as unknown as AgentSwarmNestedArgsV03, config.maxTasks, config.defaultFailureMode)
        if (exec.agent !== caller) throw new Error('nested agent_swarm caller does not own this scoped lease')
        const value = await settleLeaseInvocation(binding.lease, {
          callerAgent: caller,
          callId: exec.callId,
          commandToken: exec.token,
          args: args as unknown as AgentSwarmNestedArgsV03,
          signal: exec.signal,
        })
        return value as unknown as NestedToolOutputValue
      },
      presentCall: args => callView(args as unknown as AgentSwarmNestedArgsV03),
      presentResult: (args, result) => resultView(args as unknown as AgentSwarmNestedArgsV03, result),
    })))
    childCtx.effect(
      () => () => { binding.revoke('child scope disposed') },
      'agent-swarm.lease()',
    )
  } catch (error: unknown) {
    binding.revoke('child scoped Tool setup failed')
    const rollback = disposers.reverse().map((dispose) => {
      try {
        dispose()
        return undefined
      } catch (rollbackError: unknown) {
        return rollbackError
      }
    }).filter(value => value !== undefined)
    if (rollback.length > 0) throw new AggregateError([error, ...rollback], 'nested agent_swarm setup rollback failed')
    throw error
  }
}
