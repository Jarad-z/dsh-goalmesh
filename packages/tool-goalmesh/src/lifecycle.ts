import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ResolvedConfig } from './types.js'
import type { SwarmCoordinator } from './coordinator.js'
import { registerRootGoalMeshTool } from './tool.js'

const SWARM_PROMPT_ORDER = 116.6

function assertProvider(provider: SubagentProvider, config: ResolvedConfig): void {
  if (!provider.capabilities.outputSchema || !provider.capabilities.depthLimit) {
    throw new Error(
      `goalmesh: provider "${provider.name}" must support outputSchema and depthLimit for v0.3`,
    )
  }
  if (config.nestedMode === 'local-only' && !provider.capabilities.scopedSetup) {
    throw new Error(
      `goalmesh: provider "${provider.name}" must support scopedSetup for nestedMode "local-only"`,
    )
  }
}

export function bindProviderAndToolLifecycle(
  ctx: Context,
  coordinator: SwarmCoordinator,
  config: ResolvedConfig,
): void {
  let disposeMounted: (() => void) | undefined

  const mount = (provider: SubagentProvider): void => {
    assertProvider(provider, config)
    const disposers: (() => void)[] = []
    try {
      disposers.push(registerRootGoalMeshTool(ctx, coordinator, config))
      disposers.push(ctx.systemPrompt.section({
        name: `tool:${config.toolName}`,
        order: SWARM_PROMPT_ORDER,
        text:
          `Use ${config.toolName} when a goal can be split into a bounded task DAG. `
          + 'Declare dependencies and choose collect-all, fail-fast, or quorum semantics explicitly when needed. '
          + (config.nestedMode === 'local-only'
            ? 'Child tasks may recursively call the same child-scoped Tool without repeating the global goal. '
            : 'Nested decomposition is disabled for this deployment. ')
          + 'After it returns, evaluate the original success criteria '
          + 'yourself from every direct TaskReport; task completion is not proof that the global goal is achieved.',
      }))
      disposeMounted = () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeMounted === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeMounted === undefined) return
    disposeMounted()
    disposeMounted = undefined
  })

  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    ctx.logger.info(
      `subagent provider "${config.provider}" not registered yet; "${config.toolName}" will mount when it appears`,
    )
  } else {
    mount(provider)
  }
}
