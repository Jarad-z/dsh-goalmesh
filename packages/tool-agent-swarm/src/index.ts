import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { SwarmCoordinator } from './coordinator.js'
import { bindProviderAndToolLifecycle } from './lifecycle.js'
import { SessionTrajectoryRecorderFactory } from './recorder.js'
import { ConfigSchema } from './schema.js'
import type { Config as AgentSwarmConfig } from './types.js'
import { resolveConfig } from './validation.js'

export const name = 'agent-swarm'
export const inject = ['tools', 'subagents', 'systemPrompt']
export const Config = ConfigSchema
export type Config = AgentSwarmConfig

export type {
  AgentSwarmEventMap,
  AgentSwarmEventType,
  AgentSwarmRootArgsV01,
  AgentSwarmRootArgsV02,
  AgentSwarmNestedArgsV03,
  AgentSwarmTaskV01,
  AgentSwarmTaskV02,
  AgentSwarmToolValue,
  AttemptId,
  DependencyFailurePolicy,
  InvocationId,
  InvocationFailureMode,
  InvocationTaskResult,
  LeaseToken,
  SwarmId,
  SwarmTaskId,
  SwarmTaskViewStatus,
  SwarmLease,
  TaskReport,
} from './types.js'

export function apply(ctx: Context, config: AgentSwarmConfig): void {
  const resolved = resolveConfig(config)
  const coordinator = new SwarmCoordinator(ctx, resolved, new SessionTrajectoryRecorderFactory(ctx))
  bindProviderAndToolLifecycle(ctx, coordinator, resolved)
  ctx.effect(
    () => async () => { await coordinator.dispose() },
    'agent-swarm.coordinator()',
  )
}
