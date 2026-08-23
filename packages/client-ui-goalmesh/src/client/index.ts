import type { ClientContext, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SwarmTrajectoryPanel, type GoalMeshInjected } from './SwarmTrajectoryPanel.js'
import type { SwarmAttemptData } from './trajectory-definition.js'
import { swarmTrajectoryDefinition } from './trajectory-definition.js'
import { en, NS, type GoalMeshLocaleKey, zh } from './locales.js'
import { installStyles } from './styles.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    goalMesh: GoalMeshLocaleKey
  }
}

export type { GoalMeshInjected, SwarmTrajectoryPanelProps } from './SwarmTrajectoryPanel.js'
export type {
  SwarmAttemptData,
  SwarmTaskNodeData,
  SwarmTrajectoryChatData,
  SwarmTrajectoryState,
} from './trajectory-definition.js'
export { isSwarmUpdateEvent, swarmTrajectoryDefinition } from './trajectory-definition.js'

/** Cordis services required by the GoalMesh browser companion. */
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

function directAddress(address: SubagentAddress, attempt: SwarmAttemptData): boolean {
  return address.childSessionId === attempt.childId
    && address.parentSessionId === attempt.parentSessionId
}

async function openAgent(ctx: ClientContext, attempt: SwarmAttemptData): Promise<boolean> {
  if (!attempt.local) return false
  const snapshot = ctx.sessions.list.getSnapshot()
  if (snapshot.ids.includes(attempt.childId)) {
    const summary = snapshot.byId[attempt.childId]
    if (summary?.origin !== 'subagent' || summary.parentId !== attempt.parentSessionId) return false
    ctx.sessions.open(attempt.childId)
    return true
  }
  const retained = ctx.sessions.subagentAddress(attempt.childId)
  if (retained !== undefined) {
    if (!directAddress(retained, attempt)) return false
    ctx.sessions.openSubagent(retained)
    return true
  }
  await ctx.sessions.refreshSubagents(attempt.parentSessionId)
  const refreshed = ctx.sessions.subagentAddress(attempt.childId)
  if (refreshed === undefined || !directAddress(refreshed, attempt)) return false
  ctx.sessions.openSubagent(refreshed)
  return true
}

/** Register the durable Definition, locale, styles, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(swarmTrajectoryDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goalmesh: dictionaries')
  ctx.effect(installStyles, 'ui-goalmesh: styles')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'goalmesh-trajectory',
    locale: NS,
    inject: (): GoalMeshInjected => ({
      openAgent: attempt => openAgent(ctx, attempt),
    }),
  }, SwarmTrajectoryPanel))
}
