import { describe, expect, it, vi } from 'vitest'
import {
  AgentPlanRepository,
  PlanApprovalError,
  PlanOwnershipError,
  PlanRevisionConflictError,
} from '../src/plan-store.js'
import type { AgentPlanContent, PlanPreflightResult } from '../src/plan-types.js'

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
      acceptedWarningCodes: [],
    })).toThrow(PlanApprovalError)

    const approved = repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningCodes: ['plan.no-parallelism'],
    })
    expect(approved).toMatchObject({
      state: 'approved',
      capabilityDigest: 'capability-v1',
      acceptedWarningCodes: ['plan.no-parallelism'],
    })
    expect(() => repository.approve({
      parentSessionId: 'parent-a',
      planId: saved.planId,
      revision: saved.revision,
      preflight: result,
      acceptedWarningCodes: ['plan.no-parallelism'],
    })).toThrow(PlanApprovalError)
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
    unsafe.tasks[0] = { ...unsafe.tasks[0]!, resourceClaims: ['C:\\private\\fixture'] }
    expect(() => repository.saveDraft({
      parentSessionId: 'parent-a',
      expectedRevision: 0,
      content: unsafe,
    })).toThrow()
  })
})
