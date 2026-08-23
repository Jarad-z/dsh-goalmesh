import { useMemo, useState, type CSSProperties } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { shallowEqual, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { GoalMeshLocaleKey } from './locales.js'
import type {
  SwarmAttemptData,
  SwarmProjectedTaskStatus,
  SwarmTaskNodeData,
  SwarmTrajectoryChatData,
  SwarmTrajectoryStatus,
} from './trajectory-definition.js'

export interface GoalMeshInjected {
  readonly openAgent: (attempt: SwarmAttemptData) => Promise<boolean>
}

export type SwarmTrajectoryPanelProps =
  PropsRuntime<'conversation.chat.node', 'goalmesh-trajectory'>
  & PropsLocale<'goalMesh'>
  & GoalMeshInjected

type DisplayStatus = SwarmTrajectoryStatus | SwarmProjectedTaskStatus
type NavigationKind = 'none' | 'remote' | 'listed' | 'catalog' | 'forbidden'

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  partial: 'status.partial',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  timed_out: 'status.timed_out',
  interrupted: 'status.interrupted',
  waiting: 'status.waiting',
  ready: 'status.ready',
  starting: 'status.starting',
  waiting_children: 'status.waiting_children',
  ready_to_resume: 'status.ready_to_resume',
  skipped: 'status.skipped',
} as const satisfies Record<DisplayStatus, GoalMeshLocaleKey>

function dotState(status: DisplayStatus): StateDotState {
  switch (status) {
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'running':
    case 'starting':
    case 'ready_to_resume': return 'ongoing'
    case 'partial':
    case 'cancelled':
    case 'timed_out':
    case 'interrupted':
    case 'waiting':
    case 'ready':
    case 'waiting_children':
    case 'skipped': return 'warning'
    default: return status satisfies never
  }
}

export function flattenTasks(data: SwarmTrajectoryChatData): readonly SwarmTaskNodeData[] {
  const result: SwarmTaskNodeData[] = []
  const stack = [...data.unlinked, ...data.roots].reverse()
  while (stack.length > 0) {
    const task = stack.pop()
    if (task === undefined) continue
    result.push(task)
    for (let index = task.children.length - 1; index >= 0; index--) {
      const child = task.children[index]
      if (child !== undefined) stack.push(child)
    }
  }
  return result
}

export function navigationKind(sessions: SessionListState, attempt: SwarmAttemptData | undefined): NavigationKind {
  if (attempt === undefined) return 'none'
  if (!attempt.local) return 'remote'
  if (!sessions.ids.includes(attempt.childId)) return 'catalog'
  const summary = sessions.byId[attempt.childId]
  return summary?.origin === 'subagent' && summary.parentId === attempt.parentSessionId
    ? 'listed'
    : 'forbidden'
}

function durationLabel(milliseconds: number, t: SwarmTrajectoryPanelProps['t']): string {
  if (milliseconds < 1_000) return t('time.ms', { value: milliseconds })
  return t('time.seconds', { value: (milliseconds / 1_000).toFixed(1) })
}

function TreeTask({ level, onSelect, selectedId, task, t }: {
  readonly level: number
  readonly onSelect: (taskId: string) => void
  readonly selectedId: string | undefined
  readonly task: SwarmTaskNodeData
  readonly t: SwarmTrajectoryPanelProps['t']
}) {
  const [open, setOpen] = useState(false)
  const name = task.label || task.key
  return (
    <>
      <div
        className="dsh-swarm__tree-row"
        style={{ '--dsh-swarm-level': level } as CSSProperties}
        data-task-id={task.taskId}
      >
        {task.children.length > 0 ? (
          <button
            type="button"
            className="dsh-swarm__branch"
            aria-expanded={open}
            aria-label={t(open ? 'task.collapse' : 'task.expand', { name })}
            onClick={() => { setOpen(value => !value) }}
          >
            {open ? '−' : '+'}
          </button>
        ) : <span className="dsh-swarm__branch-spacer" aria-hidden />}
        <button
          type="button"
          className="dsh-swarm__task"
          aria-current={selectedId === task.taskId}
          aria-label={t('task.select', { name })}
          onClick={() => { onSelect(task.taskId) }}
        >
          <StateDot state={dotState(task.status)} />
          <span className="dsh-swarm__task-label">{name}</span>
          <span className="dsh-swarm__task-status">{t(STATUS_KEYS[task.status])}</span>
        </button>
      </div>
      {open && task.children.map(child => (
        <TreeTask
          key={`${task.taskId}:${child.taskId}`}
          level={level + 1}
          onSelect={onSelect}
          selectedId={selectedId}
          task={child}
          t={t}
        />
      ))}
    </>
  )
}

function AttemptDetails({ attempt, t }: {
  readonly attempt: SwarmAttemptData
  readonly t: SwarmTrajectoryPanelProps['t']
}) {
  const duration = attempt.endedAt === undefined
    ? t('attempt.running')
    : durationLabel(Math.max(0, attempt.endedAt - attempt.startedAt), t)
  return (
    <div className="dsh-swarm__attempt" data-attempt-id={attempt.attemptId}>
      <strong>{t('attempt.title', { number: attempt.attemptNo })}</strong>
      <dl className="dsh-swarm__meta">
        <dt>{t('attempt.child')}</dt><dd>{attempt.childId}</dd>
        <dt>{t('attempt.parent')}</dt><dd>{attempt.parentSessionId}</dd>
        <dt>{t('attempt.provider')}</dt><dd>{attempt.provider}</dd>
        {attempt.requestedModel === undefined ? null : <><dt>{t('attempt.model')}</dt><dd>{attempt.requestedModel}</dd></>}
        <dt>{t('attempt.duration')}</dt><dd>{duration}</dd>
        {attempt.outcome === undefined ? null : <><dt>{t('attempt.outcome')}</dt><dd>{t(STATUS_KEYS[attempt.outcome])}</dd></>}
        {attempt.failureKind === undefined ? null : <><dt>{t('task.diagnostics')}</dt><dd>{attempt.failureKind}</dd></>}
      </dl>
    </div>
  )
}

function TaskDetails({ navigation, onOpen, opening, task, t }: {
  readonly navigation: NavigationKind
  readonly onOpen: () => void
  readonly opening: boolean
  readonly task: SwarmTaskNodeData
  readonly t: SwarmTrajectoryPanelProps['t']
}) {
  const latestAttempt = task.attempts.at(-1)
  const firstAttempt = task.attempts[0]
  const queueDuration = firstAttempt === undefined
    ? undefined
    : durationLabel(Math.max(0, firstAttempt.startedAt - task.createdAt), t)
  const runDuration = latestAttempt?.endedAt === undefined
    ? undefined
    : durationLabel(Math.max(0, latestAttempt.endedAt - latestAttempt.startedAt), t)
  const disabled = latestAttempt === undefined || navigation === 'remote'
    || navigation === 'forbidden' || opening
  const unavailable = navigation === 'remote'
    ? t('task.remote')
    : navigation === 'forbidden' ? t('task.unavailable') : undefined
  return (
    <article className="dsh-swarm__details" data-selected-task={task.taskId}>
      <h3>{task.label || task.key}</h3>
      <dl className="dsh-swarm__meta">
        <dt>{t('task.status')}</dt><dd>{t(STATUS_KEYS[task.status])}</dd>
        <dt>{t('task.invocation')}</dt><dd>{task.invocationId}</dd>
        <dt>{t('task.depth')}</dt><dd>{task.depth}</dd>
        {queueDuration === undefined ? null : <><dt>{t('task.queueDuration')}</dt><dd>{queueDuration}</dd></>}
        {runDuration === undefined ? null : <><dt>{t('task.runDuration')}</dt><dd>{runDuration}</dd></>}
      </dl>
      <h4>{t('task.objective')}</h4>
      <div>{task.objectiveSummary}</div>
      <h4>{t('task.acceptance')}</h4>
      <ul className="dsh-swarm__list">
        {task.acceptanceCriteriaSummary.map((criterion, index) => <li key={index}>{criterion}</li>)}
      </ul>
      <h4>{t('task.dependencies')}</h4>
      {task.dependencies.length === 0
        ? <div>{t('task.noDependencies')}</div>
        : <ul className="dsh-swarm__list">{task.dependencies.map(id => <li key={id}>{id}</li>)}</ul>}
      <h4>{t('task.dependents')}</h4>
      {task.dependents.length === 0
        ? <div>{t('task.noDependencies')}</div>
        : <ul className="dsh-swarm__list">{task.dependents.map(id => <li key={id}>{id}</li>)}</ul>}
      {task.diagnostics.length === 0 ? null : (
        <>
          <h4>{t('task.diagnostics')}</h4>
          <ul className="dsh-swarm__list">
            {task.diagnostics.map(value => <li key={value}>{t(`diagnostic.${value}`)}</li>)}
          </ul>
        </>
      )}
      <h4>{t('task.attempts')}</h4>
      {task.attempts.length === 0
        ? <div>{t('task.noAttempts')}</div>
        : task.attempts.map(attempt => <AttemptDetails key={attempt.attemptId} attempt={attempt} t={t} />)}
      <h4>{t('task.timeline')}</h4>
      <ol className="dsh-swarm__timeline">
        {task.timeline.map(entry => (
          <li key={entry.seq}><time>{new Date(entry.time).toLocaleTimeString()}</time>{entry.summary}</li>
        ))}
      </ol>
      <button type="button" className="dsh-swarm__open" disabled={disabled} onClick={onOpen}>
        {opening ? t('task.opening') : t('task.open')}
      </button>
      {unavailable === undefined ? null : <div className="dsh-swarm__empty">{unavailable}</div>}
    </article>
  )
}

/** Render a durable Swarm root with a bounded tree and selected-task details. */
export function SwarmTrajectoryPanel({ node, openAgent, t, useSessions }: SwarmTrajectoryPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [opening, setOpening] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const tasks = useMemo(() => flattenTasks(node.data), [node.data])
  const selected = tasks.find(task => task.taskId === selectedId) ?? tasks[0]
  const latestAttempt = selected?.attempts.at(-1)
  const navigation = useSessions(sessions => navigationKind(sessions, latestAttempt), shallowEqual)
  const handleOpen = (): void => {
    if (latestAttempt === undefined || opening) return
    setOpening(true)
    setOpenFailed(false)
    void openAgent(latestAttempt).then((opened) => {
      setOpening(false)
      setOpenFailed(!opened)
    }, () => {
      setOpening(false)
      setOpenFailed(true)
    })
  }
  return (
    <section className="dsh-swarm" data-goalmesh-trajectory data-run-status={node.data.status}>
      <button
        type="button"
        className="dsh-swarm__header"
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <StateDot state={dotState(node.data.status)} />
        <span className="dsh-swarm__title">{t('run.title')}: {node.data.goalSummary}</span>
        <span className="dsh-swarm__progress">{t('run.progress', { settled: node.data.settled, total: node.data.total })}</span>
        <span className="dsh-swarm__status">{t(STATUS_KEYS[node.data.status])}</span>
      </button>
      {node.data.incomplete ? <div className="dsh-swarm__warning">{t('run.incomplete')}</div> : null}
      {expanded ? (
        <div className="dsh-swarm__body">
          <div className="dsh-swarm__tree">
            {node.data.roots.map(task => (
              <TreeTask key={task.taskId} level={0} onSelect={setSelectedId} selectedId={selected?.taskId} task={task} t={t} />
            ))}
            {node.data.unlinked.length === 0 ? null : (
              <>
                <div className="dsh-swarm__group">{t('run.unlinked')}</div>
                {node.data.unlinked.map(task => (
                  <TreeTask key={`unlinked:${task.taskId}`} level={0} onSelect={setSelectedId} selectedId={selected?.taskId} task={task} t={t} />
                ))}
              </>
            )}
            {tasks.length === 0 ? <div className="dsh-swarm__empty">{t('run.empty')}</div> : null}
          </div>
          {selected === undefined
            ? <div className="dsh-swarm__empty">{t('task.none')}</div>
            : <TaskDetails navigation={navigation} onOpen={handleOpen} opening={opening} task={selected} t={t} />}
          {openFailed ? <div className="dsh-swarm__empty">{t('task.unavailable')}</div> : null}
        </div>
      ) : null}
    </section>
  )
}
