import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { SwarmCoordinator } from './coordinator.js'
import { bindProviderAndToolLifecycle } from './lifecycle.js'
import { SessionTrajectoryRecorderFactory } from './recorder.js'
import { ConfigSchema } from './schema.js'
import type { Config as GoalMeshConfig } from './types.js'
import { resolveConfig } from './validation.js'

export const name = 'goalmesh'
export const inject = ['tools', 'subagents', 'systemPrompt']
export const Config = ConfigSchema
export type Config = GoalMeshConfig

export type {
  GoalMeshEventMap,
  GoalMeshEventType,
  GoalMeshRootArgsV01,
  GoalMeshRootArgsV02,
  GoalMeshNestedArgsV03,
  GoalMeshTaskV01,
  GoalMeshTaskV02,
  GoalMeshToolValue,
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

export function apply(ctx: Context, config: GoalMeshConfig): void {
  const resolved = resolveConfig(config)
  const coordinator = new SwarmCoordinator(ctx, resolved, new SessionTrajectoryRecorderFactory(ctx))
  bindProviderAndToolLifecycle(ctx, coordinator, resolved)
  ctx.effect(
    () => async () => { await coordinator.dispose() },
    'goalmesh.coordinator()',
  )
}
