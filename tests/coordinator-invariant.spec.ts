import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { SwarmCoordinator } from '../packages/tool-agent-swarm/src/coordinator.js'
import { applyTrajectoryEvent } from '../packages/tool-agent-swarm/src/invariant.js'
import type { LaunchedTask, Launcher, MaterializedTask } from '../packages/tool-agent-swarm/src/launcher.js'
import { SessionTrajectoryRecorderFactory } from '../packages/tool-agent-swarm/src/recorder.js'
import type {
  AgentSwarmEventMap,
  AgentSwarmEventType,
  SwarmId,
  TrajectoryRecorderFactory,
  TrajectorySink,
} from '../packages/tool-agent-swarm/src/types.js'
import { resolveConfig } from '../packages/tool-agent-swarm/src/validation.js'
import { ScriptedProvider, achieved, fakeAgent, rootArgs } from './host-fixture.js'

class MemoryRecorder implements TrajectoryRecorderFactory, TrajectorySink {
  readonly events: { type: AgentSwarmEventType; data: AgentSwarmEventMap[AgentSwarmEventType] }[] = []

  create(): TrajectorySink {
    return this
  }

  append<T extends AgentSwarmEventType>(type: T, data: AgentSwarmEventMap[T]): void {
    this.events.push({ type, data })
  }
}

class ImmediateLauncher implements Launcher {
  starts = 0
  disposals = 0

  async start(task: MaterializedTask): Promise<LaunchedTask> {
    this.starts++
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      this.disposals++
    }
    return {
      childId: `child-${this.starts}` as never,
      local: true,
      settled: Promise.resolve().then(async () => {
        await dispose()
        return { ok: true as const, report: achieved(task.description) }
      }),
      dispose,
    }
  }
}

describe('SwarmCoordinator command identity', () => {
  it('deduplicates re-entry by ToolExecutionToken but never by callId', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(new ScriptedProvider())
    const launcher = new ImmediateLauncher()
    const recorder = new MemoryRecorder()
    const coordinator = new SwarmCoordinator(
      ctx,
      resolveConfig({ provider: 'mock', maxConcurrency: 2 }),
      recorder,
      { launcher },
    )
    const token = Symbol('same execution') as ToolExecutionToken
    const input = {
      rootAgent: fakeAgent('idempotent-root'),
      callId: CallId('same-call'),
      commandToken: token,
      args: rootArgs(3),
      signal: new AbortController().signal,
    }
    const first = coordinator.invokeRoot(input)
    const second = coordinator.invokeRoot(input)

    expect(second.swarmId).toBe(first.swarmId)
    expect(second.invocationId).toBe(first.invocationId)
    const [firstValue, secondValue] = await Promise.all([first.result, second.result])
    expect(secondValue).toEqual(firstValue)
    expect(launcher.starts).toBe(3)
    expect(recorder.events.filter(event => event.type === 'tool-agent-swarm/task-created')).toHaveLength(3)
    await first.dispose()
    await second.dispose()

    const third = coordinator.invokeRoot({
      ...input,
      commandToken: Symbol('different execution') as ToolExecutionToken,
    })
    await third.result
    await third.dispose()
    expect(third.swarmId).not.toBe(first.swarmId)
    expect(launcher.starts).toBe(6)
    await coordinator.dispose()
  })
})

function trajectoryEvent<T extends AgentSwarmEventType>(
  type: T,
  data: AgentSwarmEventMap[T],
  seq: number,
): SessionEvent {
  return { type, data, seq, time: seq, ignorable: true } as SessionEvent
}

function validTrajectory(): SessionEvent[] {
  const swarmId = 'swarm-1' as SwarmId
  return [
    trajectoryEvent('tool-agent-swarm/run-start', {
      swarmId,
      rootSessionId: 'root' as never,
      goalSummary: 'goal',
    }, 0),
    trajectoryEvent('tool-agent-swarm/invocation-start', {
      swarmId,
      invocationId: 'inv-1' as never,
      callerSessionId: 'root' as never,
    }, 1),
    trajectoryEvent('tool-agent-swarm/task-created', {
      swarmId,
      invocationId: 'inv-1' as never,
      taskId: 'task-1' as never,
      key: 'one',
      label: 'One',
      objectiveSummary: 'Do one',
      acceptanceCriteriaSummary: ['done'],
      dependencies: [],
      depth: 1,
    }, 2),
    trajectoryEvent('tool-agent-swarm/task-transition', {
      swarmId,
      taskId: 'task-1' as never,
      from: 'ready',
      to: 'starting',
    }, 3),
    trajectoryEvent('tool-agent-swarm/attempt-start', {
      swarmId,
      taskId: 'task-1' as never,
      attemptId: 'attempt-1' as never,
      attemptNo: 1,
      childId: 'child-1' as never,
      parentSessionId: 'root' as never,
      provider: 'mock',
      local: true,
    }, 4),
    trajectoryEvent('tool-agent-swarm/task-transition', {
      swarmId,
      taskId: 'task-1' as never,
      from: 'starting',
      to: 'running',
    }, 5),
    trajectoryEvent('tool-agent-swarm/attempt-end', {
      swarmId,
      taskId: 'task-1' as never,
      attemptId: 'attempt-1' as never,
      outcome: 'completed',
    }, 6),
    trajectoryEvent('tool-agent-swarm/task-transition', {
      swarmId,
      taskId: 'task-1' as never,
      from: 'running',
      to: 'completed',
    }, 7),
    trajectoryEvent('tool-agent-swarm/invocation-end', {
      swarmId,
      invocationId: 'inv-1' as never,
      status: 'completed',
    }, 8),
    trajectoryEvent('tool-agent-swarm/run-end', {
      swarmId,
      status: 'completed',
      completed: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      timedOut: 0,
    }, 9),
  ]
}

function fold(events: readonly SessionEvent[]): void {
  const trace = new Map()
  const fail = (message: string): never => { throw new Error(message) }
  for (const event of events) applyTrajectoryEvent(trace, event, fail)
}

describe('AgentSwarm trajectory invariant', () => {
  it('accepts a complete trace and every legal interrupted prefix', () => {
    const events = validTrajectory()
    expect(() => fold(events)).not.toThrow()
    for (let length = 1; length < events.length; length++) {
      expect(() => fold(events.slice(0, length))).not.toThrow()
    }
  })

  it('rejects duplicate start, orphan transition, unpaired attempt, updates after end, and non-ignorable events', () => {
    const valid = validTrajectory()
    expect(() => fold([valid[0]!, valid[0]!])).toThrow(/repeats swarm/)
    expect(() => fold([valid[0]!, valid[1]!, valid[3]!])).toThrow(/no created task/)
    expect(() => fold([...valid.slice(0, 6), valid[7]!])).toThrow(/precedes attempt-end/)
    expect(() => fold([...valid.slice(0, 6), valid[8]!, valid[9]!])).toThrow(/tasks open/)
    expect(() => fold([...valid, valid[7]!])).toThrow(/after run-end/)
    expect(() => fold([{ ...valid[0]!, ignorable: undefined } as unknown as SessionEvent])).toThrow(/ignorable/)
  })

  it('rejects a dependency cycle reconstructed from an otherwise terminal trace', () => {
    const swarmId = 'swarm-1' as SwarmId
    const prefix = validTrajectory().slice(0, 2)
    const task = (seq: number, taskId: string, dependencyId: string): SessionEvent =>
      trajectoryEvent('tool-agent-swarm/task-created', {
        swarmId,
        invocationId: 'inv-1' as never,
        taskId: taskId as never,
        key: taskId,
        label: taskId,
        objectiveSummary: taskId,
        acceptanceCriteriaSummary: ['done'],
        dependencies: [dependencyId as never],
        depth: 1,
      }, seq)
    const terminal = (seq: number, taskId: string): SessionEvent =>
      trajectoryEvent('tool-agent-swarm/task-transition', {
        swarmId,
        taskId: taskId as never,
        from: 'waiting',
        to: 'failed',
        reason: 'dependency_deadlock',
      }, seq)
    const end = trajectoryEvent('tool-agent-swarm/invocation-end', {
      swarmId,
      invocationId: 'inv-1' as never,
      status: 'partial',
    }, 6)

    expect(() => fold([
      ...prefix,
      task(2, 'task-a', 'task-b'),
      task(3, 'task-b', 'task-a'),
      terminal(4, 'task-a'),
      terminal(5, 'task-b'),
      end,
    ])).toThrow(/dependency cycle/)
  })

  it('rejects nested invocation parents and depths that do not match the durable tree', () => {
    const swarmId = 'swarm-1' as SwarmId
    const prefix = validTrajectory().slice(0, 3)
    const nestedStart = trajectoryEvent('tool-agent-swarm/invocation-start', {
      swarmId,
      invocationId: 'inv-nested' as never,
      parentTaskId: 'task-1' as never,
      callerSessionId: 'child-1' as never,
    }, 3)
    const nestedTask = trajectoryEvent('tool-agent-swarm/task-created', {
      swarmId,
      invocationId: 'inv-nested' as never,
      taskId: 'task-nested' as never,
      parentTaskId: 'task-1' as never,
      key: 'nested',
      label: 'Nested',
      objectiveSummary: 'Nested objective',
      acceptanceCriteriaSummary: ['done'],
      dependencies: [],
      depth: 3,
    }, 4)

    expect(() => fold([...prefix, nestedStart, nestedTask])).toThrow(/does not follow parent depth/)
    expect(() => fold([
      ...prefix,
      trajectoryEvent('tool-agent-swarm/invocation-start', {
        swarmId,
        invocationId: 'inv-orphan' as never,
        parentTaskId: 'missing-parent' as never,
        callerSessionId: 'child-1' as never,
      }, 3),
    ])).toThrow(/no created parent task/)
  })
})

describe('trajectory recorder failure boundary', () => {
  it('stops after the first append failure and never changes scheduler outcomes', () => {
    const append = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('storage unavailable') })
    const warn = vi.fn()
    const factory = new SessionTrajectoryRecorderFactory({ logger: { warn } } as unknown as Context)
    const sink = factory.create({ append } as unknown as Session, 'swarm-recorder' as SwarmId)
    const start = validTrajectory()[0]!
    const invocation = validTrajectory()[1]!
    sink.append(start.type as AgentSwarmEventType, start.data as never)
    sink.append(invocation.type as AgentSwarmEventType, invocation.data as never)
    sink.append(invocation.type as AgentSwarmEventType, invocation.data as never)

    expect(append).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
