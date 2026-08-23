import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { describe, expect, it } from 'vitest'
import * as host from '../packages/tool-goalmesh/src/index.js'
import { applyTrajectoryEvent } from '../packages/tool-goalmesh/src/invariant.js'
import type { GoalMeshToolValue } from '../packages/tool-goalmesh/src/types.js'
import { executeSwarm, rootArgs } from './host-fixture.js'

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

const taskReport = (summary: string) => ({
  reported_status: 'achieved',
  summary,
  evidence: [{ claim: `${summary} evidence` }],
})

describe('GoalMesh v0.3 real nested composition', () => {
  it('runs a nested swarm through the real AgentLoop and in-process provider without deadlock', async () => {
    const ctx = new Context()
    try {
      const adapter = new ScriptedAdapter([
        toolCallResponse('parent-delegates', 'goal_mesh', {
          tasks: [{
            key: 'nested-1',
            description: 'Nested real task',
            objective: 'Complete the nested real task',
            acceptance_criteria: ['Nested evidence exists'],
          }],
        }),
        toolCallResponse('nested-reports', STRUCTURED_OUTPUT_TOOL, taskReport('nested complete')),
        toolCallResponse('parent-reports', STRUCTURED_OUTPUT_TOOL, taskReport('parent complete')),
      ])
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(Spawn, { providerName: 'spawn' })
      await ctx.plugin(host, {
        provider: 'spawn',
        nestedMode: 'local-only',
        maxConcurrency: 1,
        maxTasks: 4,
        maxDepth: 3,
      })
      ctx.llm.registerAdapter(['mock'], adapter)
      const root = ctx.agentLoop.create(SessionId('real-nested-root'), { provider: 'mock', model: 'mock' })
      const globalTool = ctx.tools.get('goal_mesh', root)
      const children: Agent[] = []
      const scopedTools: unknown[] = []
      ctx.on('agent/created', ({ agent }) => {
        if (agent === root) return
        children.push(agent)
        scopedTools.push(ctx.tools.get('goal_mesh', agent))
      })

      const result = await executeSwarm(ctx, rootArgs(1), { agent: root })
      expect(result.isError).toBe(false)
      const value = result.value as unknown as GoalMeshToolValue
      expect(value).toMatchObject({
        kind: 'root',
        summary: { completed: 1, failed: 0, descendants: 1 },
      })
      expect(adapter.requests).toHaveLength(3)

      const firstRequestTool = adapter.requests[0]!.tools?.find(tool => tool.name === 'goal_mesh')
      const nestedProperties = firstRequestTool?.parameters.properties as Record<string, unknown>
      expect(Object.keys(nestedProperties)).toEqual(['tasks', 'failure_mode', 'quorum'])
      expect(nestedProperties).not.toHaveProperty('goal')
      expect(children).toHaveLength(2)
      expect(scopedTools[0]).toBeDefined()
      expect(scopedTools[0]).not.toBe(globalTool)
      expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
      expect(ctx.tools.get('goal_mesh', children[0]!)).not.toBe(scopedTools[0])

      const events = root.session.events.filter(event => event.type.startsWith('tool-goalmesh/'))
      const created = events
        .filter(event => event.type === 'tool-goalmesh/task-created')
        .map(event => event.data as Record<string, unknown>)
      expect(created).toHaveLength(2)
      expect(created[0]).toMatchObject({ key: 'task-1', depth: 1 })
      expect(created[1]).toMatchObject({ key: 'nested-1', depth: 2, parentTaskId: created[0]!.taskId })

      const trace = new Map() as Parameters<typeof applyTrajectoryEvent>[0]
      for (const event of events) {
        applyTrajectoryEvent(trace, event, (message) => { throw new Error(message) })
      }
      expect(events.map(event => event.type.replace('tool-goalmesh/', ''))).toMatchInlineSnapshot(`
        [
          "run-start",
          "invocation-start",
          "task-created",
          "task-transition",
          "attempt-start",
          "task-transition",
          "task-transition",
          "invocation-start",
          "task-created",
          "task-transition",
          "attempt-start",
          "task-transition",
          "attempt-end",
          "task-transition",
          "task-transition",
          "task-transition",
          "invocation-end",
          "attempt-end",
          "task-transition",
          "invocation-end",
          "run-end",
        ]
      `)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
