import type { SwarmGoal, TaskGoal } from './types.js'

function bullets(values: readonly string[]): string {
  return values.length === 0 ? '- (none)' : values.map(value => `- ${value}`).join('\n')
}

export function buildChildPrompt(goal: SwarmGoal, task: TaskGoal, toolName: string): string {
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
    'Execution rules',
    '- Complete only this local task; do not claim that the global goal is achieved.',
    `- Do not call ${toolName} in v0.1; nested swarm is not enabled.`,
    '- Finish by submitting the required structured TaskReport.',
  ].join('\n')
}
