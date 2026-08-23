import { describe, expect, it } from 'vitest'
import { deriveParallelWaves, preflightAgentPlan } from '../src/plan-preflight.js'
import type {
  AgentPlanRevision,
  ExecutionCapabilitySnapshot,
  PlanTask,
} from '../src/plan-types.js'

const planId = '00000000-0000-4000-8000-000000000001'

function capabilities(overrides: Partial<ExecutionCapabilitySnapshot> = {}): ExecutionCapabilitySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: 1_000,
    digest: 'capabilities-v1',
    adapters: { workflow: true, agentTeam: false },
    transportProviders: [{
    name: 'spawn',
      inheritsParentContext: false,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    continuable: false,
    modelRouting: 'unsupported',
    maxTokens: 'unsupported',
    }],
    llmRoutes: [{ provider: 'deepseek', models: ['deepseek-chat'], catalogStatus: 'available' }],
    agentPresets: ['researcher'],
    tools: ['web_search', 'execute_subagent_plan'],
    plannerTools: {
      design: ['design_subagent_plan'],
      execute: ['execute_subagent_plan'],
    },
    budgetSupport: {
      maxAgents: 'enforced',
      maxConcurrent: 'enforced',
      planTimeout: 'enforced',
      requests: 'advisory',
      tokens: 'advisory',
      cost: 'unsupported',
    },
    limits: { maxAgents: 32, maxConcurrent: 16 },
    experimentalAgentTeam: false,
    catalogDigest: 'catalog-v1',
    scopeStatus: 'available',
    ...overrides,
  }
}

function task(taskId: string, dependsOn: PlanTask['dependsOn'] = []): PlanTask {
  return {
    taskId,
    title: taskId,
    brief: `Complete ${taskId}`,
    roleId: 'researcher',
    dependsOn,
    expectedOutput: { description: `${taskId} result` },
    completionCriteria: ['Result is supported by evidence'],
    resourceClaims: [],
    risk: 'low',
    approvalRequired: false,
  }
}

function plan(tasks: PlanTask[]): AgentPlanRevision {
  return {
    schemaVersion: 1,
    planId,
    parentSessionId: 'session-root',
    revision: 1,
    state: 'draft',
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Research plan',
    objective: 'Research independent questions and synthesize the findings.',
    successCriteria: ['Every claim is supported'],
    recommendation: {
      useMultiAgent: true,
      rationale: 'Independent questions can run in parallel.',
      singleAgentAlternative: 'One Agent researches each question sequentially.',
      userOverride: false,
    },
    pattern: 'parallel-fanout-fanin',
    optimizationTarget: 'balanced',
    backendPreference: 'auto',
    budget: {
      maxAgents: 5,
      maxConcurrent: 4,
      planTimeoutMs: 1_800_000,
    },
    roles: [{
      roleId: 'researcher',
      name: 'Researcher',
      responsibility: 'Investigate one bounded question.',
      boundaries: [],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks,
  }
}

describe('Agent plan preflight', () => {
  it('blocks approval when the current Agent scope does not expose the execution tool', () => {
    const result = preflightAgentPlan(plan([task('a')]), capabilities({
      tools: ['web_search'],
    }))

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'planner.execution-tool-unavailable',
      severity: 'error',
      support: 'unsupported',
    }))
  })

  it('blocks approval when the parent Agent scope is unavailable', () => {
    const result = preflightAgentPlan(plan([task('a')]), capabilities({
      scopeStatus: 'unavailable',
      tools: [],
    }))

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'planner.agent-scope-unavailable',
      severity: 'error',
      support: 'unsupported',
    }))
  })

  it('derives deterministic ready waves from dependency edges', () => {
    const tasks = [
      task('a'),
      task('b'),
      task('synthesis', [
        { taskId: 'a', mode: 'context' },
        { taskId: 'b', mode: 'context' },
      ]),
    ]
    expect(deriveParallelWaves(tasks)).toEqual([['a', 'b'], ['synthesis']])
    expect(preflightAgentPlan(plan(tasks), capabilities())).toMatchObject({
      valid: true,
      resolvedBackend: 'workflow',
      parallelWaves: [['a', 'b'], ['synthesis']],
    })
  })

  it('blocks cycles, missing roles, self dependencies, and duplicate edges', () => {
    const first = task('a', [{ taskId: 'b', mode: 'order-only' }])
    const second = {
      ...task('b', [
        { taskId: 'a', mode: 'order-only' },
        { taskId: 'a', mode: 'context' },
        { taskId: 'b', mode: 'order-only' },
      ]),
      roleId: 'missing-role',
    }
    const result = preflightAgentPlan(plan([first, second]), capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'task.role-missing',
      'task.self-dependency',
      'task.dependency-duplicate',
      'plan.cycle',
    ]))
  })

  it('blocks unavailable composition instead of degrading it into prompt text', () => {
    const candidate = plan([task('a')])
    candidate.roles[0] = {
      ...candidate.roles[0]!,
      transportProvider: 'missing-provider',
      llmProvider: 'missing-llm',
      model: 'missing-model',
      agentPreset: 'missing-preset',
      toolPolicy: { mode: 'allowlist', tools: ['missing-tool'] },
    }
    const result = preflightAgentPlan(candidate, capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'provider.transport-unavailable',
      'provider.llm-unavailable',
      'preset.unavailable',
    ]))
  })

  it('blocks Workflow composition fields that the transport cannot enforce', () => {
    const candidate = plan([task('a')])
    candidate.roles[0] = {
      ...candidate.roles[0]!,
      llmProvider: 'deepseek',
      model: 'deepseek-chat',
      agentPreset: 'researcher',
      toolPolicy: { mode: 'allowlist', tools: ['web_search'] },
    }
    const result = preflightAgentPlan(candidate, capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'backend.workflow-model-routing-unsupported',
      'backend.workflow-preset-unsupported',
      'backend.workflow-tool-policy-unsupported',
    ]))
  })

  it('treats model membership as advisory when a transport can enforce routing', () => {
    const candidate = plan([task('a')])
    candidate.roles[0] = {
      ...candidate.roles[0]!,
      llmProvider: 'deepseek',
      model: 'unlisted-model',
    }
    const catalog = capabilities({
      transportProviders: [{
        ...capabilities().transportProviders[0]!,
        modelRouting: 'enforced',
      }],
    })
    const result = preflightAgentPlan(candidate, catalog)
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'provider.model-not-in-advisory-catalog',
      severity: 'warning',
      support: 'advisory',
    }))
  })

  it('blocks parallel write conflicts and budget excess', () => {
    const left = { ...task('left'), resourceClaims: ['src/features'] }
    const right = { ...task('right'), resourceClaims: ['src/features/panel.tsx'] }
    const candidate = plan([left, right])
    candidate.budget.maxAgents = 1
    const result = preflightAgentPlan(candidate, capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'task.parallel-write-conflict',
      'budget.max-agents-exceeded',
    ]))
  })

  it('canonicalizes equivalent resource scopes before checking parallel writes', () => {
    const left = { ...task('left'), resourceClaims: ['src/features'] }
    const right = { ...task('right'), resourceClaims: ['src/./features//panel.tsx'] }
    const result = preflightAgentPlan(plan([left, right]), capabilities())

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'task.parallel-write-conflict',
      severity: 'error',
      nodeIds: ['left', 'right'],
    }))
  })

  it('treats the repository root claim as overlapping every parallel write scope', () => {
    const left = { ...task('left'), resourceClaims: ['./'] }
    const right = { ...task('right'), resourceClaims: ['src/features'] }
    const result = preflightAgentPlan(plan([left, right]), capabilities())

    expect(result.diagnostics.map(item => item.code)).toContain('task.parallel-write-conflict')
  })

  it('blocks output schemas outside the subset accepted by the DSH workflow engine', () => {
    const candidate = plan([{
      ...task('a'),
      expectedOutput: {
        description: 'A structured result.',
        schema: { type: 'definitely-not-supported' },
      },
    }])
    const result = preflightAgentPlan(candidate, capabilities())

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'task.output-schema-invalid',
      severity: 'error',
      nodeIds: ['a'],
    }))
  })

  it('labels usage budgets honestly and blocks unsupported cost enforcement', () => {
    const candidate = plan([task('a')])
    candidate.budget.maxRequests = 20
    candidate.budget.maxTokens = 40_000
    candidate.budget.maxCostUsd = 2
    const result = preflightAgentPlan(candidate, capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'budget.requests.advisory', severity: 'warning' }),
      expect.objectContaining({ code: 'budget.tokens.advisory', severity: 'warning' }),
      expect.objectContaining({ code: 'budget.cost.unsupported', severity: 'error' }),
    ]))
  })

  it('blocks task-level budget hints before the Workflow adapter can reject an approved plan', () => {
    const candidate = plan([task('a')])
    candidate.tasks[0] = { ...candidate.tasks[0]!, budgetHint: { maxTokens: 2_000 } }
    const result = preflightAgentPlan(candidate, capabilities())
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'task.budget-hint-unsupported',
      severity: 'error',
      nodeIds: ['a'],
    }))
  })

  it('assigns stable distinct ids to repeated diagnostic codes', () => {
    const candidate = plan([task('a'), task('b')])
    candidate.roles.push({
      ...candidate.roles[0]!,
      roleId: 'second',
      name: 'Second',
      llmProvider: 'catalog',
      model: 'missing-b',
    })
    candidate.roles[0] = {
      ...candidate.roles[0]!,
      llmProvider: 'catalog',
      model: 'missing-a',
    }
    candidate.tasks[1] = { ...candidate.tasks[1]!, roleId: 'second' }
    const result = preflightAgentPlan(candidate, capabilities({
      llmRoutes: [{ provider: 'catalog', models: [], catalogStatus: 'unavailable' }],
    }))
    const repeated = result.diagnostics.filter(item => item.code === 'provider.model-catalog-unavailable')
    expect(repeated).toHaveLength(2)
    expect(new Set(repeated.map(item => item.diagnosticId)).size).toBe(2)
    expect(preflightAgentPlan(candidate, capabilities({
      llmRoutes: [{ provider: 'catalog', models: [], catalogStatus: 'unavailable' }],
    })).diagnostics.map(item => item.diagnosticId)).toEqual(result.diagnostics.map(item => item.diagnosticId))
  })

  it('blocks an unverified model omitted from an incomplete catalog', () => {
    const candidate = plan([task('a')])
    candidate.roles[0] = {
      ...candidate.roles[0]!,
      llmProvider: 'catalog',
      model: 'possibly-truncated',
    }
    const result = preflightAgentPlan(candidate, capabilities({
      llmRoutes: [{ provider: 'catalog', models: ['retained'], catalogStatus: 'incomplete' }],
    }))

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'provider.model-catalog-incomplete',
      severity: 'error',
      nodeIds: ['researcher'],
    }))
  })

  it('requires one transport for Workflow and gates experimental peer teams', () => {
    const candidate = plan([task('a')])
    candidate.roles.push({
      ...candidate.roles[0]!,
      roleId: 'reviewer',
      name: 'Reviewer',
      transportProvider: 'fork',
    })
    const mixedCapabilities = capabilities({
      transportProviders: [
        ...capabilities().transportProviders,
        {
          name: 'fork',
          inheritsParentContext: true,
          outputSchema: true,
          depthLimit: true,
          toolFilter: true,
          persona: true,
          continuable: true,
          modelRouting: 'unsupported',
          maxTokens: 'unsupported',
        },
      ],
    })
    const mixed = preflightAgentPlan(candidate, mixedCapabilities)
    expect(mixed.diagnostics.map(item => item.code)).toContain('backend.workflow-mixed-transports')

    candidate.pattern = 'peer-team'
    candidate.backendPreference = 'agent-team'
    const team = preflightAgentPlan(candidate, mixedCapabilities)
    expect(team.diagnostics.map(item => item.code)).toContain('backend.agent-team-unavailable')
  })

  it('requires an explicit override when the planner recommends one Agent', () => {
    const candidate = plan([task('a'), task('b')])
    candidate.recommendation.useMultiAgent = false
    candidate.recommendation.singleAgentAlternative = 'Use the current Agent.'
    let result = preflightAgentPlan(candidate, capabilities())
    expect(result.diagnostics.map(item => item.code)).toContain('plan.multi-agent-not-recommended')
    candidate.recommendation.userOverride = true
    result = preflightAgentPlan(candidate, capabilities())
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'plan.multi-agent-user-override',
      severity: 'warning',
    }))
  })
})
