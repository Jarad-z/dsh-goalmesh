export interface DependencyAuditTask<T extends string = string> {
  readonly id: T
  readonly phase: 'waiting' | 'ready' | 'starting' | 'running' | 'terminal'
}

/** Return waiting tasks only for the scheduler's otherwise-unresolvable state. */
export function dependencyDeadlockCandidates<T extends string>(
  tasks: Iterable<DependencyAuditTask<T>>,
  readyCount: number,
  activeCount: number,
): readonly T[] {
  const snapshot = [...tasks]
  if (readyCount > 0 || activeCount > 0 || snapshot.every(task => task.phase === 'terminal')) return []
  return snapshot.filter(task => task.phase === 'waiting').map(task => task.id)
}
