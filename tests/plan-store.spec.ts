import { describe, expect, it, vi } from 'vitest'
import {
  AgentPlanRepository,
  PlanApprovalError,
  PlanOwnershipError,
  PlanRevisionConflictError,
} from '../src/plan-store.js'
import { assertBoundedJsonValue, type AgentPlanContent, type PlanPreflightResult } from '../src/plan-types.js'

function content(title = 'Plan'): AgentPlanContent {
  return {
    title,
    objective: 'Complete a bounded task with a factual result.',
    successCriteria: ['The result satisfies the stated objective'],
    recommendation: {
      useMultiAgent: false,
      rationale: 'One task does not need coordination overhead.',
      singleAgentAlternative: 'Use the current Agent directly.',
      userOverride: false,
    },
    pattern: 'single-agent',
    optimizationTarget: 'balanced',
    backendPreference: 'workflow',
    budget: { maxAgents: 1, maxConcurrent: 1, planTimeoutMs: 60_000 },
    roles: [{
      roleId: 'worker',
      name: 'Worker',
      responsibility: 'Complete the task.',
      boundaries: [],
      transportProvider: 'spawn',
      contextMode: 'fresh',
      toolPolicy: { mode: 'inherit' },
    }],
    tasks: [{
      taskId: 'task',
      title: 'Task',
      brief: 'Complete the task.',
      roleId: 'worker',
      dependsOn: [],
      expectedOutput: { description: 'A factual result.' },
      completionCriteria: ['Result is present'],
      resourceClaims: [],
      risk: 'low',
      approvalRequired: false,
    }],
  }
}

function preflight(planId: string, revision: number, warning = false): PlanPreflightResult {
  return {
    planId,
    revision,
    capabilityDigest: 'capability-v1',
    resolvedBackend: 'workflow',
    valid: true,
    diagnostics: warning ? [{
      diagnosticId: 'plan.no-parallelism:one',
      severity: 'warning',
      code: 'plan.no-parallelism',
      message: 'No parallelism.',
      nodeIds: [],
    }] : [],
    parallelWaves: [['task']],
  }
}

describe('AgentPlanRepository', () => {
  it('saves immutable revisions with compare-and-swap and detached reads', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    const repository = new AgentPlanRepository()
    const first = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: content('First'),
    })
    first.title = 'caller mutation'
    expect(repository.get('parent-a', first.planId)?.title).toBe('First')

    const second = repository.saveDraft({
      parentSessionId: 'parent-a',
      planId: first.planId,
      expectedRevision: 1,
      content: content('Second'),
    })
    expect(second.revision).toBe(2)
    expect(repository.get('parent-a', first.planId, 1)?.state).toBe('superseded')
    expect(repository.get('parent-a', first.planId)?.title).toBe('Second')
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-a',
      planId: first.planId,
      expectedRevision: 1,
      content: content('Stale'),
    })).toThrow(PlanRevisionConflictError)
  })

  it('isolates plans by parent Session', () => {
    const repository = new AgentPlanRepository()
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: content(),
    })
    expect(repository.list(['parent-b'])).toEqual([])
    expect(() => repository.get('parent-b', saved.planId)).toThrow(PlanOwnershipError)
  })

  it('approves only an exact valid preflight after all warnings are accepted', () => {
    const repository = new AgentPlanRepository()
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: content(),
    })
    const result = preflight(saved.planId, saved.revision, true)
    expect(() => repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningIds: [],
    })).toThrow(PlanApprovalError)

    const approved = repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningIds: ['plan.no-parallelism:one'],
    })
    expect(approved).toMatchObject({
      state: 'approved',
      capabilityDigest: 'capability-v1',
      acceptedWarningIds: ['plan.no-parallelism:one'],
    })
    expect(() => repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningIds: ['plan.no-parallelism:one'],
    })).toThrow(PlanApprovalError)
  })

  it('requires acceptance of every warning instance even when codes match', () => {
    const repository = new AgentPlanRepository()
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: content(),
    })
    const result: PlanPreflightResult = {
      ...preflight(saved.planId, saved.revision),
      diagnostics: [{
        diagnosticId: 'provider.catalog:role-a',
        severity: 'warning',
        code: 'provider.model-catalog-unavailable',
        message: 'Catalog unavailable for role A.',
        nodeIds: ['role-a'],
      }, {
        diagnosticId: 'provider.catalog:role-b',
        severity: 'warning',
        code: 'provider.model-catalog-unavailable',
        message: 'Catalog unavailable for role B.',
        nodeIds: ['role-b'],
      }],
    }

    expect(() => repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningIds: ['provider.catalog:role-a'],
    })).toThrow('provider.catalog:role-b')

    expect(repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningIds: ['provider.catalog:role-a', 'provider.catalog:role-b'],
    }).acceptedWarningIds).toEqual(['provider.catalog:role-a', 'provider.catalog:role-b'])
  })

  it('publishes a monotonic repository revision to subscribers', () => {
    const repository = new AgentPlanRepository()
    const listener = vi.fn()
    const dispose = repository.subscribe(listener)
    repository.saveDraft({ parentSessionId: 'parent-a', expectedRevision: 0, content: content() })
    expect(repository.revision).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    repository.saveDraft({ parentSessionId: 'parent-b', expectedRevision: 0, content: content() })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('contains listener failures after committing a revision', () => {
    const onListenerError = vi.fn()
    const repository = new AgentPlanRepository(100, 50, 16 * 1024 * 1024, 20, onListenerError)
    repository.subscribe(() => { throw new Error('listener failed') })
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: content(),
    })
    expect(repository.get('parent-a', saved.planId)).toBeDefined()
    expect(onListenerError).toHaveBeenCalledOnce()
  })

  it('rejects oversized plans and unsafe resource claims before storage', () => {
    const repository = new AgentPlanRepository()
    const oversized = content()
    oversized.tasks = Array.from({ length: 40 }, (_, index) => ({
      ...oversized.tasks[0]!,
      taskId: `task-${String(index)}`,
      title: `Task ${String(index)}`,
      brief: 'x'.repeat(8_000),
    }))
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: oversized,
    })).toThrow('encoded bytes')

    const unsafe = content()
    unsafe.tasks[0] = { ...unsafe.tasks[0]!, resourceClaims: ['safe/../fixture'] }
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: unsafe,
    })).toThrow()
  })

  it('canonicalizes resource claims and rejects output schemas unsupported by DSH', () => {
    const repository = new AgentPlanRepository()
    const canonical = content()
    canonical.tasks[0] = {
      ...canonical.tasks[0]!,
      resourceClaims: ['src/./features//panel.tsx', '.\\'],
    }
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: canonical,
    })
    expect(saved.tasks[0]?.resourceClaims).toEqual(['src/features/panel.tsx', '.'])

    const invalid = content()
    invalid.tasks[0] = {
      ...invalid.tasks[0]!,
      expectedOutput: {
        description: 'Structured result.',
        schema: { type: 'definitely-not-supported' },
      },
    }
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-b',
      expectedRevision: 0,
      content: invalid,
    })).toThrow('unsupported output schema')
  })

  it('preserves JSON Schema property names and validates dangerous own keys before storage', () => {
    const repository = new AgentPlanRepository()
    const valid = content()
    const validSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}',
    ) as Record<string, never>
    valid.tasks[0] = {
      ...valid.tasks[0]!,
      expectedOutput: { description: 'Structured result.', schema: validSchema },
    }
    const saved = repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: valid,
    })
    const savedProperties = saved.tasks[0]?.expectedOutput.schema?.properties
    expect(typeof savedProperties).toBe('object')
    expect(Object.hasOwn(savedProperties as object, '__proto__')).toBe(true)
    expect(saved.tasks[0]?.expectedOutput.schema).toEqual(validSchema)

    const invalid = content()
    const invalidSchema = JSON.parse(
      '{"type":"object","__proto__":{"type":"string"}}',
    ) as Record<string, never>
    invalid.tasks[0] = {
      ...invalid.tasks[0]!,
      expectedOutput: { description: 'Structured result.', schema: invalidSchema },
    }
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-b',
      expectedRevision: 0,
      content: invalid,
    })).toThrow('unsupported output schema')
  })
})

describe('bounded plan JSON input', () => {
  it('accepts repeated plain-object references but rejects cycles and non-JSON values', () => {
    const shared = { value: 'reused' }
    expect(() => { assertBoundedJsonValue({ left: shared, right: shared }) }).not.toThrow()

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => { assertBoundedJsonValue(cyclic) }).toThrow('must not contain cycles')
    expect(() => { assertBoundedJsonValue({ date: new Date(0) }) }).toThrow('non-plain object')
    expect(() => { assertBoundedJsonValue({ value: Number.POSITIVE_INFINITY }) }).toThrow('non-finite')
    expect(() => { assertBoundedJsonValue({ value: () => 'not JSON' }) }).toThrow('non-JSON value')
  })

  it('rejects excessive nesting before recursive schema parsing', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 70; depth += 1) value = [value]
    expect(() => { assertBoundedJsonValue(value) }).toThrow('nested too deeply')
  })
})
