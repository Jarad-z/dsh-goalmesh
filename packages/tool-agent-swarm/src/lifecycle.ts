import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ResolvedConfig } from './types.js'
import type { SwarmCoordinator } from './coordinator.js'
import { registerRootAgentSwarmTool } from './tool.js'

const SWARM_PROMPT_ORDER = 116.6

function assertProvider(provider: SubagentProvider): void {
  if (!provider.capabilities.outputSchema || !provider.capabilities.depthLimit) {
    throw new Error(
      `agent-swarm: provider "${provider.name}" must support outputSchema and depthLimit for v0.1`,
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
    assertProvider(provider)
    const disposers: (() => void)[] = []
    try {
      disposers.push(registerRootAgentSwarmTool(ctx, coordinator, config))
      disposers.push(ctx.systemPrompt.section({
        name: `tool:${config.toolName}`,
        order: SWARM_PROMPT_ORDER,
        text:
          `Use ${config.toolName} when a goal can be split into independent, self-contained tasks. `
          + 'Submit the complete fixed batch in one call. After it returns, evaluate the original success criteria '
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
