import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as host from '../packages/tool-goalmesh/src/index.js'
import type { GoalMeshRootArgsV02, TaskReport } from '../packages/tool-goalmesh/src/types.js'

export interface Behavior {
  readonly delayMs?: number
  readonly stopReason?: SubagentResult['stopReason']
  readonly structured?: unknown
  readonly rejectStart?: string
  readonly rejectResult?: string
  readonly rejectDispose?: string
  readonly resultGate?: Promise<void>
}

export function achieved(summary: string): TaskReport {
  return {
    reported_status: 'achieved',
    summary,
    evidence: [{ claim: `${summary} evidence` }],
  }
}

export class ScriptedProvider implements SubagentProvider {
  readonly name = 'mock'
  readonly inheritsParentContext = false
  readonly capabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
    scopedSetup: false,
  }
  readonly requests: SubagentStartRequest[] = []
  active = 0
  maxActive = 0
  disposed = 0
  private nextId = 0

  constructor(private readonly behavior: (request: SubagentStartRequest) => Behavior = request => ({
    structured: achieved(request.label ?? 'task'),
  })) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    const behavior = this.behavior(request)
    if (behavior.rejectStart !== undefined) throw new Error(behavior.rejectStart)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    const id = SessionId(`mock-child-${++this.nextId}`)
    let finishResult!: (result: SubagentResult) => void
    let rejectResult!: (reason: unknown) => void
    let finished = false
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = new Promise<SubagentResult>((resolve, reject) => {
      finishResult = resolve
      rejectResult = reject
    })
    const settle = (value: SubagentResult): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      finishResult(value)
    }
    const fail = (error: Error): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      rejectResult(error)
    }
    const onAbort = (): void => {
      settle({ output: [], stopReason: 'aborted' })
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    const complete = async (): Promise<void> => {
      await behavior.resultGate
      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise<void>(resolve => { timer = setTimeout(resolve, behavior.delayMs) })
      }
      if (request.signal.aborted) return onAbort()
      if (behavior.rejectResult !== undefined) return fail(new Error(behavior.rejectResult))
      const structured = Object.hasOwn(behavior, 'structured')
        ? behavior.structured
        : achieved(request.label ?? 'task')
      settle({
        output: [{ type: 'text', text: request.label ?? 'task' }],
        ...structured === undefined ? {} : { structured },
        stopReason: behavior.stopReason ?? 'completed',
      })
    }
    void complete()

    return {
      id,
      localAgent: undefined,
      result,
      dispose: async (): Promise<void> => {
        if (disposed) return
        disposed = true
        settle({ output: [], stopReason: 'aborted' })
        this.active--
        this.disposed++
        if (behavior.rejectDispose !== undefined) throw new Error(behavior.rejectDispose)
      },
    }
  }
}

class NoopCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

export function fakeAgent(id = 'root'): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
  } as unknown as Agent
}

export function rootArgs(count: number): GoalMeshRootArgsV02 {
  return {
    goal: {
      statement: 'Complete the batch',
      success_criteria: ['Every independent task has evidence'],
      constraints: ['Do not claim global success'],
    },
    tasks: Array.from({ length: count }, (_, index) => ({
      key: `task-${index + 1}`,
      description: `Task ${index + 1}`,
      objective: `Complete task ${index + 1}`,
      acceptance_criteria: [`Task ${index + 1} has evidence`],
      expected_outputs: [`Report ${index + 1}`],
    })),
  }
}

let callId = 0

export async function mountHost(
  provider = new ScriptedProvider(),
  config: Omit<host.Config, 'provider'> = {},
  options: { readonly toolMode?: 'native' | 'code' } = {},
): Promise<{
  readonly ctx: Context
  readonly provider: ScriptedProvider
  readonly providerFiber: ReturnType<Context['plugin']>
  readonly hostFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: options.toolMode ?? 'native' })
  if (options.toolMode === 'code') await ctx.plugin(NoopCodeRuntime)
  await ctx.plugin(SubagentRuntime)
  const providerFiber = ctx.plugin({
    name: 'scripted-provider',
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      pluginCtx.subagents.registerProvider(provider)
    },
  })
  await providerFiber
  const hostFiber = ctx.plugin(host, { provider: provider.name, ...config })
  await hostFiber
  return { ctx, provider, providerFiber, hostFiber }
}

export function executeSwarm(
  ctx: Context,
  args: unknown,
  options: { readonly signal?: AbortSignal; readonly agent?: Agent } = {},
) {
  return ctx.tools.execute({
    callId: CallId(`swarm-call-${++callId}`),
    name: 'goal_mesh',
    arguments: args,
    signal: options.signal ?? new AbortController().signal,
    agent: options.agent ?? fakeAgent(`root-${callId}`),
  })
}

export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadlineAt) throw new Error('condition did not become true before timeout')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}
