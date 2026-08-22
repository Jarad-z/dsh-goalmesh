import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  AgentSwarmEventMap,
  AgentSwarmEventType,
  SwarmId,
  TrajectoryRecorderFactory,
  TrajectorySink,
} from './types.js'
import { sanitizeDiagnostic } from './validation.js'

class SessionTrajectorySink implements TrajectorySink {
  private enabled = true

  constructor(
    private readonly ctx: Context,
    private readonly session: Session,
    private readonly swarmId: SwarmId,
  ) {}

  append<T extends AgentSwarmEventType>(type: T, data: AgentSwarmEventMap[T]): void {
    if (!this.enabled) return
    try {
      // The generic correlation is carried by AgentSwarmEventMap; Session's
      // independently augmented map cannot prove the indexed relation for T.
      const append = this.session.append.bind(this.session) as unknown as (
        eventType: AgentSwarmEventType,
        eventData: AgentSwarmEventMap[AgentSwarmEventType],
        intent: { readonly ignorable: true },
      ) => unknown
      append(type, data, { ignorable: true })
    } catch (error: unknown) {
      this.enabled = false
      this.ctx.logger.warn(
        `agent-swarm trajectory disabled for ${this.swarmId} after append failure: ${sanitizeDiagnostic(error)}`,
      )
    }
  }
}

export class SessionTrajectoryRecorderFactory implements TrajectoryRecorderFactory {
  constructor(private readonly ctx: Context) {}

  create(session: Session, swarmId: SwarmId): TrajectorySink {
    return new SessionTrajectorySink(this.ctx, session, swarmId)
  }
}
