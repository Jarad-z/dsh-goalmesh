// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationEventRegistry,
  ConversationNodeAssembler,
  SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode,
  ConversationEventInput,
  ConversationNodeDefinition,
  ConversationViewDefinition,
  SessionId,
  SessionListState,
  SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentSwarmInjected, SwarmTrajectoryPanelProps } from '../packages/client-ui-agent-swarm/src/client/index.js'
import { apply, inject } from '../packages/client-ui-agent-swarm/src/client/index.js'
import { zh } from '../packages/client-ui-agent-swarm/src/client/locales.js'
import {
  SwarmTrajectoryPanel,
  navigationKind,
} from '../packages/client-ui-agent-swarm/src/client/SwarmTrajectoryPanel.js'
import {
  MAX_PROJECTED_TREE_DEPTH,
  isSwarmUpdateEvent,
  swarmTrajectoryDefinition,
} from '../packages/client-ui-agent-swarm/src/client/trajectory-definition.js'
import type {
  SwarmAttemptData,
  SwarmTrajectoryChatData,
} from '../packages/client-ui-agent-swarm/src/client/trajectory-definition.js'

interface ClientHandoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

type ClientWindow = Window & { __ModuleLoader__?: { load(handoff: ClientHandoff): void } }

afterEach(() => {
  cleanup()
  delete (window as ClientWindow).__ModuleLoader__
})

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [swarmTrajectoryDefinition] }
  fallbackEntry(): undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): ChatSnapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return snapshot()
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return snapshot()
      },
    }
  },
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return {
    event: { seq, time: 1_000 + seq * 10, type, data, ignorable: true } as ConversationEventInput['event'],
    view: undefined,
  }
}

function assembler(entries: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function trajectoryData(value: ConversationNodeAssembler): SwarmTrajectoryChatData | undefined {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()][0]?.data as SwarmTrajectoryChatData | undefined
}

function taskCreated(seq: number, taskId: string, parentTaskId?: string): ConversationEventInput {
  return at(seq, 'tool-agent-swarm/task-created', {
    swarmId: 'swarm-1',
    invocationId: 'invocation-1',
    taskId,
    key: taskId,
    label: `Task ${taskId}`,
    objectiveSummary: `Complete ${taskId}`,
    acceptanceCriteriaSummary: [`${taskId} accepted`],
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    dependencies: [],
    depth: 1,
  })
}

function completeEvents(): ConversationEventInput[] {
  return [
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'tool-agent-swarm/run-start', {
      swarmId: 'swarm-1', rootSessionId: 'root', goalSummary: 'Audit the repository',
    }),
    at(4, 'tool-agent-swarm/invocation-start', {
      swarmId: 'swarm-1', invocationId: 'invocation-1', callerSessionId: 'root',
    }),
    taskCreated(5, 'task-a'),
    taskCreated(6, 'task-b'),
    at(7, 'tool-agent-swarm/task-transition', {
      swarmId: 'swarm-1', taskId: 'task-a', from: 'ready', to: 'starting',
    }),
    at(8, 'tool-agent-swarm/attempt-start', {
      swarmId: 'swarm-1', taskId: 'task-a', attemptId: 'attempt-a', attemptNo: 1,
      childId: 'child-a', parentSessionId: 'root', provider: 'spawn', local: true,
    }),
    at(9, 'tool-agent-swarm/task-transition', {
      swarmId: 'swarm-1', taskId: 'task-a', from: 'starting', to: 'running',
    }),
    at(10, 'tool-agent-swarm/attempt-end', {
      swarmId: 'swarm-1', taskId: 'task-a', attemptId: 'attempt-a', outcome: 'completed',
    }),
    at(11, 'tool-agent-swarm/task-transition', {
      swarmId: 'swarm-1', taskId: 'task-a', from: 'running', to: 'completed',
    }),
    at(12, 'tool-agent-swarm/task-transition', {
      swarmId: 'swarm-1', taskId: 'task-b', from: 'ready', to: 'starting',
    }),
    at(13, 'tool-agent-swarm/task-transition', {
      swarmId: 'swarm-1', taskId: 'task-b', from: 'starting', to: 'failed', reason: 'launch_failed',
    }),
    at(14, 'tool-agent-swarm/invocation-end', {
      swarmId: 'swarm-1', invocationId: 'invocation-1', status: 'partial',
    }),
    at(15, 'tool-agent-swarm/run-end', {
      swarmId: 'swarm-1', status: 'partial', completed: 1, failed: 1,
      skipped: 0, cancelled: 0, timedOut: 0,
    }),
    at(16, 'step/end', { turn: 1, step: 1 }),
    at(17, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('Agent Swarm Conversation Definition', () => {
  it('produces identical snapshots through full replay, live append, and history prepend', () => {
    const events = completeEvents()
    const replay = trajectoryData(assembler(events))
    const live = assembler(events.slice(0, 5))
    for (const event of events.slice(5)) live.append(event)
    live.flush()
    const tail = assembler(events.slice(5), true)
    expect(trajectoryData(tail)).toBeUndefined()
    tail.prepend(events.slice(0, 5), false)
    tail.flush()

    expect(trajectoryData(live)).toEqual(replay)
    expect(trajectoryData(tail)).toEqual(replay)
    expect(replay).toMatchObject({ status: 'partial', settled: 2, total: 2, incomplete: false })
    expect(replay?.roots.map(task => task.taskId)).toEqual(['task-a', 'task-b'])
    expect(replay?.roots[0]?.attempts[0]).toMatchObject({ childId: 'child-a', outcome: 'completed' })
  })

  it('uses a closed update guard and ignores future same-prefix events', () => {
    expect(isSwarmUpdateEvent(completeEvents()[3]!.event)).toBe(true)
    expect(isSwarmUpdateEvent(at(99, 'tool-agent-swarm/future', { swarmId: 'swarm-1' }).event)).toBe(false)
    expect(swarmTrajectoryDefinition.match(at(99, 'tool-agent-swarm/future', { swarmId: 'swarm-1' }).event))
      .toBeNull()
  })

  it('marks an open legal prefix interrupted only after its owning step closes', () => {
    const open = completeEvents().slice(0, 10)
    const value = assembler(open)
    expect(trajectoryData(value)?.status).toBe('running')
    value.append(at(20, 'step/end', { turn: 1, step: 1 }))
    value.flush()
    expect(trajectoryData(value)).toMatchObject({
      status: 'interrupted',
      incomplete: true,
      roots: [{ status: 'interrupted' }, { status: 'interrupted' }],
    })
  })

  it('bounds nested trees and diagnoses orphan and cyclic parentage without dropping the run', () => {
    const events = completeEvents().slice(0, 4)
    events.push(taskCreated(20, 'root-task'))
    events.push(taskCreated(21, 'child-task', 'root-task'))
    events.push(taskCreated(22, 'grandchild-task', 'child-task'))
    events.push(taskCreated(23, 'orphan-task', 'missing-parent'))
    events.push(taskCreated(24, 'cycle-a', 'cycle-b'))
    events.push(taskCreated(25, 'cycle-b', 'cycle-a'))
    let parent = 'root-task'
    for (let depth = 0; depth < MAX_PROJECTED_TREE_DEPTH + 3; depth++) {
      const id = `deep-${depth}`
      events.push(taskCreated(30 + depth, id, parent))
      parent = id
    }
    const data = trajectoryData(assembler(events))
    expect(data?.roots[0]?.children[0]?.children[0]?.taskId).toBe('grandchild-task')
    expect(data?.unlinked.some(task => task.diagnostics.includes('orphan'))).toBe(true)
    expect(data?.unlinked.some(task => task.diagnostics.includes('cycle'))).toBe(true)
    expect(data?.warnings.some(value => value.includes('depth capped'))).toBe(true)
  })

  it('projects 64 stable root nodes without graph-library state', () => {
    const events = completeEvents().slice(0, 4)
    for (let index = 0; index < 64; index++) events.push(taskCreated(10 + index, `task-${index}`))
    const data = trajectoryData(assembler(events))
    expect(data?.roots).toHaveLength(64)
    expect(data?.roots.map(task => task.taskId)).toEqual(
      Array.from({ length: 64 }, (_, index) => `task-${index}`),
    )
  })
})

const ROOT = 'root' as SessionId
const CHILD = 'child-a' as SessionId

function listState(overrides: Partial<SessionListState> = {}): SessionListState {
  return {
    ids: [ROOT, CHILD],
    byId: {
      [ROOT]: { id: ROOT, displayTitle: 'root', running: true, blank: false, updatedAt: 0 },
      [CHILD]: {
        id: CHILD, displayTitle: 'child', running: true, blank: false, updatedAt: 0,
        origin: 'subagent', parentId: ROOT,
      },
    },
    current: ROOT,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
    ...overrides,
  }
}

function translate(key: keyof typeof zh, values: Record<string, unknown> = {}): string {
  let rendered: string = zh[key]
  for (const [name, value] of Object.entries(values)) rendered = rendered.replaceAll(`{${name}}`, String(value))
  return rendered
}

function panelProps(
  data: SwarmTrajectoryChatData,
  sessions = listState(),
  openAgent = vi.fn(() => Promise.resolve(true)),
): SwarmTrajectoryPanelProps {
  return {
    node: {
      key: 'agent-swarm-trajectory:swarm-1', kind: 'agent-swarm-trajectory', id: 'swarm-1',
      target: 'chat', anchorSeq: 3, location: { kind: 'unresolved' }, visibility: 'visible', data,
    },
    sessionId: ROOT,
    useSessions: selector => selector(sessions),
    useSession: (() => undefined) as SwarmTrajectoryPanelProps['useSession'],
    useProjection: () => undefined,
    useInput: () => { throw new Error('unused') },
    inputActions: { setDraft: () => {}, submit: () => {} } as never,
    useWorkspaces: (() => undefined) as SwarmTrajectoryPanelProps['useWorkspaces'],
    useTurnData: () => undefined,
    selectedCallId: undefined,
    cwd: undefined,
    openFile: () => {},
    inspectCall: () => {},
    forkAt: () => {},
    loadImage: () => Promise.reject(new Error('unused')),
    fileMentions: () => undefined,
    openAgent,
    t: translate as SwarmTrajectoryPanelProps['t'],
  }
}

describe('SwarmTrajectoryPanel', () => {
  it('keeps the panel and recursive branches collapsed until selected', () => {
    const events = completeEvents().slice(0, 4)
    events.push(taskCreated(20, 'parent'))
    events.push(taskCreated(21, 'child', 'parent'))
    const data = trajectoryData(assembler(events))
    if (data === undefined) throw new Error('expected trajectory data')
    render(<SwarmTrajectoryPanel {...panelProps(data)} />)
    const header = screen.getByRole('button', { name: /Agent Swarm: Audit the repository/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Task parent')).toBeNull()
    fireEvent.click(header)
    expect(screen.getAllByText('Task parent').length).toBeGreaterThan(0)
    expect(screen.queryByText('Task child')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开 Task parent 的子任务' }))
    fireEvent.click(screen.getByRole('button', { name: '查看任务 Task child' }))
    expect(screen.getAllByText('Complete child').length).toBeGreaterThan(0)
  })

  it('exposes trusted local navigation and disables remote attempts', async () => {
    const data = trajectoryData(assembler(completeEvents()))
    if (data === undefined) throw new Error('expected trajectory data')
    const openAgent = vi.fn(() => Promise.resolve(true))
    const view = render(<SwarmTrajectoryPanel {...panelProps(data, listState(), openAgent)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Swarm:/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开完整 Agent 会话' }))
    expect(openAgent).toHaveBeenCalledWith(expect.objectContaining({ childId: CHILD, parentSessionId: ROOT }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '打开完整 Agent 会话' })).toBeTruthy()
    })

    const remote: SwarmTrajectoryChatData = {
      ...data,
      roots: data.roots.map((task, index) => index === 0 ? {
        ...task,
        attempts: task.attempts.map(attempt => ({ ...attempt, local: false })),
      } : task),
    }
    view.rerender(<SwarmTrajectoryPanel {...panelProps(remote)} />)
    expect((screen.getByRole('button', { name: '打开完整 Agent 会话' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('远程 Provider 运行不支持打开本地会话')).toBeTruthy()
  })

  it('classifies ordinary-list lineage before offering navigation', () => {
    const attempt = trajectoryData(assembler(completeEvents()))?.roots[0]?.attempts[0]
    expect(navigationKind(listState(), attempt)).toBe('listed')
    expect(navigationKind(listState({ ids: [ROOT] }), attempt)).toBe('catalog')
    expect(navigationKind(listState({ byId: {
      ...listState().byId,
      [CHILD]: { ...listState().byId[CHILD]!, parentId: 'wrong' as SessionId },
    } }), attempt)).toBe('forbidden')
    expect(navigationKind(listState(), attempt === undefined ? undefined : { ...attempt, local: false })).toBe('remote')
  })
})

class TestSessions extends Service {
  snapshot = listState()
  address: SubagentAddress | undefined
  addressAfterRefresh: SubagentAddress | undefined
  readonly opened: SessionId[] = []
  readonly openedSubagents: SubagentAddress[] = []
  readonly refreshed: SessionId[] = []
  readonly list = {
    getSnapshot: (): SessionListState => this.snapshot,
    subscribe: (): (() => void) => () => {},
  }

  constructor(ctx: Context) { super(ctx, 'sessions') }
  open(id: SessionId): void { this.opened.push(id) }
  openSubagent(address: SubagentAddress): void { this.openedSubagents.push(address) }
  subagentAddress(): SubagentAddress | undefined { return this.address }
  async refreshSubagents(parent: SessionId): Promise<void> {
    this.refreshed.push(parent)
    this.address = this.addressAfterRefresh
  }
}

class TestLocale extends Service {
  registrations = 0
  constructor(ctx: Context) { super(ctx, 'locale') }
  register(): () => void {
    this.registrations++
    return () => { this.registrations-- }
  }
}

function attempt(local = true): SwarmAttemptData {
  return {
    attemptId: 'attempt-a', attemptNo: 1, childId: CHILD, parentSessionId: ROOT,
    provider: 'spawn', local, startSeq: 1, startedAt: 1,
  }
}

async function clientContext(plugin: { readonly inject: readonly string[]; readonly apply: (ctx: never) => void } = {
  inject,
  apply: apply as (ctx: never) => void,
}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => ({}) } as never)
  await ctx.plugin(ConversationEventRegistry)
  await ctx.plugin(TestSessions)
  await ctx.plugin(TestLocale)
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...plugin.inject], apply: plugin.apply })
  await fiber
  return { ctx, fiber, sessions: ctx.sessions as unknown as TestSessions, locale: ctx.locale as unknown as TestLocale }
}

describe('Agent Swarm client lifecycle and navigation', () => {
  it('registers and removes its Definition, renderer, locale, and style with the fiber', async () => {
    const mounted = await clientContext()
    expect(mounted.ctx.conversationEvents.entries().map(entry => entry.kind)).toEqual(['agent-swarm-trajectory'])
    expect(mounted.ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    expect(mounted.locale.registrations).toBe(1)
    expect(document.querySelector('style[data-plugin="dsh-client-ui-agent-swarm"]')).toBeTruthy()
    await mounted.fiber.dispose()
    expect(mounted.ctx.conversationEvents.entries()).toEqual([])
    expect(mounted.ctx.slots.entries('conversation.chat.node')).toEqual([])
    expect(mounted.locale.registrations).toBe(0)
    expect(document.querySelector('style[data-plugin="dsh-client-ui-agent-swarm"]')).toBeNull()
  })

  it('opens only listed or catalog-proven direct local children and refreshes at most once per action', async () => {
    const mounted = await clientContext()
    const entry = mounted.ctx.slots.entries('conversation.chat.node')[0]
    if (entry === undefined) throw new Error('missing Agent Swarm slot')
    const actions = entry.inject?.() as unknown as AgentSwarmInjected

    expect(await actions.openAgent(attempt())).toBe(true)
    expect(mounted.sessions.opened).toEqual([CHILD])
    expect(await actions.openAgent(attempt(false))).toBe(false)

    mounted.sessions.snapshot = listState({ ids: [ROOT] })
    mounted.sessions.address = { parentSessionId: ROOT, childSessionId: CHILD, mode: 'one-shot' }
    expect(await actions.openAgent(attempt())).toBe(true)
    expect(mounted.sessions.openedSubagents).toHaveLength(1)

    mounted.sessions.address = { parentSessionId: 'wrong' as SessionId, childSessionId: CHILD, mode: 'one-shot' }
    expect(await actions.openAgent(attempt())).toBe(false)
    expect(mounted.sessions.refreshed).toEqual([])

    mounted.sessions.address = undefined
    mounted.sessions.addressAfterRefresh = { parentSessionId: ROOT, childSessionId: CHILD, mode: 'one-shot' }
    expect(await actions.openAgent(attempt())).toBe(true)
    expect(mounted.sessions.refreshed).toEqual([ROOT])
    expect(mounted.sessions.openedSubagents).toHaveLength(2)
  })
})

describe('built Web composition', () => {
  it('executes the real ModuleLoader artifact and mounts it on the real client registries', async () => {
    const source = readFileSync(resolve('packages/client-ui-agent-swarm/lib/client.js'), 'utf8')
    let handoff: ClientHandoff | undefined
    ;(window as ClientWindow).__ModuleLoader__ = { load: value => { handoff = value } }
    // Deliberate execution of this repository's built browser fixture.
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
    new Function(source)()
    if (handoff === undefined) throw new Error('client artifact did not hand off to ModuleLoader')
    const modules = new Map<string, unknown>([
      ['react', await import('react')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
      ['@deepseek-ai/dsh-client-runtime/client', await import('@deepseek-ai/dsh-client-runtime/client')],
      ['@deepseek-ai/dsh-client-ui-primitives', await import('@deepseek-ai/dsh-client-ui-primitives')],
    ])
    const artifact = handoff.factory((specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected client require: ${specifier}`)
      return modules.get(specifier)
    })
    expect(handoff.id).toBe('dsh-client-ui-agent-swarm')
    expect(artifact.inject).toEqual(['conversationEvents', 'slots', 'sessions', 'locale'])
    const mounted = await clientContext(artifact as {
      readonly inject: readonly string[]
      readonly apply: (ctx: never) => void
    })
    expect(mounted.ctx.conversationEvents.entries().map(entry => entry.kind)).toEqual(['agent-swarm-trajectory'])
    expect(mounted.ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    await mounted.fiber.dispose()
    expect(mounted.ctx.conversationEvents.entries()).toEqual([])
  })
})
