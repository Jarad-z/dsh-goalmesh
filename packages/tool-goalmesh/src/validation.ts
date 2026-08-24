import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  GoalMeshRootArgsV02,
  GoalMeshNestedArgsV03,
  Config,
  DependencyFailurePolicy,
  InvocationFailureMode,
  ResolvedConfig,
  TaskReport,
} from './types.js'

const ROOT_KEYS = new Set(['goal', 'tasks', 'failure_mode', 'quorum'])
const NESTED_KEYS = new Set(['tasks', 'failure_mode', 'quorum'])
const GOAL_KEYS = new Set(['statement', 'success_criteria', 'constraints'])
const TASK_KEYS = new Set([
  'key',
  'description',
  'objective',
  'acceptance_criteria',
  'expected_outputs',
  'depends_on',
  'dependency_failure',
])
const REPORT_KEYS = new Set(['reported_status', 'summary', 'evidence', 'output', 'remaining_problems'])
const EVIDENCE_KEYS = new Set(['claim', 'reference'])
const MAX_TIMER_DELAY_MS = 2_147_483_647

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${path} contains unknown field ${JSON.stringify(unknown[0])}`)
}

function nonBlank(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-blank string`)
}

function stringArray(value: unknown, path: string, nonEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${nonEmpty ? 'a non-empty' : 'an'} array of non-blank strings`)
  }
  value.forEach((entry, index) => nonBlank(entry, `${path}[${index}]`))
}

function positiveSafeInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${path} must be a positive safe integer no greater than ${max}`)
  }
}

function nonNegativeSafeInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${path} must be a non-negative safe integer no greater than ${max}`)
  }
}

export function resolveConfig(config: Config): ResolvedConfig {
  nonBlank(config.provider, 'config.provider')
  const toolName = config.toolName ?? 'goal_mesh'
  nonBlank(toolName, 'config.toolName')
  const maxConcurrency = config.maxConcurrency ?? 4
  const maxTasks = config.maxTasks ?? 64
  const maxDepth = config.maxDepth ?? 3
  const swarmTimeoutMs = config.swarmTimeoutMs ?? 0
  const attemptTimeoutMs = config.attemptTimeoutMs ?? 0
  const maxTaskReportChars = config.maxTaskReportChars ?? 0
  const maxRenderedResultChars = config.maxRenderedResultChars ?? 0
  const defaultFailureMode = config.defaultFailureMode ?? 'collect_all'
  positiveSafeInteger(maxConcurrency, 'config.maxConcurrency')
  positiveSafeInteger(maxTasks, 'config.maxTasks')
  positiveSafeInteger(maxDepth, 'config.maxDepth')
  nonNegativeSafeInteger(swarmTimeoutMs, 'config.swarmTimeoutMs', MAX_TIMER_DELAY_MS)
  nonNegativeSafeInteger(attemptTimeoutMs, 'config.attemptTimeoutMs', MAX_TIMER_DELAY_MS)
  nonNegativeSafeInteger(maxTaskReportChars, 'config.maxTaskReportChars')
  nonNegativeSafeInteger(maxRenderedResultChars, 'config.maxRenderedResultChars')
  if (!['collect_all', 'fail_fast'].includes(defaultFailureMode)) {
    throw new Error('config.defaultFailureMode must be "collect_all" or "fail_fast"')
  }
  const nestedMode = config.nestedMode ?? 'disabled'
  if (!['disabled', 'local-only'].includes(nestedMode)) {
    throw new Error('config.nestedMode must be "disabled" or "local-only" in v0.3')
  }
  if (config.childToolFilter !== undefined
    && config.childToolFilter.allow === undefined && config.childToolFilter.deny === undefined) {
    throw new Error('config.childToolFilter must declare allow or deny')
  }
  return {
    provider: config.provider,
    toolName,
    maxConcurrency,
    maxTasks,
    maxDepth,
    swarmTimeoutMs,
    attemptTimeoutMs,
    maxTaskReportChars,
    maxRenderedResultChars,
    defaultFailureMode,
    nestedMode,
    ...config.childAgentOptions === undefined ? {} : { childAgentOptions: config.childAgentOptions },
    ...config.childToolFilter === undefined ? {} : { childToolFilter: config.childToolFilter },
  }
}

export interface ValidatedRootArgsV02 {
  readonly failureMode: InvocationFailureMode
  readonly quorum?: number
  readonly dependenciesByKey: ReadonlyMap<string, readonly string[]>
  readonly dependencyFailureByKey: ReadonlyMap<string, DependencyFailurePolicy>
}

export type ValidatedNestedArgsV03 = ValidatedRootArgsV02

function assertInvocationTasks(
  root: Record<string, unknown>,
  maxTasks: number,
  defaultFailureMode: ResolvedConfig['defaultFailureMode'],
): ValidatedRootArgsV02 {
  if (!Array.isArray(root.tasks) || root.tasks.length === 0) {
    throw new Error('arguments.tasks must be a non-empty array')
  }
  if (root.tasks.length > maxTasks) {
    throw new Error(`arguments.tasks exceeds remaining maxTasks budget (${root.tasks.length} > ${maxTasks})`)
  }
  const keys = new Set<string>()
  const dependenciesByKey = new Map<string, readonly string[]>()
  const dependencyFailureByKey = new Map<string, DependencyFailurePolicy>()
  root.tasks.forEach((candidate, index) => {
    const task = plainRecord(candidate, `arguments.tasks[${index}]`)
    assertExactKeys(task, TASK_KEYS, `arguments.tasks[${index}]`)
    nonBlank(task.key, `arguments.tasks[${index}].key`)
    if (keys.has(task.key)) throw new Error(`arguments.tasks contains duplicate key ${JSON.stringify(task.key)}`)
    keys.add(task.key)
    nonBlank(task.description, `arguments.tasks[${index}].description`)
    nonBlank(task.objective, `arguments.tasks[${index}].objective`)
    stringArray(task.acceptance_criteria, `arguments.tasks[${index}].acceptance_criteria`, true)
    if (task.expected_outputs !== undefined) {
      stringArray(task.expected_outputs, `arguments.tasks[${index}].expected_outputs`, false)
    }
    if (task.depends_on !== undefined) {
      stringArray(task.depends_on, `arguments.tasks[${index}].depends_on`, false)
      const dependencies = [...task.depends_on]
      if (new Set(dependencies).size !== dependencies.length) {
        throw new Error(`arguments.tasks[${index}].depends_on contains duplicate keys`)
      }
      dependenciesByKey.set(task.key, dependencies)
    } else {
      dependenciesByKey.set(task.key, [])
    }
    if (task.dependency_failure !== undefined
      && !['fail', 'skip', 'partial'].includes(String(task.dependency_failure))) {
      throw new Error(`arguments.tasks[${index}].dependency_failure is invalid`)
    }
    dependencyFailureByKey.set(task.key, (task.dependency_failure ?? 'fail') as DependencyFailurePolicy)
  })

  for (const [key, dependencies] of dependenciesByKey) {
    for (const dependency of dependencies) {
      if (dependency === key) throw new Error(`dependency_cycle: task ${JSON.stringify(key)} cannot depend on itself`)
      if (!keys.has(dependency)) {
        throw new Error(`dependency_missing: task ${JSON.stringify(key)} references missing dependency ${JSON.stringify(dependency)}`)
      }
    }
  }
  const remaining = new Map([...dependenciesByKey].map(([key, dependencies]) => [key, dependencies.length]))
  const dependents = new Map<string, string[]>([...keys].map(key => [key, []]))
  for (const [key, dependencies] of dependenciesByKey) {
    for (const dependency of dependencies) dependents.get(dependency)?.push(key)
  }
  const ready = [...keys].filter(key => remaining.get(key) === 0)
  let visited = 0
  while (ready.length > 0) {
    const key = ready.shift()
    if (key === undefined) break
    visited++
    for (const dependent of dependents.get(key) ?? []) {
      const next = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (visited !== keys.size) {
    const cyclic = [...keys].filter(key => (remaining.get(key) ?? 0) > 0)
    throw new Error(`dependency_cycle: tasks form a cycle involving ${cyclic.map(key => JSON.stringify(key)).join(', ')}`)
  }

  if (root.failure_mode !== undefined
    && !['collect_all', 'fail_fast', 'quorum'].includes(String(root.failure_mode))) {
    throw new Error('arguments.failure_mode is invalid')
  }
  const failureMode = (root.failure_mode ?? defaultFailureMode) as InvocationFailureMode
  if (root.quorum !== undefined) positiveSafeInteger(root.quorum, 'arguments.quorum', root.tasks.length)
  if (root.failure_mode !== 'quorum' && root.quorum !== undefined) {
    throw new Error('arguments.quorum is allowed only with failure_mode "quorum"')
  }
  if (failureMode === 'quorum' && root.quorum === undefined) {
    throw new Error('arguments.quorum is required with failure_mode "quorum"')
  }
  return {
    failureMode,
    ...root.quorum === undefined ? {} : { quorum: root.quorum },
    dependenciesByKey,
    dependencyFailureByKey,
  }
}

export function assertRootArgsV02(
  args: GoalMeshRootArgsV02,
  maxTasks: number,
  defaultFailureMode: ResolvedConfig['defaultFailureMode'] = 'collect_all',
): ValidatedRootArgsV02 {
  const root = plainRecord(args, 'arguments')
  assertExactKeys(root, ROOT_KEYS, 'arguments')
  const goal = plainRecord(root.goal, 'arguments.goal')
  assertExactKeys(goal, GOAL_KEYS, 'arguments.goal')
  nonBlank(goal.statement, 'arguments.goal.statement')
  stringArray(goal.success_criteria, 'arguments.goal.success_criteria', true)
  if (goal.constraints !== undefined) stringArray(goal.constraints, 'arguments.goal.constraints', false)
  return assertInvocationTasks(root, maxTasks, defaultFailureMode)
}

export function assertNestedArgsV03(
  args: GoalMeshNestedArgsV03,
  remainingTasks: number,
  defaultFailureMode: ResolvedConfig['defaultFailureMode'] = 'collect_all',
): ValidatedNestedArgsV03 {
  const root = plainRecord(args, 'arguments')
  assertExactKeys(root, NESTED_KEYS, 'arguments')
  return assertInvocationTasks(root, remainingTasks, defaultFailureMode)
}

function assertJsonValue(value: unknown, path: string, seen: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${path} is not lossless JSON`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${path} is not lossless JSON`)
  if (seen.has(value)) throw new Error(`${path} is cyclic`)
  seen.add(value)
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error(`${path} is a sparse or decorated array`)
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen))
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must contain only plain JSON objects`)
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

export type TaskReportValidation =
  | { readonly ok: true; readonly report: TaskReport; readonly chars: number }
  | { readonly ok: false; readonly kind: 'structured_result_invalid' | 'structured_result_too_large'; readonly message: string }

export function validateTaskReport(value: unknown, maxChars: number): TaskReportValidation {
  try {
    const report = plainRecord(value, 'structured result')
    assertExactKeys(report, REPORT_KEYS, 'structured result')
    if (!['achieved', 'not_achieved', 'blocked'].includes(String(report.reported_status))) {
      throw new Error('structured result.reported_status is invalid')
    }
    nonBlank(report.summary, 'structured result.summary')
    if (!Array.isArray(report.evidence)) throw new Error('structured result.evidence must be an array')
    report.evidence.forEach((candidate, index) => {
      const evidence = plainRecord(candidate, `structured result.evidence[${index}]`)
      assertExactKeys(evidence, EVIDENCE_KEYS, `structured result.evidence[${index}]`)
      nonBlank(evidence.claim, `structured result.evidence[${index}].claim`)
      if (evidence.reference !== undefined) nonBlank(evidence.reference, `structured result.evidence[${index}].reference`)
    })
    if (report.remaining_problems !== undefined) {
      stringArray(report.remaining_problems, 'structured result.remaining_problems', false)
    }
    assertJsonValue(report, 'structured result', new Set())
    const snapshot = JSON.stringify(report)
    if (maxChars > 0 && snapshot.length > maxChars) {
      return {
        ok: false,
        kind: 'structured_result_too_large',
        message: `structured TaskReport exceeds maxTaskReportChars (${snapshot.length} > ${maxChars})`,
      }
    }
    return { ok: true, report: JSON.parse(snapshot) as TaskReport, chars: snapshot.length }
  } catch (error: unknown) {
    return {
      ok: false,
      kind: 'structured_result_invalid',
      message: error instanceof Error ? error.message : 'structured TaskReport is invalid',
    }
  }
}

export function sanitizeDiagnostic(error: unknown, maxChars = 500): string {
  const raw = error instanceof Error ? error.message : String(error)
  const singleLine = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`
}

export function boundedText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}
