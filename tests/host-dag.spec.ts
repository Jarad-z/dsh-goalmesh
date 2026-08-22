import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { dependencyDeadlockCandidates } from '../packages/tool-agent-swarm/src/dag.js'
import { applyTrajectoryEvent } from '../packages/tool-agent-swarm/src/invariant.js'
import type { AgentSwarmRootArgsV02, AgentSwarmToolValue } from '../packages/tool-agent-swarm/src/types.js'
import {
  ScriptedProvider,
  achieved,
  executeSwarm,
  fakeAgent,
  mountHost,
  rootArgs,
  until,
} from './host-fixture.js'

function valueOf(result: Awaited<ReturnType<typeof executeSwarm>>): AgentSwarmToolValue {
  if (result.isError) throw new Error('expected a successful aggregate result')
  return result.value as unknown as AgentSwarmToolValue
}

function dagArgs(
  dependencyFailure: 'fail' | 'skip' | 'partial' = 'fail',
): AgentSwarmRootArgsV02 {
  const args = rootArgs(2)
  return {
    ...args,
    tasks: [
      args.tasks[0]!,
      {
        ...args.tasks[1]!,
        depends_on: ['task-1'],
        dependency_failure: dependencyFailure,
      },
    ],
  }
}

function promptText(request: ScriptedProvider['requests'][number] | undefined): string {
  if (request === undefined) return ''
  return request.prompt
    .map(part => part.type === 'text' ? part.text : '')
    .join('\n')
}

function expectValidTrajectory(events: readonly SessionEvent[]): void {
  const trace = new Map()
  const fail = (message: string): never => { throw new Error(message) }
  for (const event of events.filter(event => event.type.startsWith('tool-agent-swarm/'))) {
    applyTrajectoryEvent(trace, event, fail)
  }
}

describe('AgentSwarm v0.2 DAG admission and scheduling', () => {
  it.each([
    ['missing dependency', {
      ...dagArgs(),
      tasks: [dagArgs().tasks[0]!, { ...dagArgs().tasks[1]!, depends_on: ['missing'] }],
    }, /dependency_missing/],
    ['dependency cycle', {
      ...dagArgs(),
      tasks: [
        { ...dagArgs().tasks[0]!, depends_on: ['task-2'] },
        { ...dagArgs().tasks[1]!, depends_on: ['task-1'] },
      ],
    }, /dependency_cycle/],
  ])('atomically rejects %s before creating a run', async (_name, args, message) => {
    const mounted = await mountHost()
    const agent = fakeAgent(`atomic-${_name}`)
    const result = await executeSwarm(mounted.ctx, args, { agent })

    expect(result.isError).toBe(true)
    expect(result.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(message)
    expect(mounted.provider.requests).toHaveLength(0)
    expect(agent.session.events.some(event => event.type.startsWith('tool-agent-swarm/'))).toBe(false)
  })

  it('holds a join until every dependency settles, then materializes stable dependency summaries', async () => {
    let releaseOne!: () => void
    let releaseTwo!: () => void
    const firstGate = new Promise<void>(resolve => { releaseOne = resolve })
    const secondGate = new Promise<void>(resolve => { releaseTwo = resolve })
    const provider = new ScriptedProvider(request => ({
      ...request.label === 'Task 1' ? { resultGate: firstGate } : {},
      ...request.label === 'Task 2' ? { resultGate: secondGate } : {},
      structured: achieved(request.label ?? 'task'),
    }))
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const args = rootArgs(3)
    const agent = fakeAgent('dag-join')
    const pending = executeSwarm(mounted.ctx, {
      ...args,
      tasks: [
        args.tasks[0]!,
        args.tasks[1]!,
        { ...args.tasks[2]!, depends_on: ['task-1', 'task-2'] },
      ],
    }, { agent })

    await until(() => provider.requests.length === 2)
    releaseOne()
    await until(() => provider.disposed === 1)
    expect(provider.requests.map(request => request.label)).toEqual(['Task 1', 'Task 2'])
    releaseTwo()
    await until(() => provider.requests.length === 3)
    const value = valueOf(await pending)

    expect(value.tasks.map(task => task.key)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(value.summary.completed).toBe(3)
    expect(promptText(provider.requests[2])).toContain('task-1: reported_status=achieved; summary=Task 1')
    expect(promptText(provider.requests[2])).toContain('task-2: reported_status=achieved; summary=Task 2')
    expect(() => expectValidTrajectory(agent.session.events)).not.toThrow()
  })

  it.each([
    ['fail', 'failed', 1, 'dependency_failed'],
    ['skip', 'skipped', 1, 'dependency_failed'],
    ['partial', 'completed', 2, undefined],
  ] as const)('propagates a failed dependency with %s policy', async (policy, status, starts, failureKind) => {
    const provider = new ScriptedProvider(request => request.label === 'Task 1'
      ? { stopReason: 'error' }
      : { structured: achieved('continued with partial inputs') })
    const mounted = await mountHost(provider, { maxConcurrency: 1 })
    const value = valueOf(await executeSwarm(mounted.ctx, dagArgs(policy)))

    expect(provider.requests).toHaveLength(starts)
    expect(value.tasks[0]).toMatchObject({ status: 'failed', failure: { kind: 'child_error' } })
    expect(value.tasks[1]).toMatchObject({
      status,
      ...failureKind === undefined ? {} : { failure: { kind: failureKind } },
    })
    if (policy === 'partial') {
      expect(promptText(provider.requests[1])).toContain('task-1: missing input; status=failed; failure=child_error')
    }
  })

  it('fails fast within the invocation and returns already-settled evidence', async () => {
    const never = new Promise<void>(() => {})
    const provider = new ScriptedProvider(request => request.label === 'Task 1'
      ? { stopReason: 'error' }
      : request.label === 'Task 2'
        ? { resultGate: never, structured: achieved('late') }
        : { structured: achieved('should not start') })
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const value = valueOf(await executeSwarm(mounted.ctx, {
      ...rootArgs(4),
      failure_mode: 'fail_fast',
    }))

    expect(value.terminalReason).toBe('failed_fast')
    expect(value.tasks[0]).toMatchObject({ status: 'failed', failure: { kind: 'child_error' } })
    expect(value.tasks.slice(1).every(task => task.status === 'aborted')).toBe(true)
    expect(provider.requests).toHaveLength(2)
    expect(provider.active).toBe(0)
  })

  it('uses the configured fail-fast default when the invocation omits failure_mode', async () => {
    const mounted = await mountHost(
      new ScriptedProvider(request => request.label === 'Task 1' ? { stopReason: 'error' } : {}),
      { maxConcurrency: 1, defaultFailureMode: 'fail_fast' },
    )
    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(3)))
    expect(value.terminalReason).toBe('failed_fast')
    expect(mounted.provider.requests).toHaveLength(1)
  })

  it('cancels only remaining invocation work when quorum is reached', async () => {
    const never = new Promise<void>(() => {})
    const provider = new ScriptedProvider(request => request.label === 'Task 2'
      ? { resultGate: never, structured: achieved('late') }
      : { structured: achieved(request.label ?? 'task') })
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const value = valueOf(await executeSwarm(mounted.ctx, {
      ...rootArgs(4),
      failure_mode: 'quorum',
      quorum: 1,
    }))

    expect(value.terminalReason).toBe('quorum_reached')
    expect(value.summary.completed).toBe(1)
    expect(value.summary.aborted).toBe(3)
    expect(provider.requests).toHaveLength(2)
    expect(provider.active).toBe(0)
  })

  it.each([
    [{ ...rootArgs(2), quorum: 1 }, /only with failure_mode/],
    [{ ...rootArgs(2), failure_mode: 'quorum' }, /quorum is required/],
    [{ ...rootArgs(2), failure_mode: 'quorum', quorum: 3 }, /no greater than 2/],
  ])('rejects invalid quorum arguments atomically', async (args, message) => {
    const mounted = await mountHost()
    const result = await executeSwarm(mounted.ctx, args)
    expect(result.isError).toBe(true)
    expect(result.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(message)
    expect(mounted.provider.requests).toHaveLength(0)
  })

  it('identifies the no-ready/no-active dependency deadlock audit boundary', () => {
    expect(dependencyDeadlockCandidates([
      { id: 'waiting-a', phase: 'waiting' },
      { id: 'done', phase: 'terminal' },
    ], 0, 0)).toEqual(['waiting-a'])
    expect(dependencyDeadlockCandidates([{ id: 'waiting-a', phase: 'waiting' }], 1, 0)).toEqual([])
    expect(dependencyDeadlockCandidates([{ id: 'running-a', phase: 'running' }], 0, 1)).toEqual([])
  })
})
