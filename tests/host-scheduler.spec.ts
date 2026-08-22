import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as host from '../packages/tool-agent-swarm/src/index.js'
import { ScriptedProvider, achieved, executeSwarm, fakeAgent, mountHost, rootArgs, until } from './host-fixture.js'
import type { AgentSwarmToolValue } from '../packages/tool-agent-swarm/src/types.js'

function valueOf(result: Awaited<ReturnType<typeof executeSwarm>>): AgentSwarmToolValue {
  if (result.isError) throw new Error('expected success')
  return result.value as unknown as AgentSwarmToolValue
}

describe('AgentSwarm Host v0.1 scheduler', () => {
  it.each([1, 4, 5, 64])('settles %i tasks with bounded concurrency and stable input order', async (count) => {
    const provider = new ScriptedProvider(request => ({
      delayMs: (count - Number(request.label?.split(' ')[1] ?? 0)) % 4,
      structured: achieved(request.label ?? 'task'),
    }))
    const mounted = await mountHost(provider, { maxConcurrency: 4, maxTasks: 64 })
    const agent = fakeAgent(`root-count-${count}`)
    const result = await executeSwarm(mounted.ctx, rootArgs(count), { agent })
    const value = valueOf(result)

    expect(value.tasks).toHaveLength(count)
    expect(value.tasks.map(task => task.key)).toEqual(rootArgs(count).tasks.map(task => task.key))
    expect(value.summary).toMatchObject({ completed: count, failed: 0, aborted: 0 })
    expect(provider.maxActive).toBeLessThanOrEqual(4)
    expect(provider.disposed).toBe(count)
    expect(provider.active).toBe(0)

    const events = agent.session.events.filter(event => event.type.startsWith('tool-agent-swarm/'))
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(event => event.ignorable === true)).toBe(true)
    expect(events.at(-1)?.type).toBe('tool-agent-swarm/run-end')
  })

  it('rejects oversized and future/identity-bearing input before starting a child', async () => {
    const mounted = await mountHost(new ScriptedProvider(), { maxTasks: 2 })

    for (const args of [
      rootArgs(3),
      { ...rootArgs(1), failure_mode: 'collect_all' },
      { ...rootArgs(1), swarmId: 'forged' },
      {
        ...rootArgs(1),
        tasks: [{ ...rootArgs(1).tasks[0], depends_on: [] }],
      },
    ]) {
      const result = await executeSwarm(mounted.ctx, args)
      expect(result.isError).toBe(true)
    }
    expect(mounted.provider.requests).toHaveLength(0)
  })

  it('rejects nested callers at runtime while v0.1 nested mode is disabled', async () => {
    const mounted = await mountHost()
    const child = fakeAgent('nested-caller')
    ;(child.options as { subagentDepth?: number }).subagentDepth = 1
    const result = await executeSwarm(mounted.ctx, rootArgs(1), { agent: child })
    expect(result.isError).toBe(true)
    expect(mounted.provider.requests).toHaveLength(0)
  })

  it('publishes only the v0.1 schema, stays exclusive, and replays generic cards from persisted values', async () => {
    const mounted = await mountHost()
    const schema = mounted.ctx.tools.schemas().find(candidate => candidate.name === 'agent_swarm')
    if (schema === undefined) throw new Error('agent_swarm schema was not registered')
    expect(Object.keys((schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}).sort())
      .toEqual(['goal', 'tasks'])
    expect(mounted.ctx.tools.executionMode({
      callId: 'exclusive' as never,
      name: 'agent_swarm',
      arguments: rootArgs(2),
      signal: new AbortController().signal,
    })).toEqual({ kind: 'exclusive' })

    const definition = mounted.ctx.tools.get('agent_swarm')
    expect(definition?.presentCall?.(rootArgs(2))).toMatchObject({
      card: 'generic',
      title: 'agent_swarm: 2 tasks',
      rawInput: 'Complete the batch',
    })
    const result = await executeSwarm(mounted.ctx, rootArgs(2))
    expect(definition?.presentResult?.(rootArgs(2), result)).toMatchObject({
      card: 'generic',
      title: 'agent_swarm: 2/2 settled',
    })
  })

  it('assembles the real plugin composition in Native and Code Mode', async () => {
    const native = await mountHost()
    const nativeAssembly = await native.ctx.systemPrompt.assemble()
    expect(nativeAssembly.tools.map(tool => tool.name)).toEqual(['agent_swarm'])
    expect(nativeAssembly.sections.find(section => section.name === 'tool:agent_swarm')?.text)
      .toContain('complete fixed batch')

    const code = await mountHost(new ScriptedProvider(), {}, { toolMode: 'code' })
    const codeAssembly = await code.ctx.systemPrompt.assemble()
    expect(codeAssembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(codeAssembly.sections.find(section => section.name === 'tools:sdk')?.text)
      .toContain('agent_swarm:')
    expect(codeAssembly.sections.find(section => section.name === 'tool:agent_swarm')?.text)
      .toContain('complete fixed batch')
  })

  it('collects a start rejection while successful siblings continue', async () => {
    const provider = new ScriptedProvider(request => request.label === 'Task 2'
      ? { rejectStart: 'publication failed' }
      : { structured: achieved(request.label ?? 'task') })
    const mounted = await mountHost(provider, { maxConcurrency: 2 })

    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(4)))
    expect(value.summary).toMatchObject({ completed: 3, failed: 1 })
    expect(value.tasks[1]).toMatchObject({ status: 'failed', failure: { kind: 'launch_failed' } })
    expect(value.tasks.filter(task => task.status === 'completed')).toHaveLength(3)
  })

  it.each([
    ['missing structured output', { structured: undefined }, 'structured_result_missing'],
    ['invalid structured output', { structured: { summary: 'missing fields' } }, 'structured_result_invalid'],
    ['max tokens', { stopReason: 'max-tokens' as const }, 'max_tokens'],
    ['refusal', { stopReason: 'refusal' as const }, 'refusal'],
    ['child error', { stopReason: 'error' as const }, 'child_error'],
    ['rejected child result', { rejectResult: 'result transport failed' }, 'child_error'],
    ['cleanup failure', { structured: achieved('ok'), rejectDispose: 'dispose failed' }, 'cleanup_failed'],
  ])('maps %s without turning it into success', async (_label, behavior, expectedKind) => {
    const mounted = await mountHost(new ScriptedProvider(() => behavior))
    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(1)))
    expect(value.tasks[0]).toMatchObject({ status: 'failed', failure: { kind: expectedKind } })
  })

  it('preserves the child failure when cleanup also fails', async () => {
    const provider = new ScriptedProvider(() => ({ stopReason: 'error', rejectDispose: 'dispose also failed' }))
    const mounted = await mountHost(provider)
    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(1)))
    expect(value.tasks[0]).toMatchObject({ status: 'failed', failure: { kind: 'child_error' } })
  })

  it('rejects an oversized TaskReport without truncating it into success', async () => {
    const provider = new ScriptedProvider(() => ({ structured: achieved('x'.repeat(500)) }))
    const mounted = await mountHost(provider, { maxTaskReportChars: 120 })
    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(1)))
    expect(value.tasks[0]).toMatchObject({
      status: 'failed',
      failure: { kind: 'structured_result_too_large' },
    })
  })

  it('times out only the slow attempt and still collects its sibling', async () => {
    const provider = new ScriptedProvider(request => request.label === 'Task 1'
      ? { delayMs: 100, structured: achieved('slow') }
      : { structured: achieved('fast') })
    const mounted = await mountHost(provider, { maxConcurrency: 2, attemptTimeoutMs: 10 })
    const value = valueOf(await executeSwarm(mounted.ctx, rootArgs(2)))
    expect(value.tasks[0]).toMatchObject({ status: 'failed', failure: { kind: 'timeout' } })
    expect(value.tasks[1]).toMatchObject({ status: 'completed' })
    expect(provider.active).toBe(0)
  })

  it('maps the Swarm deadline to isError after every admitted child is quiescent', async () => {
    const provider = new ScriptedProvider(() => ({ delayMs: 200, structured: achieved('late') }))
    const mounted = await mountHost(provider, {
      maxConcurrency: 2,
      swarmTimeoutMs: 10,
      attemptTimeoutMs: 500,
    })
    const agent = fakeAgent('root-deadline')
    const result = await executeSwarm(mounted.ctx, rootArgs(3), { agent })

    expect(result.isError).toBe(true)
    expect(provider.active).toBe(0)
    expect(provider.disposed).toBe(provider.requests.length)
    const runEnd = agent.session.events.findLast(event => event.type === 'tool-agent-swarm/run-end')
    expect(runEnd?.data).toMatchObject({ status: 'timed_out', timedOut: 3 })
  })

  it('caller cancellation preserves completed work and waits for every child disposer', async () => {
    const provider = new ScriptedProvider(request => request.label === 'Task 1'
      ? { structured: achieved('fast') }
      : { delayMs: 200, structured: achieved('slow') })
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const controller = new AbortController()
    const agent = fakeAgent('root-cancel')
    const pending = executeSwarm(mounted.ctx, rootArgs(4), { signal: controller.signal, agent })
    await until(() => provider.requests.length >= 2)
    controller.abort('test cancellation')
    const result = await pending

    expect(result.isError).toBe(true)
    expect(provider.active).toBe(0)
    expect(provider.disposed).toBe(provider.requests.length)
    expect(agent.session.events.at(-1)?.type).toBe('tool-agent-swarm/run-end')
    const terminalTransitions = agent.session.events.filter(event =>
      event.type === 'tool-agent-swarm/task-transition'
      && ['completed', 'failed', 'cancelled', 'timed_out'].includes((event.data as { to?: string }).to ?? ''))
    expect(terminalTransitions).toHaveLength(4)
  })

  it('plugin disposal cancels live work, reaches quiescence, and removes the tool', async () => {
    const provider = new ScriptedProvider(() => ({ delayMs: 200, structured: achieved('late') }))
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const pending = executeSwarm(mounted.ctx, rootArgs(4))
    await until(() => provider.requests.length >= 2)
    await mounted.hostFiber.dispose()
    const result = await pending

    expect(result.isError).toBe(true)
    expect(provider.active).toBe(0)
    expect(mounted.ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(false)
  })

  it('provider removal unmounts new admission while an admitted collect-all run settles queued launch failures', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const provider = new ScriptedProvider(() => ({ resultGate: gate, structured: achieved('done') }))
    const mounted = await mountHost(provider, { maxConcurrency: 2 })
    const pending = executeSwarm(mounted.ctx, rootArgs(4))
    await until(() => provider.requests.length === 2)
    await mounted.providerFiber.dispose()
    release()
    const value = valueOf(await pending)

    expect(value.summary).toMatchObject({ completed: 2, failed: 2 })
    expect(value.tasks.slice(2).every(task => task.failure?.kind === 'launch_failed')).toBe(true)
    expect(mounted.ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(false)
  })

  it('waits for its provider, unmounts on removal, and mounts again when the provider returns', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(host, { provider: 'mock' })
    expect(ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(false)

    const first = ctx.plugin({
      name: 'first-provider',
      inject: ['subagents'],
      apply(providerCtx: Context): void {
        providerCtx.subagents.registerProvider(new ScriptedProvider())
      },
    })
    await first
    expect(ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(true)
    await first.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(false)

    await ctx.plugin({
      name: 'second-provider',
      inject: ['subagents'],
      apply(providerCtx: Context): void {
        providerCtx.subagents.registerProvider(new ScriptedProvider())
      },
    })
    expect(ctx.tools.schemas().some(schema => schema.name === 'agent_swarm')).toBe(true)
  })

  it('rejects a provider that cannot enforce structured output and depth limits', async () => {
    const provider = new ScriptedProvider()
    Object.defineProperty(provider, 'capabilities', {
      value: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    })
    await expect(mountHost(provider)).rejects.toThrow(/must support outputSchema and depthLimit/)
  })
})
