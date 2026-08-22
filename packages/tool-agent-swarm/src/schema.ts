import z from '@deepseek-ai/schemastery'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Config } from './types.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export const ConfigSchema = z.object({
  provider: z.string().required(),
  toolName: z.string().default('agent_swarm'),
  maxConcurrency: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(4),
  maxTasks: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64),
  maxDepth: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  swarmTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(900_000),
  attemptTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  maxTaskReportChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(12_000),
  maxRenderedResultChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(50_000),
  defaultFailureMode: z.union(['collect_all', 'fail_fast'] as const).default('collect_all'),
  nestedMode: z.union(['disabled', 'local-only'] as const).default('disabled'),
  childAgentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  childToolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
}) as unknown as z<Config>

export const ROOT_AGENT_SWARM_PARAMETERS = {
  goal: {
    type: 'object' as const,
    required: true,
    additionalProperties: false,
    properties: {
      statement: { type: 'string' as const, required: true },
      success_criteria: {
        type: 'array' as const,
        required: true,
        items: { type: 'string' as const },
      },
      constraints: { type: 'array' as const, items: { type: 'string' as const } },
    },
  },
  tasks: {
    type: 'array' as const,
    required: true,
    items: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        key: { type: 'string' as const, required: true },
        description: { type: 'string' as const, required: true },
        objective: { type: 'string' as const, required: true },
        acceptance_criteria: {
          type: 'array' as const,
          required: true,
          items: { type: 'string' as const },
        },
        expected_outputs: { type: 'array' as const, items: { type: 'string' as const } },
        depends_on: { type: 'array' as const, items: { type: 'string' as const } },
        dependency_failure: {
          type: 'string' as const,
          enum: ['fail', 'skip', 'partial'] as const,
        },
      },
    },
  },
  failure_mode: {
    type: 'string' as const,
    enum: ['collect_all', 'fail_fast', 'quorum'] as const,
  },
  quorum: { type: 'integer' as const },
} as const

export const NESTED_AGENT_SWARM_PARAMETERS = {
  tasks: ROOT_AGENT_SWARM_PARAMETERS.tasks,
  failure_mode: ROOT_AGENT_SWARM_PARAMETERS.failure_mode,
  quorum: ROOT_AGENT_SWARM_PARAMETERS.quorum,
} as const

export const TASK_REPORT_JSON_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reported_status', 'summary', 'evidence'],
  properties: {
    reported_status: { type: 'string', enum: ['achieved', 'not_achieved', 'blocked'] },
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim'],
        properties: {
          claim: { type: 'string' },
          reference: { type: 'string' },
        },
      },
    },
    output: {},
    remaining_problems: { type: 'array', items: { type: 'string' } },
  },
}

const FAILURE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true },
    message: { type: 'string' as const, required: true },
  },
} as const

const TASK_REPORT_VALUE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    reported_status: {
      type: 'string' as const,
      required: true,
      enum: ['achieved', 'not_achieved', 'blocked'] as const,
    },
    summary: { type: 'string' as const, required: true },
    evidence: {
      type: 'array' as const,
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          claim: { type: 'string' as const, required: true },
          reference: { type: 'string' as const },
        },
      },
    },
    output: { type: 'json' as const },
    remaining_problems: { type: 'array' as const, items: { type: 'string' as const } },
  },
} as const

export const AGENT_SWARM_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    swarmId: { type: 'string' as const, required: true },
    invocationId: { type: 'string' as const, required: true },
    kind: {
      type: 'string' as const,
      required: true,
      enum: ['root', 'nested'] as const,
    },
    terminalReason: {
      type: 'string' as const,
      required: true,
      enum: ['all_tasks_settled', 'quorum_reached', 'failed_fast'] as const,
    },
    tasks: {
      type: 'array' as const,
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' as const, required: true },
          key: { type: 'string' as const, required: true },
          status: {
            type: 'string' as const,
            required: true,
            enum: ['completed', 'failed', 'skipped', 'aborted'] as const,
          },
          attempts: { type: 'integer' as const, required: true },
          childId: { type: 'string' as const },
          report: TASK_REPORT_VALUE_SCHEMA,
          failure: FAILURE_SCHEMA,
        },
      },
    },
    summary: {
      type: 'object' as const,
      required: true,
      additionalProperties: false,
      properties: {
        completed: { type: 'integer' as const, required: true },
        failed: { type: 'integer' as const, required: true },
        skipped: { type: 'integer' as const, required: true },
        aborted: { type: 'integer' as const, required: true },
        descendants: { type: 'integer' as const, required: true },
        reportedAchieved: { type: 'integer' as const, required: true },
        reportedNotAchieved: { type: 'integer' as const, required: true },
        reportedBlocked: { type: 'integer' as const, required: true },
      },
    },
  },
} as const
