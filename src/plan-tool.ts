import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { defineTool, type ParameterPropertySpec } from '@deepseek-ai/dsh-tools'
import type {} from './index.js'
import { agentPlanContentSchema, assertBoundedJsonValue } from './plan-types.js'

export const name = 'product-subagent-console-plan-tool'
export const inject = ['tools', 'productSubagentConsole']

export interface Config {
  /** Model-visible draft-only tool name. Default: `design_subagent_plan`. */
  toolName?: string
  /** Model-visible approved-plan execution tool name. Default: `execute_subagent_plan`. */
  executeToolName?: string
}

export const Config: schema<Config> = schema.object({
  toolName: schema.string().default('design_subagent_plan'),
  executeToolName: schema.string().default('execute_subagent_plan'),
})

const identifierDescription = 'Stable kebab-case identifier unique within this plan.'

/**
 * Keep the complete plan shape model-visible. An unconstrained `json` parameter
 * forces Agents to discover the private TypeScript schema before they can make
 * a valid call, which wastes time and context on an otherwise self-describing
 * planning action. Zod remains the authoritative runtime validator below.
 */
const agentPlanParameterSpec = {
  type: 'object',
  required: true,
  additionalProperties: false,
  description: 'Complete reviewable Agent plan draft. This call saves it but never starts an Agent.',
  properties: {
    title: { type: 'string', required: true, description: 'Short user-facing plan title.' },
    objective: { type: 'string', required: true, description: 'Concrete outcome the whole plan must achieve.' },
    successCriteria: {
      type: 'array',
      required: true,
      description: 'Observable whole-plan success criteria.',
      items: { type: 'string' },
    },
    recommendation: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        useMultiAgent: {
          type: 'boolean',
          required: true,
          description: 'Whether multiple Agents are justified for this objective.',
        },
        rationale: {
          type: 'string',
          required: true,
          description: 'Why this decomposition is preferable for the objective.',
        },
        singleAgentAlternative: {
          type: 'string',
          description: 'Practical single-Agent fallback when one exists.',
        },
        userOverride: {
          type: 'boolean',
          description: 'True only when the user explicitly requires multiple Agents despite the recommendation.',
          default: false,
        },
      },
    },
    pattern: {
      type: 'string',
      required: true,
      enum: [
        'single-agent',
        'manager-workers',
        'parallel-fanout-fanin',
        'sequential-dag',
        'competing-hypotheses',
        'peer-team',
      ],
      description: 'Coordination pattern represented by the task dependency graph. Use parallel-fanout-fanin when independent tasks run together before one downstream synthesis; use sequential-dag only for genuinely ordered stages.',
    },
    optimizationTarget: {
      type: 'string',
      enum: ['balanced', 'quality', 'latency', 'cost'],
      description: 'Primary optimization target. Defaults to balanced.',
      default: 'balanced',
    },
    backendPreference: {
      type: 'string',
      enum: ['auto', 'workflow', 'agent-team'],
      description: 'Preferred execution backend. Use auto unless the user requires a supported backend.',
      default: 'auto',
    },
    budget: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: 'Whole-plan concurrency and resource limits.',
      properties: {
        maxAgents: { type: 'integer', description: 'Maximum total Agents. Allowed range: 1-32.', default: 5 },
        maxConcurrent: { type: 'integer', description: 'Maximum concurrent Agents. Allowed range: 1-16.', default: 4 },
        planTimeoutMs: { type: 'integer', description: 'Whole-plan timeout in milliseconds. Allowed range: 60000-7200000.', default: 1_800_000 },
        maxRequests: { type: 'integer', description: 'Optional request budget. Omit unless explicitly requested or known to be supported; preflight reports unsupported limits.' },
        maxTokens: { type: 'integer', description: 'Optional token budget. Omit unless explicitly requested or known to be supported; preflight reports unsupported limits.' },
        maxCostUsd: { type: 'number', description: 'Optional cost ceiling in USD. Omit unless explicitly requested or known to be supported; preflight blocks unsupported limits.' },
      },
    },
    roles: {
      type: 'array',
      required: true,
      description: 'Roles referenced by tasks.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          roleId: { type: 'string', required: true, description: identifierDescription },
          name: { type: 'string', required: true, description: 'Short user-facing role name.' },
          responsibility: { type: 'string', required: true, description: 'What this role owns.' },
          boundaries: {
            type: 'array',
            description: 'Explicit work this role must not perform.',
            items: { type: 'string' },
          },
          transportProvider: {
            type: 'string',
            required: true,
            description: 'Registered DSH subagent Provider. Common values are spawn for isolated work and fork when parent context is required; preflight verifies availability.',
          },
          llmProvider: {
            type: 'string',
            description: 'Optional model Provider wish. Omit unless the selected backend can enforce it.',
          },
          model: {
            type: 'string',
            description: 'Optional model wish. Omit unless the selected backend can enforce it.',
          },
          agentPreset: {
            type: 'string',
            description: 'Optional Agent preset wish. Omit unless the selected backend can enforce it.',
          },
          contextMode: {
            type: 'string',
            enum: ['fresh', 'fork'],
            description: 'Start with fresh context or fork the parent context. Defaults to fresh.',
            default: 'fresh',
          },
          toolPolicy: {
            description: 'Use inherit for executable auto/workflow plans. An allowlist is only a capability request and preflight may block it when the selected backend cannot enforce per-node tools.',
            oneOf: [{
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true, const: 'inherit' },
              },
            }, {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true, const: 'allowlist' },
                tools: { type: 'array', required: true, items: { type: 'string' } },
              },
            }],
          },
        },
      },
    },
    tasks: {
      type: 'array',
      required: true,
      description: 'Executable tasks and their dependency edges.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true, description: identifierDescription },
          title: { type: 'string', required: true, description: 'Short user-facing task title.' },
          brief: {
            type: 'string',
            required: true,
            description: 'Self-contained, outcome-bounded instructions for the assigned role. Name the allowed inputs or commands, prohibit unnecessary exploration, and include a clear stop condition so simple tasks finish promptly.',
          },
          roleId: { type: 'string', required: true, description: 'roleId of the role that owns this task.' },
          dependsOn: {
            type: 'array',
            description: 'Upstream task dependencies. Use context when the upstream result must be passed to this task; use order-only for sequencing alone.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true, description: 'Upstream taskId.' },
                mode: { type: 'string', required: true, enum: ['order-only', 'context'] },
              },
            },
          },
          expectedOutput: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              description: { type: 'string', required: true, description: 'Human-readable deliverable.' },
              schema: { type: 'json', description: 'Optional JSON object shape for a structured deliverable.' },
            },
          },
          completionCriteria: {
            type: 'array',
            required: true,
            description: 'Observable checks that make this task complete.',
            items: { type: 'string' },
          },
          resourceClaims: {
            type: 'array',
            description: 'Relative resource identifiers used to detect unsafe parallel write overlap.',
            items: { type: 'string' },
          },
          risk: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Task risk level. Defaults to low.',
            default: 'low',
          },
          approvalRequired: {
            type: 'boolean',
            description: 'Whether this task needs an additional approval before execution.',
            default: false,
          },
          budgetHint: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional task-level budget hint.',
            properties: {
              maxTokens: { type: 'integer' },
              maxCostUsd: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const satisfies ParameterPropertySpec

/** Register draft-design and separately gated approved-plan execution tools. */
export function apply(ctx: Context, config: Config = {}): void {
  const toolName = config.toolName ?? 'design_subagent_plan'
  const executeToolName = config.executeToolName ?? 'execute_subagent_plan'
  if (toolName === executeToolName) throw new Error('Agent plan design and execution tool names must be unique')
  ctx.effect(
    () => ctx.productSubagentConsole.registerPlannerToolNames(toolName, executeToolName),
    'dsh-product-subagent-console: planner tool names',
  )
  ctx.tools.register(defineTool({
    name: toolName,
    description:
      'Save a reviewable Agent plan draft for the current conversation. Use this only when the user asks '
      + 'for multi-Agent design, delegation architecture, or a complex execution plan. First decide whether '
      + 'multiple Agents are justified; simple work should use a single-Agent plan. This tool never starts Agents. '
      + 'Keep each task narrowly scoped with explicit inputs, outputs, boundaries, and a stop condition. '
      + 'For auto/workflow drafts, keep toolPolicy in inherit mode and express read-only or no-tool intent in role boundaries and task briefs; do not invent an unsupported allowlist. '
      + 'The user reviews and edits the draft in Subagents > Plan before any execution can be approved.',
    parameters: {
      plan: {
        ...agentPlanParameterSpec,
      },
      plan_id: {
        type: 'string',
        description: 'Existing plan UUID when deliberately creating its next draft revision.',
      },
      expected_revision: {
        type: 'integer',
        description: 'Exact latest revision for an existing plan; omit or use 0 for a new plan.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          state: { type: 'string', required: true, const: 'draft' },
          title: { type: 'string', required: true },
          useMultiAgent: { type: 'boolean', required: true },
          roleCount: { type: 'integer', required: true },
          taskCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `Saved Agent plan draft "${value.title}" (revision ${String(value.revision)}, `
          + `${String(value.roleCount)} roles, ${String(value.taskCount)} tasks). `
          + 'Review it in Subagents > Plan. No Agent was started.',
      }],
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Design Agent plan',
      kind: 'other',
      rawInput: 'Save a draft for canvas review',
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('Agent plan design requires a calling Agent')
      assertBoundedJsonValue(args.plan)
      const content = agentPlanContentSchema.parse(args.plan)
      const expectedRevision = args.expected_revision ?? 0
      if (args.plan_id === undefined && expectedRevision !== 0) {
        throw new Error('a new Agent plan must use expected_revision 0')
      }
      if (args.plan_id !== undefined && expectedRevision < 1) {
        throw new Error('an existing Agent plan requires its exact positive expected_revision')
      }
      const saved = ctx.productSubagentConsole.savePlanDraft({
        parentSessionId: String(parent.id),
        expectedRevision,
        content,
        ...(args.plan_id === undefined ? {} : { planId: args.plan_id }),
      })
      return {
        planId: saved.planId,
        revision: saved.revision,
        state: 'draft' as const,
        title: saved.title,
        useMultiAgent: saved.recommendation.useMultiAgent,
        roleCount: saved.roles.length,
        taskCount: saved.tasks.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: executeToolName,
    description:
      'Execute one exact Agent plan revision only after the user reviewed and approved it in Subagents > Plan '
      + 'and explicitly requested execution. Never call this while designing a plan, never substitute another '
      + 'revision, and never bypass a failed preflight. The plugin runs the approved DAG through its available '
      + 'official execution backend and records factual task/run bindings for comparison.',
    parameters: {
      plan_id: {
        type: 'string',
        required: true,
        description: 'The UUID of the user-approved Agent plan.',
      },
      revision: {
        type: 'integer',
        required: true,
        description: 'The exact positive approved revision shown in the Plan canvas.',
      },
      grant_id: {
        type: 'string',
        required: true,
        description: 'The short-lived one-time execution grant created by the user action in Compare.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          executionId: { type: 'string', required: true },
          planId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          completed: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          unknown: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `Agent plan execution ${value.executionId} ended as ${value.status}: `
          + `${String(value.completed)} completed, ${String(value.failed)} failed, `
          + `${String(value.skipped)} skipped, ${String(value.unknown)} unknown. `
          + 'Open Subagents > Compare to inspect the factual bindings.',
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Execute approved Agent plan',
      kind: 'other',
      rawInput: `${args.plan_id} · revision ${String(args.revision)}`,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('Agent plan execution requires a calling Agent')
      if (args.revision < 1) throw new Error('Agent plan execution requires a positive revision')
      const execution = await ctx.productSubagentConsole.executeApprovedPlan(
        parent,
        args.plan_id,
        args.revision,
        args.grant_id,
        exec.signal,
      )
      const completed = execution.bindings.filter(binding => binding.status === 'completed').length
      const failed = execution.bindings.filter(binding => (
        binding.status === 'failed' || binding.status === 'rejected' || binding.status === 'cancelled'
      )).length
      const skipped = execution.bindings.filter(binding => binding.status === 'skipped').length
      const unknown = execution.bindings.length - completed - failed - skipped
      return {
        executionId: execution.executionId,
        planId: execution.planId,
        revision: execution.planRevision,
        status: execution.status,
        completed,
        failed,
        skipped,
        unknown,
      }
    },
  }))
}
