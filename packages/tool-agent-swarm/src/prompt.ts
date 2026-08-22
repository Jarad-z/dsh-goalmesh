import type { SwarmGoal, TaskGoal } from './types.js'

export interface ResolvedDependencyPrompt {
  readonly key: string
  readonly status: 'completed' | 'failed' | 'skipped' | 'aborted'
  readonly reportedStatus?: 'achieved' | 'not_achieved' | 'blocked'
  readonly summary?: string
  readonly failureKind?: string
}

function bullets(values: readonly string[]): string {
  return values.length === 0 ? '- (none)' : values.map(value => `- ${value}`).join('\n')
}

function dependencyLines(dependencies: readonly ResolvedDependencyPrompt[]): string {
  if (dependencies.length === 0) return '- (none)'
  return dependencies.map((dependency) => {
    const details = dependency.status === 'completed'
      ? `reported_status=${dependency.reportedStatus ?? 'unknown'}; summary=${dependency.summary ?? '(none)'}`
      : `missing input; status=${dependency.status}; failure=${dependency.failureKind ?? 'unknown'}`
    return `- ${dependency.key}: ${details}`
  }).join('\n')
}

export function buildChildPrompt(
  goal: SwarmGoal,
  task: TaskGoal,
  toolName: string,
  dependencies: readonly ResolvedDependencyPrompt[] = [],
): string {
  return [
    'Global goal (read-only)',
    goal.statement,
    '',
    'Success criteria',
    bullets(goal.successCriteria),
    '',
    'Constraints',
    bullets(goal.constraints),
    '',
    'Your local task',
    task.objective,
    '',
    'Acceptance criteria',
    bullets(task.acceptanceCriteria),
    '',
    'Expected outputs',
    bullets(task.expectedOutputs),
    '',
    'Resolved dependency results',
    dependencyLines(dependencies),
    '',
    'Execution rules',
    '- Complete only this local task; do not claim that the global goal is achieved.',
    `- Do not call ${toolName} in v0.2; nested swarm is not enabled.`,
    '- Finish by submitting the required structured TaskReport.',
  ].join('\n')
}
