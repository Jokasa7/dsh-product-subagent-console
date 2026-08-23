import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
      + 'The user reviews and edits the draft in Subagents > Plan before any execution can be approved.',
    parameters: {
      plan: {
        type: 'json',
        required: true,
        description:
          'A complete AgentPlanContent object containing the recommendation, roles, tasks, dependency modes, '
          + 'Provider wishes, tool policy, resource claims, completion criteria, and budgets.',
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
