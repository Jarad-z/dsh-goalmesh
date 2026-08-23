import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { SwarmCoordinator } from '../packages/tool-goalmesh/src/coordinator.js'
import type {
  Launcher,
  LaunchedTask,
  MaterializedTask,
  TaskCompletionOutcome,
} from '../packages/tool-goalmesh/src/launcher.js'
import { SessionTrajectoryRecorderFactory } from '../packages/tool-goalmesh/src/recorder.js'
import type { GoalMeshNestedArgsV03 } from '../packages/tool-goalmesh/src/types.js'
import { resolveConfig } from '../packages/tool-goalmesh/src/validation.js'
import { achieved, fakeAgent, rootArgs, until } from './host-fixture.js'

interface ControlledRun {
  readonly task: MaterializedTask
  readonly launched: LaunchedTask
  readonly child: Agent
  complete(outcome?: TaskCompletionOutcome): void
}

class ControlledLauncher implements Launcher {
  readonly runs: ControlledRun[] = []
  active = 0
  maxActive = 0

  start(task: MaterializedTask): Promise<LaunchedTask> {
    const child = fakeAgent(`controlled-child-${this.runs.length + 1}`)
    task.lease?.bindCaller(child)
    let resolve!: (outcome: TaskCompletionOutcome) => void
    let settled = false
    let disposed = false
    const result = new Promise<TaskCompletionOutcome>((done) => { resolve = done })
    const finish = (outcome: TaskCompletionOutcome): void => {
      if (settled) return
      settled = true
      task.signal.removeEventListener('abort', onAbort)
      this.active--
      resolve(outcome)
    }
    const cancelled = (): TaskCompletionOutcome => ({
      ok: false,
      failure: {
        kind: 'cancelled',
        phase: 'running',
        scope: 'attempt',
        message: 'controlled child cancelled',
        taskId: task.taskId,
        attemptId: task.attemptId,
        occurredAt: Date.now(),
      },
    })
    const onAbort = (): void => { finish(cancelled()) }
    task.signal.addEventListener('abort', onAbort, { once: true })
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    const launched: LaunchedTask = {
      childId: child.id,
      local: true,
      settled: result,
      dispose: (): Promise<void> => {
        if (!disposed) {
          disposed = true
          finish(cancelled())
        }
        return Promise.resolve()
      },
    }
    this.runs.push({
      task,
      launched,
      child,
      complete: (outcome = { ok: true, report: achieved(task.description) }): void => { finish(outcome) },
    })
    return Promise.resolve(launched)
  }
}

const nestedArgs = (count = 1): GoalMeshNestedArgsV03 => ({
  tasks: Array.from({ length: count }, (_, index) => ({
    key: `nested-${index + 1}`,
    description: `Nested ${index + 1}`,
    objective: `Complete nested task ${index + 1}`,
    acceptance_criteria: [`Nested ${index + 1} has evidence`],
  })),
})

let tokenId = 0
const token = (): ToolExecutionToken => Symbol(`nested-command-${++tokenId}`) as ToolExecutionToken

async function waitForRunning(agent: Agent, count = 1): Promise<void> {
  await until(() => agent.session.events.filter(event => (
    event.type === 'tool-goalmesh/task-transition'
      && (event.data as { readonly to?: unknown }).to === 'running'
  )).length >= count)
}

async function setup(config: {
  readonly maxConcurrency?: number
  readonly attemptTimeoutMs?: number
  readonly maxDepth?: number
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  const provider: SubagentProvider = {
    name: 'local',
    inheritsParentContext: false,
    capabilities: {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
      scopedSetup: true,
    },
    start: () => Promise.reject(new Error('the controlled launcher owns starts')),
  }
  ctx.subagents.registerProvider(provider)
  const launcher = new ControlledLauncher()
  let id = 0
  const coordinator = new SwarmCoordinator(
    ctx,
    resolveConfig({
      provider: provider.name,
      nestedMode: 'local-only',
      maxTasks: 8,
      maxDepth: config.maxDepth ?? 3,
      maxConcurrency: config.maxConcurrency ?? 1,
      attemptTimeoutMs: config.attemptTimeoutMs ?? 5_000,
      swarmTimeoutMs: 10_000,
    }),
    new SessionTrajectoryRecorderFactory(ctx),
    { launcher, id: () => String(++id), now: () => id * 10 },
  )
  const root = fakeAgent('nested-root')
  const rootController = new AbortController()
  const rootHandle = coordinator.invokeRoot({
    rootAgent: root,
    callId: CallId('root-call'),
    commandToken: token(),
    args: rootArgs(1),
    signal: rootController.signal,
  })
  return { coordinator, launcher, root, rootController, rootHandle }
}

describe('GoalMesh v0.3 nested scheduling', () => {
  it('releases a maxConcurrency=1 parent permit and resolves only after resume is committed', async () => {
    const mounted = await setup({ maxConcurrency: 1 })
    await until(() => mounted.launcher.runs.length === 1)
    await waitForRunning(mounted.root)
    const parent = mounted.launcher.runs[0]!
    const binding = parent.task.lease!
    const caller = parent.child

    for (const args of [
      { ...nestedArgs(), goal: { statement: 'forged' } },
      { ...nestedArgs(), swarmId: 'forged' },
      { ...nestedArgs(), attemptId: 'forged' },
    ]) {
      expect(() => binding.lease.invokeNested({
        callerAgent: caller,
        callId: CallId('forged-call'),
        commandToken: token(),
        args: args as unknown as GoalMeshNestedArgsV03,
        signal: new AbortController().signal,
      })).toThrow(/unknown field/)
    }
    expect(mounted.root.session.events.filter(event => event.type === 'tool-goalmesh/task-created')).toHaveLength(1)
    expect(() => binding.lease.invokeNested({
      callerAgent: fakeAgent('forged-caller'),
      callId: CallId('forged-caller-call'),
      commandToken: token(),
      args: nestedArgs(),
      signal: new AbortController().signal,
    })).toThrow(/caller does not match the leased child/)

    const nested = binding.lease.invokeNested({
      callerAgent: caller,
      callId: CallId('nested-valid'),
      commandToken: token(),
      args: nestedArgs(),
      signal: new AbortController().signal,
    })
    await until(() => mounted.launcher.runs.length === 2)
    expect(mounted.launcher.maxActive).toBe(2)
    mounted.launcher.runs[1]!.complete()
    const nestedValue = await nested.result
    expect(nestedValue).toMatchObject({ kind: 'nested', summary: { completed: 1, descendants: 0 } })

    const transitions = mounted.root.session.events
      .filter(event => event.type === 'tool-goalmesh/task-transition')
      .map(event => `${String((event.data as { from: string }).from)}>${String((event.data as { to: string }).to)}`)
    expect(transitions).toContain('running>waiting_children')
    expect(transitions).toContain('waiting_children>ready_to_resume')
    expect(transitions.indexOf('ready_to_resume>running'))
      .toBeGreaterThan(transitions.indexOf('waiting_children>ready_to_resume'))

    parent.complete()
    const rootValue = await mounted.rootHandle.result
    expect(rootValue).toMatchObject({ kind: 'root', summary: { completed: 1, descendants: 1 } })
    expect(mounted.root.session.events.map(event => event.type).filter(type => type.startsWith('tool-goalmesh/')))
      .toMatchInlineSnapshot(`
        [
          "tool-goalmesh/run-start",
          "tool-goalmesh/invocation-start",
          "tool-goalmesh/task-created",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/attempt-start",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/invocation-start",
          "tool-goalmesh/task-created",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/attempt-start",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/attempt-end",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/invocation-end",
          "tool-goalmesh/attempt-end",
          "tool-goalmesh/task-transition",
          "tool-goalmesh/invocation-end",
          "tool-goalmesh/run-end",
        ]
      `)
    await nested.dispose()
    await mounted.rootHandle.dispose()
    expect(() => binding.lease.invokeNested({
      callerAgent: caller,
      callId: CallId('late-call'),
      commandToken: token(),
      args: nestedArgs(),
      signal: new AbortController().signal,
    })).toThrow(/inactive Swarm|revoked/)
  })

  it('does not issue a nested lease at the configured depth boundary', async () => {
    const mounted = await setup({ maxDepth: 1 })
    await until(() => mounted.launcher.runs.length === 1)
    const parent = mounted.launcher.runs[0]!
    expect(parent.task.lease).toBeUndefined()
    expect(parent.task.prompt).toContain('configured Swarm depth limit')
    parent.complete()
    await mounted.rootHandle.result
    await mounted.rootHandle.dispose()
  })

  it('cancels one nested subtree without cancelling its parent or an unrelated root sibling', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    const provider: SubagentProvider = {
      name: 'local',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, scopedSetup: true },
      start: () => Promise.reject(new Error('unused')),
    }
    ctx.subagents.registerProvider(provider)
    const launcher = new ControlledLauncher()
    const coordinator = new SwarmCoordinator(
      ctx,
      resolveConfig({ provider: 'local', nestedMode: 'local-only', maxConcurrency: 2, maxTasks: 8 }),
      new SessionTrajectoryRecorderFactory(ctx),
      { launcher },
    )
    const root = fakeAgent('cancel-scope-root')
    const rootHandle = coordinator.invokeRoot({
      rootAgent: root,
      callId: CallId('cancel-root'),
      commandToken: token(),
      args: rootArgs(2),
      signal: new AbortController().signal,
    })
    await until(() => launcher.runs.length === 2)
    await waitForRunning(root, 2)
    const first = launcher.runs[0]!
    const sibling = launcher.runs[1]!
    const caller = first.child
    const nestedController = new AbortController()
    const nested = first.task.lease!.lease.invokeNested({
      callerAgent: caller,
      callId: CallId('cancel-nested'),
      commandToken: token(),
      args: nestedArgs(),
      signal: nestedController.signal,
    })
    await until(() => launcher.runs.length === 3)
    nestedController.abort('cancel only nested')
    await expect(nested.result).rejects.toThrow(/nested goal_mesh invocation was cancelled/)
    expect(first.task.signal.aborted).toBe(false)
    expect(sibling.task.signal.aborted).toBe(false)
    first.complete()
    sibling.complete()
    const value = await rootHandle.result
    expect(value.summary).toMatchObject({ completed: 2, descendants: 1 })
    await nested.dispose()
    await rootHandle.dispose()
  })

  it('limits a parent attempt timeout to that parent subtree', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    const provider: SubagentProvider = {
      name: 'local',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, scopedSetup: true },
      start: () => Promise.reject(new Error('unused')),
    }
    ctx.subagents.registerProvider(provider)
    const launcher = new ControlledLauncher()
    const coordinator = new SwarmCoordinator(
      ctx,
      resolveConfig({
        provider: 'local',
        nestedMode: 'local-only',
        maxConcurrency: 2,
        maxTasks: 8,
        attemptTimeoutMs: 200,
        swarmTimeoutMs: 2_000,
      }),
      new SessionTrajectoryRecorderFactory(ctx),
      { launcher },
    )
    const root = fakeAgent('parent-timeout-root')
    const rootHandle = coordinator.invokeRoot({
      rootAgent: root,
      callId: CallId('parent-timeout'),
      commandToken: token(),
      args: rootArgs(2),
      signal: new AbortController().signal,
    })
    await until(() => launcher.runs.length === 2)
    await waitForRunning(root, 2)
    const parent = launcher.runs[0]!
    const sibling = launcher.runs[1]!
    const nested = parent.task.lease!.lease.invokeNested({
      callerAgent: parent.child,
      callId: CallId('parent-timeout-nested'),
      commandToken: token(),
      args: nestedArgs(),
      signal: new AbortController().signal,
    })
    await until(() => launcher.runs.length === 3)
    sibling.complete()

    await expect(nested.result).rejects.toThrow()
    const value = await rootHandle.result
    expect(value.tasks.map(task => ({ key: task.key, status: task.status }))).toEqual([
      { key: 'task-1', status: 'failed' },
      { key: 'task-2', status: 'completed' },
    ])
    expect(value.tasks[0]?.failure).toMatchObject({ kind: 'timeout' })
    expect(sibling.task.signal.aborted).toBe(false)
    expect(launcher.active).toBe(0)
    await nested.dispose()
    await rootHandle.dispose()
  })

  it('root cancellation reaches parent, child, and sibling scopes and waits for settlement', async () => {
    const mounted = await setup({ maxConcurrency: 1 })
    await until(() => mounted.launcher.runs.length === 1)
    await waitForRunning(mounted.root)
    const parent = mounted.launcher.runs[0]!
    const caller = parent.child
    const nested = parent.task.lease!.lease.invokeNested({
      callerAgent: caller,
      callId: CallId('root-cancel-nested'),
      commandToken: token(),
      args: nestedArgs(),
      signal: new AbortController().signal,
    })
    await until(() => mounted.launcher.runs.length === 2)
    mounted.rootController.abort('root cancelled')
    await expect(nested.result).rejects.toThrow()
    await expect(mounted.rootHandle.result).rejects.toThrow(/cancelled by its caller/)
    expect(mounted.launcher.runs.every(run => run.task.signal.aborted)).toBe(true)
    expect(mounted.launcher.active).toBe(0)
    await nested.dispose()
    await mounted.rootHandle.dispose()
  })
})
